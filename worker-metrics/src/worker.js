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
// Ratings: iOS only. The public iTunes lookup already fetched here returns the
//  App Store's `averageUserRating` (all versions) — authoritative and free, so we
//  carry it through per app. Android has no trustworthy aggregate-rating source:
//  the GCS bulk reports have no stats/ratings/, the Play page embeds no rating
//  aggregate for low-volume apps, and the visible aria-labels are polluted by the
//  "similar apps" carousel (they surfaced other apps' ratings). So the Android
//  rating stays absent until a real source exists; don't re-add the store scrape.
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
  // App Store star rating (all versions). A brand-new app with no ratings reports
  // averageUserRating 0 / userRatingCount 0 — treat that as "no rating yet" (null)
  // so the dashboard shows a dash rather than a misleading "0.0".
  const count = typeof x.userRatingCount === 'number' ? x.userRatingCount : 0;
  return {
    bundleId: x.bundleId, iosVersion: x.version || null, iosTrackId: x.trackId || null, iosUrl: x.trackViewUrl || null,
    iosRating: count > 0 && typeof x.averageUserRating === 'number' ? Math.round(x.averageUserRating * 10) / 10 : null,
    iosRatingCount: count || null,
  };
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

// ---- App Store Connect Sales reports (iOS units + proceeds) -----------------
// Daily SALES/SUMMARY report per vendor — ONE gzipped TSV holding every app's
// rows for that day, mapped to our apps by "Apple Identifier" (== iosTrackId).
//   • Units            = downloads (incl. free + redownloads) → our "downloads"
//   • Developer Proceeds = proceeds PER UNIT; revenue = Units × that, USD rows
//     only (matches the Android side's USD-only sum)
// Apple emits a report only on days with activity (404 otherwise). Auth is an
// ES256 JWT (P-256) — distinct from Google's RS256. Secrets: ASC_SALES_KEY (.p8),
// ASC_KEY_ID, ASC_ISSUER_ID; var ASC_VENDOR. All optional — iOS is simply absent
// until they're set.
async function ascToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
  const input = `${header}.${claim}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(env.ASC_SALES_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`; // WebCrypto ECDSA sig is IEEE-P1363 r||s, exactly JWT ES256
}

