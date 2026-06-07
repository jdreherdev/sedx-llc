// sedx-dashboard-metrics — Cloudflare Worker (daily Cron Trigger).
//
// Refreshes the slow-moving metrics the build Worker doesn't cover:
//   • installs — from Play's bulk report bucket on GCS (stats/installs/*_overview.csv)
//   • ratings  — parsed from the public Play listing (only present once an app has
//                enough ratings to display a star; "—" otherwise)
//   • revenue  — RevenueCat v2 overview metrics (only if REVENUECAT_V2_KEY is set)
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

// ---- public Play listing -> aggregate star rating --------------------------
async function scrapeRating(pkg) {
  const r = await fetch(`https://play.google.com/store/apps/details?id=${pkg}&hl=en&gl=US`, {
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!r.ok) return { rating: null, ratingCount: null };
  const html = await r.text();
  const rm = html.match(/Rated ([0-9.]+) stars? out of/);
  const cm = html.match(/([0-9][0-9,]*)\s+reviews/i);
  return {
    rating: rm ? parseFloat(rm[1]) : null,
    ratingCount: cm ? parseInt(cm[1].replace(/,/g, ''), 10) : null,
  };
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
    const row = { androidPackage: app.androidPackage, displayName: app.displayName, activeInstalls: null, totalInstalls: null, rating: null, ratingCount: null, mrr: null, revenue: null, subs: null, error: null };
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
    const revByName = {};
    for (const p of revenue.projects) {
      if (!p.metrics) continue;
      const get = id => {
        const m = p.metrics.find(x => x.id === id);
        return m && typeof m.value === 'number' ? m.value : null;
      };
      revByName[norm(p.name)] = { mrr: get('mrr'), revenue: get('revenue'), subs: get('active_subscriptions') };
    }
    for (const r of rows) {
      const hit = revByName[norm(r.displayName)];
      if (hit) Object.assign(r, hit);
    }
  }

  // Write installs+revenue first so a heavy ratings pass can't lose them.
  const byPkg = Object.fromEntries(rows.map(r => [r.androidPackage, r]));
  const writeSnapshot = async () =>
    env.SCRATCHPAD.put(
      'dashboard-metrics',
      JSON.stringify({
        metricsAt: new Date().toISOString(),
        apps: Object.values(byPkg),
        revenue,
        summary: {
          totalActiveInstalls: Object.values(byPkg).reduce((s, r) => s + (r.activeInstalls || 0), 0),
          rated: Object.values(byPkg).filter(r => r.rating != null).length,
        },
      }),
    );
  await writeSnapshot();

  // Phase 3: ratings (public store page) — best-effort, then re-write.
  await pool(apps, CONCURRENCY, async app => {
    try {
      const { rating, ratingCount } = await scrapeRating(app.androidPackage);
      byPkg[app.androidPackage].rating = rating;
      byPkg[app.androidPackage].ratingCount = ratingCount;
    } catch {
      /* leave rating null */
    }
  });
  await writeSnapshot();

  return {
    apps: rows.length,
    totalActiveInstalls: Object.values(byPkg).reduce((s, r) => s + (r.activeInstalls || 0), 0),
    rated: Object.values(byPkg).filter(r => r.rating != null).length,
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
