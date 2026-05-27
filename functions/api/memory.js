// Cloudflare Pages Function — read-only snapshot of Claude's memory directory.
//
// The source of truth is `~/.claude/projects/-Users-jdreher-Downloads-Apps/memory/`
// on the user's laptop. Claude pushes a snapshot here via the Cloudflare API
// (KV write directly, bypassing this Worker). The browser UI only reads.
//
// Storage: single KV key "memory" → { snapshotAt: ISO8601, files: [{name, content}] }

const KV_KEY = 'memory';
const DEFAULT_DOC = { snapshotAt: null, files: [] };

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
