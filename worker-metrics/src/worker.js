// sedx-dashboard-metrics — Cloudflare Worker (daily Cron Trigger).
//
// Refreshes the slow-moving metrics the build Worker doesn't cover:
//   • installs    — from Play's bulk report bucket on GCS (stats/installs/*_overview.csv)
//   • revenue     — from Play's monthly sales reports on GCS (sales/salesreport_*.zip),
//                  summed per package over the trailing 30d. Captures one-time IAP,
//                  which RevenueCat's overview `revenue` metric omits. No subscriptions
//                  are sold, so RevenueCat is not queried.
//   • App Store   — current iOS version per app via the public iTunes lookup API
//                  (batched by numeric track id once known; merged into the table).
//
// It also derives a 30-day daily `series` (revenue, active installs, and the
// count of apps live on Play production / the App Store) for the dashboard's
// charts. Revenue + installs come straight from the per-day GCS data; the
// production counts have no historical source, so they're appended once per run
// into a rolling KV history ("dashboard-history") and fill the window over time.
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
// Secrets:  GOOGLE_SA_KEY (shared Play service account), TRIGGER_SECRET (optional).
//           Var: GCS_BUCKET.

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

// ---- App Store (iTunes lookup) ----------------------------------------------
// Public, unauthenticated. We resolve the current App Store version per app.
// Lookups by numeric track id are batchable (one subrequest for many apps), so
// once an app's trackId is known (cached in the prior metrics snapshot) every
// later run costs ~1 subrequest total. Apps whose trackId we don't yet know are
// discovered one-by-one (by bundle id), capped per run to protect the budget.
const ITUNES_COUNTRY = 'us';

function itunesRow(x) {
  return { bundleId: x.bundleId, iosVersion: x.version || null, iosTrackId: x.trackId || null, iosUrl: x.trackViewUrl || null };
}

// Batch current-version lookup by numeric track id -> { bundleId: row }.
async function itunesByIds(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const url = `https://itunes.apple.com/lookup?id=${chunk.join(',')}&country=${ITUNES_COUNTRY}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'sedx-dashboard' } });
    if (!r.ok) continue;
    for (const x of (await r.json()).results || []) if (x.bundleId) out[x.bundleId] = itunesRow(x);
  }
  return out;
}

// Discover one app by bundle id (also yields its trackId for future batching).
async function itunesByBundle(bundleId) {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=${ITUNES_COUNTRY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'sedx-dashboard' } });
  if (!r.ok) return null;
  const x = ((await r.json()).results || [])[0];
  return x ? itunesRow(x) : null;
}

// ---- GCS helpers ------------------------------------------------------------
const gcsBase = bucket => `https://storage.googleapis.com/storage/v1/b/${bucket}/o`;

// List every installs *_overview.csv and map package -> its monthly files,
// sorted oldest→newest. We read the latest (current active count + this month's
// daily series) and, budget permitting, the previous month to span a full 30d.
async function installFilesByPkg(bucket, token) {
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
      (map[pkg] ||= []).push({ ym, name: o.name });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  for (const pkg of Object.keys(map)) map[pkg].sort((a, b) => a.ym.localeCompare(b.ym));
  return map;
}

// Read an installs overview CSV (UTF-16LE) -> the latest active/total snapshot
// plus the per-day Active Device Installs series ({ 'YYYY-MM-DD': active }).
async function readInstallsDaily(bucket, token, objectName) {
  const url = `${gcsBase(bucket)}/${encodeURIComponent(objectName)}?alt=media`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`get ${r.status}`);
  const buf = await r.arrayBuffer();
  const b = new Uint8Array(buf);
  const utf16 = b[0] === 0xff && b[1] === 0xfe;
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(buf).replace(/^﻿/, '');
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { activeInstalls: null, totalInstalls: null, byDay: {} };
  const header = lines[0].split(',');
  const iDate = header.indexOf('Date');
  const iActive = header.indexOf('Active Device Installs');
  const iTotal = header.indexOf('Total User Installs');
  const num = v => (v == null || v === '' || isNaN(+v) ? null : +v);
  const byDay = {};
  if (iDate >= 0 && iActive >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const a = num(c[iActive]);
      if (c[iDate] && a != null) byDay[c[iDate]] = a;
    }
  }
  const last = lines[lines.length - 1].split(',');
  return {
    activeInstalls: iActive >= 0 ? num(last[iActive]) : null,
    totalInstalls: iTotal >= 0 ? num(last[iTotal]) : null,
    byDay,
  };
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
  const byDay = {}; // 'YYYY-MM-DD' -> total USD revenue that day (across all apps)
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
      if (ix.date >= 0 && row[ix.date]) byDay[row[ix.date]] = (byDay[row[ix.date]] || 0) + sign * amt;
    }
  }
  for (const k of Object.keys(byPkg)) byPkg[k] = Math.round(byPkg[k] * 100) / 100;
  for (const k of Object.keys(byDay)) byDay[k] = Math.round(byDay[k] * 100) / 100;
  return { byPkg, byDay, windowDays: days, sources: files, nonUSDskipped };
}

