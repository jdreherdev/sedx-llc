// Cloudflare Pages Function — PUBLIC store-listing map for the marketing homepage.
//
// Returns only public store data per app — the package id and the live Play /
// App Store URLs (null until a listing is actually live). The homepage fetches
// this and lights up the store badges automatically, so a new launch needs no
// hand edit to index.html.
//
// Written by the sedx-dashboard-metrics Worker into KV key "public-apps":
//   { updatedAt: ISO8601, apps: { "<androidPackage>": { play: url|null, ios: url|null } } }
//
// This endpoint is intentionally UNAUTHENTICATED: it lives under /api/* (which is
// NOT covered by the Cloudflare Access application — only /scratchpad/* is) and
// must be readable by anonymous visitors. It exposes nothing private — store
// links are already public. Do NOT add revenue/installs/ratings to this key.

const KV_KEY = 'public-apps';
const DEFAULT_DOC = { updatedAt: null, apps: {} };

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Public, cacheable for a few minutes so homepage traffic doesn't hit KV
      // every load; a freshly-live listing still appears within ~5 min.
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      ...(init.headers || {}),
    },
  });

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  if (!env.SCRATCHPAD) return json(DEFAULT_DOC);
  const raw = await env.SCRATCHPAD.get(KV_KEY);
  if (!raw) return json(DEFAULT_DOC);
  try {
    return json(JSON.parse(raw));
  } catch {
    return json(DEFAULT_DOC);
  }
}
