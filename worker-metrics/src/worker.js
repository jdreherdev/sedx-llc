// sedx-dashboard-metrics — Cloudflare Worker (daily Cron Trigger).
//
// Refreshes the slow-moving metrics the build Worker doesn't cover:
//   • installs — from Play's bulk report bucket on GCS (stats/installs/*_overview.csv)
//   • revenue  — RevenueCat v2 overview metrics (only if REVENUECAT_V2_KEY is set)
//
// (Ratings were removed: the public Play listing only exposes per-app star labels
//  for the "similar apps" carousel, not reliably the subject app, so scraping it
//  surfaced other apps' ratings. No trustworthy aggregate-rating source exists yet.)
//
// Writes KV key "dashboard-metrics"; the gated /scratchpad/dashboard-data Pages
// Function merges it into each app by package name. Separate from the 6h build
// Worker so each stays under the free-plan 50-subrequest cap, and because these
// numbers change at most daily.
//
// Secrets:  GOOGLE_SA_KEY (shared Play service account), TRIGGER_SECRET (optional),
//           REVENUECAT_V2_KEY (optional). Var: GCS_BUCKET.

const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';
const CONCURRENCY = 5;

// ---- base64url + PEM helpers (WebCrypto) -----------------------------------
const b64urlStr = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = bytes => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return b64urlStr(bin);
};
const pemToDer = pem => {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(b64);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der.buffer;
};

async function getGoogleToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(
    JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
  );
  const input = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(input));
  const assertion = `${input}.${b64urlBytes(new Uint8Array(sig))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(assertion),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

// ---- bounded-concurrency map -----------------------------------------------
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

// ---- GCS helpers ------------------------------------------------------------
const gcsBase = bucket => `https://storage.googleapis.com/storage/v1/b/${bucket}/o`;

// List every installs *_overview.csv and map package -> latest month's object path.
async function latestInstallFiles(bucket, token) {
  const map = {};
  let pageToken = '';
  do {
    const url = `${gcsBase(bucket)}?prefix=${encodeURIComponent('stats/installs/')}&maxResults=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    for (const o of j.items || []) {
      // installs_<package>_<YYYYMM>_overview.csv
      const m = o.name.match(/installs_(.+)_(\d{6})_overview\.csv$/);
      if (!m) continue;
      const [, pkg, ym] = m;
      if (!map[pkg] || ym > map[pkg].ym) map[pkg] = { ym, name: o.name };
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return map;
}

// Read an installs overview CSV (UTF-16LE) -> { activeInstalls, totalInstalls }.
async function readInstalls(bucket, token, objectName) {
  const url = `${gcsBase(bucket)}/${encodeURIComponent(objectName)}?alt=media`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`get ${r.status}`);
  const buf = await r.arrayBuffer();
  const b = new Uint8Array(buf);
  const utf16 = b[0] === 0xff && b[1] === 0xfe;
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(buf).replace(/^﻿/, '');
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { activeInstalls: null, totalInstalls: null };
  const header = lines[0].split(',');
  const iActive = header.indexOf('Active Device Installs');
  const iTotal = header.indexOf('Total User Installs');
  const last = lines[lines.length - 1].split(',');
  const num = v => (v == null || v === '' || isNaN(+v) ? null : +v);
  return { activeInstalls: iActive >= 0 ? num(last[iActive]) : null, totalInstalls: iTotal >= 0 ? num(last[iTotal]) : null };
}

// ---- RevenueCat v2 overview (optional) -------------------------------------
// REVENUECAT_V2_KEY may hold several v2 keys (comma/space/newline separated) —
// v2 keys are project-scoped, so one key per project is needed for full coverage.
// We list each key's projects and aggregate, deduping by project id.
async function revenueCatOverview(secret) {
  const keys = secret.split(/[\s,]+/).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const auth = { Authorization: `Bearer ${key}` };
    const pr = await fetch('https://api.revenuecat.com/v2/projects', { headers: auth });
    if (!pr.ok) {
      out.push({ id: null, name: null, metrics: null, error: `projects ${pr.status}: ${(await pr.text()).slice(0, 120)}` });
      continue;
    }
    for (const p of (await pr.json()).items || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const m = await fetch(`https://api.revenuecat.com/v2/projects/${p.id}/metrics/overview`, { headers: auth });
      out.push({ id: p.id, name: p.name, metrics: m.ok ? (await m.json()).metrics || [] : null, error: m.ok ? null : `overview ${m.status}` });
    }
  }
  return { projects: out };
}