// One day's SALES/SUMMARY rows: [{ appleId, units, proceedsUSD }]. [] if no report.
async function ascSalesDay(token, vendor, day) {
  const u = `https://api.appstoreconnect.apple.com/v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=${vendor}&filter[reportDate]=${day}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/a-gzip' } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`asc ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const tsv = new TextDecoder('utf-8').decode(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return parseAscSales(tsv);
}

// Parse a SALES/SUMMARY TSV → per-row units + USD proceeds, keyed by Apple id.
function parseAscSales(tsv) {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return [];
  const h = lines[0].split('\t');
  const ix = { units: h.indexOf('Units'), proceeds: h.indexOf('Developer Proceeds'), id: h.indexOf('Apple Identifier'), parent: h.indexOf('Parent Identifier'), cur: h.indexOf('Currency of Proceeds') };
  if (ix.id < 0 || ix.units < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    if (c.length <= ix.id) continue;
    const units = parseInt(c[ix.units], 10) || 0;
    const per = ix.proceeds >= 0 ? parseFloat(c[ix.proceeds]) || 0 : 0;
    const usd = ix.cur < 0 || c[ix.cur] === 'USD';
    // IAP/subscription rows carry the product's own Apple id and name the parent
    // app via "Parent Identifier" (the app's SKU). App-level rows leave it blank.
    const parentId = ix.parent >= 0 ? (c[ix.parent] || '').trim() : '';
    out.push({ appleId: c[ix.id], parentId, units, proceedsUSD: usd ? Math.round(per * units * 100) / 100 : 0 });
  }
  return out;
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
  // "Total User Installs" is a dead column (always 0) in these exports — lifetime
  // downloads are accumulated from the daily new-install flow instead.
  const iDaily = header.indexOf('Daily User Installs');
  const num = v => (v == null || v === '' || isNaN(+v) ? null : +v);
  const byDay = {};   // date -> Active Device Installs (a level)
  const dlByDay = {}; // date -> Daily User Installs (new installs, a flow)
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (!(iDate >= 0 && c[iDate])) continue;
    if (iActive >= 0) { const a = num(c[iActive]); if (a != null) byDay[c[iDate]] = a; }
    if (iDaily >= 0) { const d = num(c[iDaily]); if (d != null) dlByDay[c[iDate]] = d; }
  }
  const last = lines[lines.length - 1].split(',');
  return {
    activeInstalls: iActive >= 0 ? num(last[iActive]) : null,
    byDay,
    dlByDay,
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

  // ---- Android installs (GCS) — active count + daily new-install flow -------
  // Over a 30d window the retained Play reports (current + previous month) cover
  // the whole series, so Android revenue + downloads are recomputed fresh each
  // run; only the production counts (no source) need the rolling history.
  const fileMap = await installFilesByPkg(env.GCS_BUCKET, token);
  subreq++; // installs list
  const dlAndroidByDay = {}; // date -> Android new installs (Daily User Installs) across apps

  const rows = await pool(apps, CONCURRENCY, async app => {
    const ios = iosByPkg[app.androidPackage] || {};
    const row = {
      androidPackage: app.androidPackage, displayName: app.displayName,
      activeInstalls: null,                            // Android current installed base (level)
      revenue: null, revenueIos: null,                // 30d proceeds, per platform
      downloadsAndroid: null, downloadsIos: null,     // lifetime downloads, per platform
      // trackId is an immutable identifier doubling as next run's lookup cache —
      // fall back to the prior snapshot's value so one failed iTunes run doesn't
      // wipe the cache (and with it, ASC sales attribution) for every later run.
      iosVersion: ios.iosVersion || null, iosTrackId: ios.iosTrackId || prevById[app.androidPackage]?.iosTrackId || null, iosUrl: ios.iosUrl || null,
      iosRating: ios.iosRating ?? null, iosRatingCount: ios.iosRatingCount ?? null, // App Store stars
      error: null, _dl: {},                           // _dl: per-day new installs (for lifetime accrual)
    };
    const files = fileMap[app.androidPackage] || [];
    const latest = files[files.length - 1];
    if (latest) {
      try {
        const cur = await readInstallsDaily(env.GCS_BUCKET, token, latest.name);
        subreq++;
        row.activeInstalls = cur.activeInstalls;
        Object.assign(row._dl, cur.dlByDay);
        for (const [d, v] of Object.entries(cur.dlByDay)) if (window.has(d)) dlAndroidByDay[d] = (dlAndroidByDay[d] || 0) + v;
      } catch (e) {
        row.error = `installs: ${e.message}`;
      }
    }
    return row;
  });
  const rowByPkg = Object.fromEntries(rows.map(r => [r.androidPackage, r]));

  // Previous month too (budget permitting) — widens the 30d flow window and
  // closes the month-boundary gap for lifetime accrual. Reserve room for ASC.
  for (const app of apps) {
    if (subreq >= SUBREQ_BUDGET - 8) break;
    const files = fileMap[app.androidPackage] || [];
    if (files.length < 2) continue;
    try {
      const pm = await readInstallsDaily(env.GCS_BUCKET, token, files[files.length - 2].name);
      subreq++;
      const r = rowByPkg[app.androidPackage];
      for (const [d, v] of Object.entries(pm.dlByDay)) {
        if (r) r._dl[d] = v;
        if (window.has(d)) dlAndroidByDay[d] = (dlAndroidByDay[d] || 0) + v;
      }
    } catch { /* skip */ }
  }

  // ---- Android revenue (Play sales reports, 30d) ----------------------------
  let sales = null;
  try {
    sales = await playSalesRevenue(env.GCS_BUCKET, token, WINDOW_DAYS);
    subreq += 1 + Math.min(2, (sales.sources || []).length);
    for (const r of rows) { const v = sales.byPkg[r.androidPackage]; if (v != null) r.revenue = v; }
  } catch (e) { sales = { error: String(e.message || e) }; }
  const revAndroidByDay = (sales && sales.byDay) || {};

  // ---- persistent download lifetimes ----------------------------------------
  // android: accrue Daily User Installs past each app's last-counted date (seeded
  // offline with the full history). ios: store every day's units/proceeds per
  // Apple id (tiny — iOS just launched), so lifetime = sum and restatements just
  // overwrite. iOS revenue/downloads series are derived from here.
  const life = (await env.SCRATCHPAD.get('dashboard-lifetime', 'json')) || {};
  life.android ||= {}; life.ios ||= {};
  for (const r of rows) {
    const a = (life.android[r.androidPackage] ||= { total: 0, lastDate: '0000-00-00' });
    let maxD = a.lastDate;
    for (const [d, v] of Object.entries(r._dl)) { if (d > a.lastDate) a.total += v; if (d > maxD) maxD = d; }
    a.lastDate = maxD;
    r.downloadsAndroid = a.total;
    delete r._dl;
  }

  // ---- iOS sales (App Store Connect), trailing days -------------------------
  // Map ASC sales rows ("Apple Identifier") to apps. The iTunes trackId works
  // when the lookup succeeded this run, but iTunes flakes under rebuild load and
  // a failed lookup must not orphan sales data — so also map every appleId the
  // iOS-versions Worker resolved via ASC (authoritative, independent of iTunes).
  const iosVer = (await env.SCRATCHPAD.get('dashboard-ios-versions', 'json')) || {};
  const byAppleId = Object.fromEntries(rows.filter(r => r.iosTrackId).map(r => [String(r.iosTrackId), r]));
  for (const [pkg, t] of Object.entries(iosVer.apps || {})) {
    const r = rowByPkg[pkg];
    if (r && t && t.appleId && !byAppleId[String(t.appleId)]) byAppleId[String(t.appleId)] = r;
  }
  // The "Parent Identifier" on an IAP/subscription sales row is the parent app's
  // SKU (= its iOS bundleId across this suite). Map bundleId -> the app's numeric
  // Apple id so IAP proceeds attribute to the app, not the IAP product's own id
  // (which is not an app and matches no row -> revenue would silently vanish).
  const bundleByPkg = Object.fromEntries(apps.filter(a => a.iosBundleId).map(a => [a.androidPackage, a.iosBundleId]));
  const appleIdByBundle = {};
  for (const r of rows) {
    const b = bundleByPkg[r.androidPackage];
    if (!b) continue;
    const id = iosVer.apps?.[r.androidPackage]?.appleId || r.iosTrackId;
    if (id) appleIdByBundle[b] = String(id);
  }
  let iosReport = 'disabled';
  const iapProductIds = new Set(); // Apple ids seen as IAP/sub products, not apps
  if (env.ASC_SALES_KEY && env.ASC_KEY_ID && env.ASC_ISSUER_ID && env.ASC_VENDOR) {
    try {
      const tok = await ascToken(env);
      let got = 0;
      // Apple lags ~1-2 days and 404s days with no activity; the trailing few
      // days catch new data, which is merged idempotently (overwrite per date).
      for (const day of lastNDays(WINDOW_DAYS, today).slice(-6, -1).reverse()) {
        if (subreq >= SUBREQ_BUDGET) break;
        const dayRows = await ascSalesDay(tok, env.ASC_VENDOR, day);
        subreq++;
        if (!dayRows.length) continue;
        got++;
        // Aggregate the day per owning app before writing: an app can have many
        // rows (download tiers, multiple IAPs, refunds) and they must SUM, not
        // overwrite. IAP/sub rows (Parent Identifier set) belong to the parent
        // app; their units are purchases, not installs, so they don't count as
        // downloads — only app-level rows do.
        const dayUnits = {}, dayRev = {};
        for (const dr of dayRows) {
          const isIap = !!dr.parentId;
          if (isIap) iapProductIds.add(String(dr.appleId));
          const owner = isIap ? appleIdByBundle[dr.parentId] : String(dr.appleId);
          if (!owner) continue; // IAP whose parent app isn't in the roster — skip
          dayRev[owner] = (dayRev[owner] || 0) + dr.proceedsUSD;
          if (!isIap) dayUnits[owner] = (dayUnits[owner] || 0) + dr.units;
        }
        for (const [owner, v] of Object.entries(dayUnits)) (life.ios[owner] ||= { byDate: {}, revByDate: {} }).byDate[day] = v;
        for (const [owner, v] of Object.entries(dayRev)) (life.ios[owner] ||= { byDate: {}, revByDate: {} }).revByDate[day] = Math.round(v * 100) / 100;
      }
      iosReport = `${got} day(s) with data`;
    } catch (e) { iosReport = `error: ${String(e.message || e)}`; }
  }
  // Purge any IAP/subscription product ids that earlier (buggy) runs stored as if
  // they were apps — their proceeds now live under the parent app's id, so
  // leaving them would double-count in the cross-app daily series.
  for (const id of iapProductIds) delete life.ios[id];
  // iOS per-app totals + per-day series (across apps) from the lifetime store.
  const iosDlByDay = {}, iosRevByDay = {};
  for (const [appleId, slot] of Object.entries(life.ios)) {
    const r = byAppleId[appleId];
    const dlTotal = Object.values(slot.byDate || {}).reduce((s, v) => s + (v || 0), 0);
    if (r) {
      r.downloadsIos = dlTotal;
      r.revenueIos = Math.round(Object.entries(slot.revByDate || {}).reduce((s, [d, v]) => s + (window.has(d) ? v || 0 : 0), 0) * 100) / 100;
    }
    for (const [d, v] of Object.entries(slot.byDate || {})) if (window.has(d)) iosDlByDay[d] = (iosDlByDay[d] || 0) + v;
    for (const [d, v] of Object.entries(slot.revByDate || {})) if (window.has(d)) iosRevByDay[d] = Math.round(((iosRevByDay[d] || 0) + v) * 100) / 100;
  }
  await env.SCRATCHPAD.put('dashboard-lifetime', JSON.stringify(life));

  const sum = key => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const onAppStore = rows.filter(r => r.iosVersion).length;

  // ---- production counts today (no historical source -> appended daily) -----
  const build = (await env.SCRATCHPAD.get('dashboard', 'json')) || { apps: [] };
  // Android "in production" means approved & published — not merely "has a
  // production-track release". The Play track API reports rollout *intent*: a
  // brand-new app submitted to production shows status "completed" while it is
  // still sitting in initial review, so counting tracks.production alone
  // overstates and never moves when an approval actually lands. The only public
  // approval signal is the store listing itself — it 404s until the app is live.
  // Probe it once per app and remember the answer in KV ("dashboard-play-live"):
  // live apps stay live, so steady-state runs probe only apps awaiting review.
  const prodTrackPkgs = (build.apps || []).filter(a => {
    const p = a.tracks && a.tracks.production;
    return p && (p.status === 'completed' || p.status === 'inProgress');
  }).map(a => a.androidPackage);
  const playLive = (await env.SCRATCHPAD.get('dashboard-play-live', 'json')) || { apps: {} };
  let playLiveDirty = false;
  for (const pkg of prodTrackPkgs) {
    if (playLive.apps[pkg]) continue;
    if (subreq >= SUBREQ_BUDGET) break;
    subreq++;
    try {
      const r = await fetch(`https://play.google.com/store/apps/details?id=${pkg}`, {
        headers: { 'User-Agent': 'sedx-dashboard' }, redirect: 'manual',
      });
      // Only a clean 200 proves the listing is live; 404 = still in review (or
      // unpublished). Anything else (429, consent redirect, 5xx) is
      // indeterminate — leave the app uncached and let a later run decide.
      if (r.status === 200) { playLive.apps[pkg] = today; playLiveDirty = true; }
    } catch { /* indeterminate — retry next run */ }
  }
  if (playLiveDirty) await env.SCRATCHPAD.put('dashboard-play-live', JSON.stringify(playLive));
  const androidLivePkgs = prodTrackPkgs.filter(pkg => playLive.apps[pkg]);
  const prodAndroid = androidLivePkgs.length;
  // Per-app flag for the dashboard table: true/false for apps with a production
  // release (false = submitted but still in review), absent otherwise.
  const prodTrackSet = new Set(prodTrackPkgs);
  for (const r of rows) if (prodTrackSet.has(r.androidPackage)) r.playLive = !!playLive.apps[r.androidPackage];
  // iOS "in production" = apps the App Store reports as live. Prefer the
  // authoritative App Store Connect state (sedx-ios-versions Worker ->
  // dashboard-ios-versions KV), which flips to "live" the moment an app is
  // released; the iTunes lookup (onAppStore) lags hours behind a fresh release
  // and undercounts, so it's only a fallback when that KV is unavailable.
  // (iosVer was loaded above, before the ASC sales mapping.)
  // "Live" = any version READY_FOR_SALE (the `live` flag), NOT production.state:
  // production tracks the newest in-flight version, so the moment an update is
  // submitted its state flips to "waiting review" while the app is still on
  // sale. The state check remains as back-compat with pre-`live`-flag KV data.
  const isIosLive = t => t.live || (t.production && t.production.state === 'live');
  const iosLive = Object.values(iosVer.apps || {}).filter(isIosLive).length;
  const prodIos = iosLive || onAppStore;

  const hist = (await env.SCRATCHPAD.get('dashboard-history', 'json')) || { days: {} };
  if (!hist.days) hist.days = {};
  hist.days[today] ||= {};
  // Only record a count when its source produced a trustworthy reading this run.
  // A transient failure yields 0 — an empty `dashboard` build snapshot, or an
  // iTunes lookup that threw/returned nothing (common when a manual rebuild fires
  // all Workers at once and Apple rate-limits). Writing that 0 would clobber the
  // carried-forward value and the chart shows a phantom drop to zero (and the
  // "Apps in production" iOS legend reads 0). Leaving today unset lets carryFill
  // keep the last good value; the next healthy run overwrites today with the real
  // count. Both sources are legitimately > 0 today, so gating on > 0 is safe.
  if ((build.apps || []).length && prodAndroid > 0) hist.days[today].prodAndroid = prodAndroid;
  if (prodIos > 0) hist.days[today].prodIos = prodIos;
  const keep = new Set(lastNDays(HIST_KEEP, today));
  for (const k of Object.keys(hist.days)) if (!keep.has(k)) delete hist.days[k];
  await env.SCRATCHPAD.put('dashboard-history', JSON.stringify(hist));

  // ---- public store-listing map (for the marketing homepage) ----------------
  // Only public store data: package + the live store URL per platform (null
  // until that listing is actually live and linkable). Served by the ungated
  // /api/apps Pages Function so the homepage can light up store badges without a
  // hand edit. No revenue/installs/ratings here — keep it strictly public.
  // Only advertise a Play link when the listing is verifiably live (the probed
  // set above) — a production-track release still in initial review has a
  // public URL that 404s.
  const androidLive = new Set(androidLivePkgs);
  const iosLiveSet = new Set(Object.entries(iosVer.apps || {}).filter(([, t]) => isIosLive(t)).map(([pkg]) => pkg));
  const publicApps = {};
  for (const r of rows) {
    const pkg = r.androidPackage;
    const play = androidLive.has(pkg) ? `https://play.google.com/store/apps/details?id=${pkg}` : null;
    // Prefer the iTunes trackViewUrl (has the app slug); it's only set when the
    // App Store listing is live. Fall back to a numeric-id link from the ASC app
    // id (stored by the iOS-versions Worker) whenever ASC reports the app live —
    // reliable the moment of launch, with no dependency on iTunes indexing.
    let ios = r.iosUrl || null;
    const iosId = iosVer.apps?.[pkg]?.appleId;
    if (!ios && iosLiveSet.has(pkg) && iosId) ios = `https://apps.apple.com/app/id${iosId}`;
    if (play || ios) publicApps[pkg] = { play, ios };
  }
  await env.SCRATCHPAD.put('public-apps', JSON.stringify({ updatedAt: new Date().toISOString(), apps: publicApps }));

  // ---- 30-day series (Android + iOS split) ----------------------------------
  const days = lastNDays(WINDOW_DAYS, today);
  // Cumulative lifetime-downloads line: end at the lifetime total, walk back by
  // each day's flow. Days before our data have flow 0, so the line goes flat.
  const cum = (total, flowByDay) => {
    const out = new Array(days.length); let running = total;
    for (let i = days.length - 1; i >= 0; i--) { out[i] = Math.max(0, running); running -= flowByDay[days[i]] || 0; }
    return out;
  };
  const totalDownloadsAndroid = sum('downloadsAndroid');
  const totalDownloadsIos = sum('downloadsIos');
  const series = {
    days,
    revenueAndroid: days.map(d => revAndroidByDay[d] ?? 0),
    revenueIos: days.map(d => iosRevByDay[d] ?? 0),
    downloadsAndroid: cum(totalDownloadsAndroid, dlAndroidByDay),
    downloadsIos: cum(totalDownloadsIos, iosDlByDay),
    prodAndroid: carryFill(days.map(d => hist.days[d]?.prodAndroid ?? null)),
    prodIos: carryFill(days.map(d => hist.days[d]?.prodIos ?? null)),
  };

  const r2 = v => Math.round(v * 100) / 100;
  await env.SCRATCHPAD.put(
    'dashboard-metrics',
    JSON.stringify({
      metricsAt: new Date().toISOString(),
      apps: rows,
      sales,
      iosReport,
      series,
      summary: {
        totalActiveInstalls: sum('activeInstalls'),
        totalDownloadsAndroid, totalDownloadsIos,
        totalRevenue30dAndroid: r2(sum('revenue')),
        totalRevenue30dIos: r2(sum('revenueIos')),
        revenueWindowDays: WINDOW_DAYS,
        revenueSource: 'play-sales + asc-sales',
        onAppStore: prodIos, // authoritative ASC live-count (iTunes fallback)
        onPlayProduction: prodAndroid, // approved & live (listing probe), not just production-track
      },
    }),
  );

  return {
    apps: rows.length,
    subrequests: subreq,
    onAppStore: prodIos,
    iosLiveAsc: iosLive,
    onAppStoreItunes: onAppStore,
    ios: iosReport,
    downloads: `android ${totalDownloadsAndroid} / ios ${totalDownloadsIos}`,
    revenue30d: `android $${r2(sum('revenue'))} / ios $${r2(sum('revenueIos'))}`,
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
