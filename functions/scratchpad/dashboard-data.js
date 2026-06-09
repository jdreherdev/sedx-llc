// Cloudflare Pages Function — read-only build/metrics dashboard snapshot.
//
// Same model as memory.js: the source of truth is the local collector script
// (Apps/SEDX-site/collect-dashboard.js) which gathers each app's local version
// and live Play Store track status, then writes a snapshot directly to the
// SCRATCHPAD KV namespace under the "dashboard" key via the Cloudflare API.
// This Worker only reads it back. It lives under the /scratchpad/* prefix
// (served at /scratchpad/dashboard-data) precisely because that prefix is
// already covered by the Cloudflare Access application — so Access strips any
// client-supplied Cf-Access-Jwt-Assertion header and injects a real one only
// for authenticated users. Presence of that header here therefore proves auth.
//
// Storage: single KV key "dashboard" →
//   { snapshotAt: ISO8601, apps: [{ name, appId, version, tracks: {...}, ... }] }

const KV_KEY = 'dashboard';
const DEFAULT_DOC = { snapshotAt: null, apps: [] };

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });

const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });

export async function onRequest({ request, env }) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return text('Unauthorized', 401);
  if (!env.SCRATCHPAD) return text('KV binding missing', 500);

  if (request.method !== 'GET') return text('Method not allowed', 405);

  const [rawBuild, rawMetrics, rawIosVersions] = await Promise.all([
    env.SCRATCHPAD.get(KV_KEY),
    env.SCRATCHPAD.get('dashboard-metrics'),
    env.SCRATCHPAD.get('dashboard-ios-versions'),
  ]);

  let doc;
  try {
    doc = rawBuild ? JSON.parse(rawBuild) : { ...DEFAULT_DOC };
  } catch {
    doc = { ...DEFAULT_DOC };
  }

  // Merge in the daily metrics snapshot by package: installs + revenue, plus the
  // current App Store version/url (collected by the metrics Worker via iTunes).
  if (rawMetrics) {
    try {
      const m = JSON.parse(rawMetrics);
      const byPkg = Object.fromEntries((m.apps || []).map(a => [a.androidPackage, a]));
      for (const app of doc.apps || []) {
        const mx = byPkg[app.androidPackage];
        if (mx) {
          app.metrics = {
            activeInstalls: mx.activeInstalls,
            downloadsAndroid: mx.downloadsAndroid, downloadsIos: mx.downloadsIos, // lifetime
            revenue: mx.revenue, revenueIos: mx.revenueIos,                       // 30d proceeds
          };
          if (mx.iosVersion) app.iosVersion = mx.iosVersion;
          if (mx.iosUrl) app.iosUrl = mx.iosUrl; // fresher than the build snapshot's
        }
      }
      doc.metrics = { metricsAt: m.metricsAt, summary: m.summary || null, series: m.series || null };
    } catch {
      /* leave build-only doc */
    }
  }

  // Merge iOS version-by-track/state (App Store + TestFlight) onto each app, so
  // the dashboard can render an iOS row beside the Android Play-track row.
  if (rawIosVersions) {
    try {
      const iv = JSON.parse(rawIosVersions);
      for (const app of doc.apps || []) {
        const t = iv.apps?.[app.androidPackage];
        if (t && !t.error) app.iosTracks = t;
      }
      doc.iosVersionsAt = iv.updatedAt || null;
    } catch {
      /* leave without iOS tracks */
    }
  }

  return json(doc);
}