// ---- Play sales reports (one-time + subscription purchase revenue) ----------
// RevenueCat's overview `revenue` metric is subscription-oriented and reports 0
// for one-time (non-subscription) purchases, so we read Google Play's monthly
// sales reports from the same GCS bucket instead. These are the authoritative
// per-transaction record of actual purchases (incl. one-time IAP), keyed by
// package — no name aliasing needed.
//   sales/salesreport_<YYYYMM>.zip  ->  salesreport_<YYYYMM>.csv

const zipU16 = (b, o) => b[o] | (b[o + 1] << 8);
const zipU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Extract the first entry of a (small, single-file) ZIP as UTF-8 text. Reads the
// central directory so the compressed size is reliable even with data descriptors.
async function unzipFirstText(buf) {
  const b = new Uint8Array(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: no EOCD');
  const cd = zipU32(b, eocd + 16);
  if (!(b[cd] === 0x50 && b[cd + 1] === 0x4b && b[cd + 2] === 0x01 && b[cd + 3] === 0x02)) throw new Error('zip: no central dir');
  const method = zipU16(b, cd + 10);
  const compSize = zipU32(b, cd + 20);
  const localOff = zipU32(b, cd + 42);
  const start = localOff + 30 + zipU16(b, localOff + 26) + zipU16(b, localOff + 28);
  const comp = b.subarray(start, start + compSize);
  const out = method === 0 ? comp : await inflateRaw(comp);
  return new TextDecoder('utf-8').decode(out).replace(/^﻿/, '');
}

// Minimal RFC-4180 CSV parse (handles quoted fields containing commas/quotes).
function parseCSV(text) {
  const rows = []; let row = [], field = '', inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; }
      else field += c;
    } else if (c === '"') inq = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Sum Play purchase revenue (USD item price, net of refunds) per package over the