// ---- 30-day window + rolling-history helpers --------------------------------
const WINDOW_DAYS = 30;
const HIST_KEEP = 40; // retain a little extra so the 30d window is always full
const SUBREQ_BUDGET = 46; // stay under the free-plan 50-subrequest/invocation cap

// Ascending list of the last n calendar days (UTC) ending today, as YYYY-MM-DD.
function lastNDays(n, todayIso) {
  const out = [];
  const base = new Date(`${todayIso}T00:00:00Z`).getTime();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

// Carry-fill a slowly-changing count series: forward-fill gaps from the last
// known value, back-fill any leading gaps from the first known, nulls -> 0.
// (Production membership has no historical source, so until 30 days of daily
// snapshots accumulate we project the known points across the window.)
function carryFill(arr) {
  const out = arr.slice();
  let last = null;
  for (let i = 0; i < out.length; i++) { if (out[i] == null) out[i] = last; else last = out[i]; }
  const first = out.find(v => v != null);
  for (let i = 0; i < out.length && out[i] == null; i++) out[i] = first ?? null;
  return out.map(v => (v == null ? 0 : v));
}

// ---- collect + write --------------------------------------------------------
async function refresh(env) {
  if (!env.SCRATCHPAD) throw new Error('SCRATCHPAD KV binding missing');
  if (!env.GOOGLE_SA_KEY) throw new Error('GOOGLE_SA_KEY secret missing');
  if (!env.GCS_BUCKET) throw new Error('GCS_BUCKET var missing');

  const cfg = (await env.SCRATCHPAD.get('dashboard-config', 'json')) || { apps: [] };
  const apps = (cfg.apps || []).filter(a => a.androidPackage);
  if (!apps.length) throw new Error('dashboard-config has no apps');

  const today = new Date().toISOString().slice(0, 10);
  const window = new Set(lastNDays(WINDOW_DAYS, today));
  let subreq = 0; // counted HTTP subrequests, to stay under the free-plan cap

  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const token = await getGoogleToken(sa, STORAGE_SCOPE);
  subreq++; // token

  // ---- App Store versions (iTunes) -----------------------------------------
  // Reuse trackIds learned on prior runs so the common case is one batched call.
  const prev = (await env.SCRATCHPAD.get('dashboard-metrics', 'json')) || { apps: [] };
  const prevById = Object.fromEntries((prev.apps || []).map(a => [a.androidPackage, a]));
  const iosByPkg = {}; // androidPackage -> { iosVersion, iosTrackId, iosUrl }

  const withBundle = apps.filter(a => a.iosBundleId);
  const known = withBundle.filter(a => prevById[a.androidPackage]?.iosTrackId);
  const unknown = withBundle.filter(a => !prevById[a.androidPackage]?.iosTrackId);
  try {
    if (known.length) {
      const byBundle = await itunesByIds(known.map(a => prevById[a.androidPackage].iosTrackId));
      subreq++;
      for (const a of known) { const r = byBundle[a.iosBundleId]; if (r) iosByPkg[a.androidPackage] = r; }
    }
    // Discover apps with no cached trackId one-by-one, capped to protect budget.
    for (const a of unknown) {
      if (subreq >= SUBREQ_BUDGET - 6) break; // reserve room for installs/sales
      const r = await itunesByBundle(a.iosBundleId);
      subreq++;
      if (r) iosByPkg[a.androidPackage] = r;
    }
  } catch { /* leave iOS empty on lookup failure */ }

  // ---- installs (GCS) — latest month's active count + daily series ----------
  const fileMap = await installFilesByPkg(env.GCS_BUCKET, token);
  subreq++; // installs list
  const installsByDay = {}; // 'YYYY-MM-DD' -> total active installs across apps

  const rows = await pool(apps, CONCURRENCY, async app => {
    const ios = iosByPkg[app.androidPackage] || {};
    const row = {
      androidPackage: app.androidPackage, displayName: app.displayName,
      activeInstalls: null, totalInstalls: null, revenue: null,
      iosVersion: ios.iosVersion || null, iosTrackId: ios.iosTrackId || null, iosUrl: ios.iosUrl || null,
      error: null,
    };
    const files = fileMap[app.androidPackage] || [];
    const latest = files[files.length - 1];
    if (latest) {
      try {
        const cur = await readInstallsDaily(env.GCS_BUCKET, token, latest.name);
        subreq++;
        row.activeInstalls = cur.activeInstalls;
        row.totalInstalls = cur.totalInstalls;
        for (const [d, v] of Object.entries(cur.byDay)) if (window.has(d)) installsByDay[d] = (installsByDay[d] || 0) + v;
      } catch (e) {
        row.error = `installs: ${e.message}`;
      }
    }
    return row;
  });

  // Budget permitting, pull each app's previous month too so the daily installs
  // series spans a full 30 days from the first run (otherwise it fills in over
  // a few days as the rolling history accumulates).
  for (const app of apps) {
    if (subreq >= SUBREQ_BUDGET) break;
    const files = fileMap[app.androidPackage] || [];
    if (files.length < 2) continue;
    try {
      const prevMonth = await readInstallsDaily(env.GCS_BUCKET, token, files[files.length - 2].name);
      subreq++;
      for (const [d, v] of Object.entries(prevMonth.byDay)) if (window.has(d)) installsByDay[d] = (installsByDay[d] || 0) + v;
    } catch { /* skip */ }
  }

  // ---- revenue from Play sales reports (incl. one-time IAP) ------------------
  // We sell no subscriptions, so RevenueCat is not queried — Play's sales report
  // is the authoritative per-package record of actual purchases.
  let sales = null;
  try {
    sales = await playSalesRevenue(env.GCS_BUCKET, token, WINDOW_DAYS);
    subreq += 1 + Math.min(2, (sales.sources || []).length); // sales list + report fetches
    for (const r of rows) {
      const v = sales.byPkg[r.androidPackage];
      if (v != null) r.revenue = v;
    }
  } catch (e) {
    sales = { error: String(e.message || e) };
  }

  const byPkg = Object.fromEntries(rows.map(r => [r.androidPackage, r]));
  const sum = key => Object.values(byPkg).reduce((s, r) => s + (r[key] || 0), 0);
  const onAppStore = rows.filter(r => r.iosVersion).length;

  // ---- production counts today (no historical source -> appended daily) -----
  const build = (await env.SCRATCHPAD.get('dashboard', 'json')) || { apps: [] };
  const prodAndroid = (build.apps || []).filter(a => a.tracks && a.tracks.production).length;
  const prodIos = onAppStore;

  // ---- merge into rolling history, then derive the 30-day series ------------
  const hist = (await env.SCRATCHPAD.get('dashboard-history', 'json')) || { days: {} };
  if (!hist.days) hist.days = {};
  const revByDay = (sales && sales.byDay) || {};
  for (const [d, v] of Object.entries(revByDay)) if (window.has(d)) (hist.days[d] ||= {}).revenue = v;
  for (const [d, v] of Object.entries(installsByDay)) (hist.days[d] ||= {}).activeInstalls = v;
  (hist.days[today] ||= {}).prodAndroid = prodAndroid;
  hist.days[today].prodIos = prodIos;
  const keep = new Set(lastNDays(HIST_KEEP, today));
  for (const k of Object.keys(hist.days)) if (!keep.has(k)) delete hist.days[k];
  await env.SCRATCHPAD.put('dashboard-history', JSON.stringify(hist));

  const days = lastNDays(WINDOW_DAYS, today);
  const series = {
    days,
    revenue: days.map(d => hist.days[d]?.revenue ?? 0),
    activeInstalls: days.map(d => hist.days[d]?.activeInstalls ?? null),
    prodAndroid: carryFill(days.map(d => hist.days[d]?.prodAndroid ?? null)),
    prodIos: carryFill(days.map(d => hist.days[d]?.prodIos ?? null)),
  };

  await env.SCRATCHPAD.put(
    'dashboard-metrics',
    JSON.stringify({
      metricsAt: new Date().toISOString(),
      apps: Object.values(byPkg),
      sales,
      series,
      summary: {
        totalActiveInstalls: sum('activeInstalls'),
        totalRevenue30d: Math.round(sum('revenue') * 100) / 100,
        revenueWindowDays: WINDOW_DAYS,
        revenueSource: 'play-sales',
        onAppStore,
      },
    }),
  );

  return {
    apps: rows.length,
    subrequests: subreq,
    onAppStore,
    totalActiveInstalls: sum('activeInstalls'),
    totalRevenue30d: Math.round(sum('revenue') * 100) / 100,
    sales: sales ? (sales.error || `${Object.keys(sales.byPkg || {}).length} pkg(s) from ${(sales.sources || []).length} report(s)`) : 'n/a',
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
