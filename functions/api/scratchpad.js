// Cloudflare Pages Function — backs the /scratchpad UI.
//
// Auth model: Cloudflare Access protects every request that reaches this
// function. Access injects the `Cf-Access-Jwt-Assertion` header only on
// authenticated requests; Cloudflare strips any client-supplied value on the
// way in. We treat presence of that header as proof of authentication,
// then optionally verify the JWT signature against the team's JWKS
// (defense-in-depth — toggle via the CF_ACCESS_TEAM_DOMAIN env var).
//
// Storage: a single key ("data") in the SCRATCHPAD KV namespace holds the
// JSON document for this single-user workspace.

const KV_KEY = 'data';
const MAX_BYTES = 200_000; // 200 KB cap on the document

const DEFAULT_DOC = { scratchpad: '', ideas: [] };

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

// Optional: verify the Cloudflare Access JWT signature. Skipped if
// CF_ACCESS_TEAM_DOMAIN is not set, since the header presence alone is
// sufficient when the route is gated by Access at the edge.
async function verifyAccessJWT(jwt, env) {
  if (!env.CF_ACCESS_TEAM_DOMAIN) return true;
  try {
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return false;

    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const certsRes = await fetch(
      `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
      { cf: { cacheTtl: 3600, cacheEverything: true } },
    );
    if (!certsRes.ok) return false;
    const { keys } = await certsRes.json();
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const sig = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0),
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!ok) return false;

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp * 1000 < Date.now()) return false;
    if (env.CF_ACCESS_AUD) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(env.CF_ACCESS_AUD)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function onRequest({ request, env }) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return text('Unauthorized', 401);
  if (!(await verifyAccessJWT(jwt, env))) return text('Forbidden', 403);
  if (!env.SCRATCHPAD) return text('KV binding missing', 500);

  if (request.method === 'GET') {
    const raw = await env.SCRATCHPAD.get(KV_KEY);
    if (!raw) return json(DEFAULT_DOC);
    try {
      return json(JSON.parse(raw));
    } catch {
      return json(DEFAULT_DOC);
    }
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    if (body.length > MAX_BYTES) return text('Document too large', 413);
    let doc;
    try {
      doc = JSON.parse(body);
    } catch {
      return text('Invalid JSON', 400);
    }
    const normalized = {
      scratchpad: typeof doc.scratchpad === 'string' ? doc.scratchpad : '',
      ideas: Array.isArray(doc.ideas)
        ? doc.ideas
            .filter(x => x && typeof x === 'object')
            .map(x => ({
              id: typeof x.id === 'string' ? x.id : crypto.randomUUID(),
              text: typeof x.text === 'string' ? x.text : '',
            }))
        : [],
    };
    await env.SCRATCHPAD.put(KV_KEY, JSON.stringify(normalized));
    return text('OK');
  }

  return text('Method not allowed', 405);
}