// trailing `days` window. Reads the latest 1-2 monthly reports to span any edge.
async function playSalesRevenue(bucket, token, days) {
  const list = await fetch(`${gcsBase(bucket)}?prefix=${encodeURIComponent('sales/')}&maxResults=1000`, { headers: { Authorization: `Bearer ${token}` } });
  if (!list.ok) throw new Error(`sales list ${list.status}`);
  const files = ((await list.json()).items || [])
    .map(o => o.name).filter(n => /salesreport_\d{6}\.zip$/.test(n)).sort().slice(-2);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); // YYYY-MM-DD
  const byPkg = {};
  let nonUSDskipped = 0;
  for (const name of files) {
    const r = await fetch(`${gcsBase(bucket)}/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) continue;
    const rows = parseCSV(await unzipFirstText(await r.arrayBuffer()));
    if (rows.length < 2) continue;
    const h = rows[0];
    const ix = {
      date: h.indexOf('Order Charged Date'),
      status: h.indexOf('Financial Status'),
      price: h.indexOf('Item Price'),
      cur: h.indexOf('Currency of Sale'),
      pkg: h.indexOf('Package ID'),
    };
    if (ix.pkg < 0 || ix.price < 0) continue;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length <= ix.pkg) continue;
      if (ix.date >= 0 && row[ix.date] < cutoff) continue;
      if (ix.cur >= 0 && row[ix.cur] && row[ix.cur] !== 'USD') { nonUSDskipped++; continue; }
      const amt = parseFloat(row[ix.price]);
      if (!isFinite(amt)) continue;
      const status = (ix.status >= 0 ? row[ix.status] : '').toLowerCase();
      const sign = /refund|charge.?back/.test(status) ? -1 : 1;
      byPkg[row[ix.pkg]] = (byPkg[row[ix.pkg]] || 0) + sign * amt;
    }
  }
  for (const k of Object.keys(byPkg)) byPkg[k] = Math.round(byPkg[k] * 100) / 100;
  return { byPkg, windowDays: days, sources: files, nonUSDskipped };
}

// ---- collect + write --------------------------------------------------------
async function refresh(env) {
  if (!env.SCRATCHPAD) throw new Error('SCRATCHPAD KV binding missing');
  if (!env.GOOGLE_SA_KEY) throw new Error('GOOGLE_SA_KEY secret missing');
  if (!env.GCS_BUCKET) throw new Error('GCS_BUCKET var missing');

  const cfg = (await env.SCRATCHPAD.get('dashboard-config', 'json')) || { apps: [] };
  const apps = (cfg.apps || []).filter(a => a.androidPackage);
  if (!apps.length) throw new Error('dashboard-config has no apps');

  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const token = await getGoogleToken(sa, STORAGE_SCOPE);

  // Phase 1: installs (GCS) — list once, then one fetch per app.
  const fileMap = await latestInstallFiles(env.GCS_BUCKET, token);
  const rows = await pool(apps, CONCURRENCY, async app => {
    const row = { androidPackage: app.androidPackage, displayName: app.displayName, activeInstalls: null, totalInstalls: null, mrr: null, revenue: null, subs: null, error: null };
    const f = fileMap[app.androidPackage];
    if (f) {
      try {
        Object.assign(row, await readInstalls(env.GCS_BUCKET, token, f.name));
      } catch (e) {
        row.error = `installs: ${e.message}`;
      }
    }
    return row;
  });

  // Phase 2: revenue (RevenueCat) — optional.
  let revenue = null;
  if (env.REVENUECAT_V2_KEY) {
    try {
      revenue = await revenueCatOverview(env.REVENUECAT_V2_KEY);
    } catch (e) {
      revenue = { error: String(e.message || e) };
    }
  }

  // Attach per-app revenue by matching RC project name -> app display name
  // (one RC project per app). Overall totals are summed on the page separately.
  if (revenue && Array.isArray(revenue.projects)) {
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // RevenueCat project names don't always equal the app's display name.
    // Map normalized RC project name -> normalized app displayName for those.
    const RC_ALIASES = {
      armysurvivalhandbook: 'armysurvivalmanual', // RC "Army Survival Handbook" -> app "Army Survival Manual"
      mutcd: 'mutcd11thedition',                  // RC "MUTCD" -> app "MUTCD 11th Edition"
    };
    const revByName = {};
    for (const p of revenue.projects) {
      if (!p.metrics) continue;
      const get = id => {
        const m = p.metrics.find(x => x.id === id);
        return m && typeof m.value === 'number' ? m.value : null;
      };
      const key = RC_ALIASES[norm(p.name)] || norm(p.name);
      revByName[key] = { mrr: get('mrr'), revenue: get('revenue'), subs: get('active_subscriptions') };
    }
    for (const r of rows) {
      const hit = revByName[norm(r.displayName)];
      if (hit) Object.assign(r, hit);
    }
  }

  // Phase 3: authoritative purchase revenue from Play sales reports (incl.
  // one-time IAP, which RevenueCat's overview metric omits). Keyed by package,
  // so it overrides the RC `revenue` value (always 0 for non-subscription apps).
  let sales = null;
  try {
    sales = await playSalesRevenue(env.GCS_BUCKET, token, 28);
    for (const r of rows) {
      const v = sales.byPkg[r.androidPackage];
      if (v != null) r.revenue = v;
    }
  } catch (e) {
    sales = { error: String(e.message || e) };
  }

  const byPkg = Object.fromEntries(rows.map(r => [r.androidPackage, r]));
  const sum = key => Object.values(byPkg).reduce((s, r) => s + (r[key] || 0), 0);
  await env.SCRATCHPAD.put(
    'dashboard-metrics',
    JSON.stringify({
      metricsAt: new Date().toISOString(),
      apps: Object.values(byPkg),
      revenue,
      sales,
      summary: {
        totalActiveInstalls: sum('activeInstalls'),
        totalRevenue28d: Math.round(sum('revenue') * 100) / 100,
        revenueWindowDays: 28,
        revenueSource: 'play-sales',
      },
    }),
  );

  return {
    apps: rows.length,
    totalActiveInstalls: sum('activeInstalls'),
    totalRevenue28d: Math.round(sum('revenue') * 100) / 100,
    sales: sales ? (sales.error || `${Object.keys(sales.byPkg || {}).length} pkg(s) from ${(sales.sources || []).length} report(s)`) : 'n/a',
    revenue: revenue ? (revenue.error || `${(revenue.projects || []).length} project(s)`) : 'no key',
  };
}

export default {
  async scheduled(event, env, ctx) {
    await refresh(env);
  },
  async fetch(request, env) {
    if (!env.TRIGGER_SECRET) return new Response('Not found', { status: 404 });
    if (request.headers.get('X-Trigger') !== env.TRIGGER_SECRET) return new Response('Forbidden', { status: 403 });
    try {
      return Response.json({ ok: true, ...(await refresh(env)) });
    } catch (err) {
      return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
    }
  },
};
