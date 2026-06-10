// Cloudflare Pages Function — manual "force refresh" for the build dashboard.
//
// The dashboard page's Refresh button normally just re-reads the KV snapshot;
// it does NOT regenerate it (the snapshot/metrics are written by two cron
// Workers — sedx-dashboard-cron every 6h, sedx-dashboard-metrics daily). This
// endpoint lets an authenticated user kick those Workers on demand, then the
// page reloads the fresh KV data.
//
// The Workers' manual-trigger endpoints require an `X-Trigger: <TRIGGER_SECRET>`
// header. That secret must stay server-side, so this Function holds it (Pages
// project env var TRIGGER_SECRET) and proxies the request — the browser never
// sees it.
//
// Lives under /scratchpad/* so Cloudflare Access already gates it: Access strips
// any client-supplied Cf-Access-Jwt-Assertion and injects a real one only for
// authenticated users, so the header's presence proves auth (same model as
// dashboard-data.js).

const BUILD_WORKER_DEFAULT = 'https://sedx-dashboard-cron.jondreher.workers.dev/';
const METRICS_WORKER_DEFAULT = 'https://sedx-dashboard-metrics.jondreher.workers.dev/';
const IOS_WORKER_DEFAULT = 'https://sedx-ios-versions.jondreher.workers.dev/';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function trigger(url, secret) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'X-Trigger': secret } });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
    return { ok: res.ok, status: res.status, result: parsed };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function onRequest({ request, env }) {
  if (!request.headers.get('Cf-Access-Jwt-Assertion'))
    return json({ ok: false, error: 'Unauthorized' }, 401);
  if (request.method !== 'POST')
    return json({ ok: false, error: 'Method not allowed' }, 405);
  if (!env.TRIGGER_SECRET)
    return json({ ok: false, error: 'TRIGGER_SECRET not configured on the Pages project' }, 500);

  // ?targets=build|metrics|ios|all (default all). Metrics is the slow one (GCS + sales reports).
  const url = new URL(request.url);
  const targets = (url.searchParams.get('targets') || 'all').toLowerCase();
  const all = targets === 'all' || targets === 'both'; // 'both' kept for back-compat
  const doBuild = all || targets === 'build';
  const doMetrics = all || targets === 'metrics';
  const doIos = all || targets === 'ios';

  const buildUrl = env.BUILD_WORKER_URL || BUILD_WORKER_DEFAULT;
  const metricsUrl = env.METRICS_WORKER_URL || METRICS_WORKER_DEFAULT;
  const iosUrl = env.IOS_WORKER_URL || IOS_WORKER_DEFAULT;

  const [build, metrics, ios] = await Promise.all([
    doBuild ? trigger(buildUrl, env.TRIGGER_SECRET) : Promise.resolve(null),
    doMetrics ? trigger(metricsUrl, env.TRIGGER_SECRET) : Promise.resolve(null),
    doIos ? trigger(iosUrl, env.TRIGGER_SECRET) : Promise.resolve(null),
  ]);

  const ok = (!doBuild || build?.ok) && (!doMetrics || metrics?.ok) && (!doIos || ios?.ok);
  return json({ ok, build, metrics, ios }, ok ? 200 : 502);
}
