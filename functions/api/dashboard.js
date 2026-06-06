// Cloudflare Pages Function — read-only build/metrics dashboard snapshot.
//
// Same model as memory.js: the source of truth is the local collector script
// (Apps/SEDX-site/collect-dashboard.js) which gathers each app's local version
// and live Play Store track status, then writes a snapshot directly to the
// SCRATCHPAD KV namespace under the "dashboard" key via the Cloudflare API.
// This Worker only reads it back. Cloudflare Access gates every request that
// reaches here (presence of the Cf-Access-Jwt-Assertion header = authenticated).
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

  const raw = await env.SCRATCHPAD.get(KV_KEY);
  if (!raw) return json(DEFAULT_DOC);
  try {
    return json(JSON.parse(raw));
  } catch {
    return json(DEFAULT_DOC);
  }
}
