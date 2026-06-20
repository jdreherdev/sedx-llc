// Cloudflare Pages Function — read-only per-app action-item backlog.
//
// Mirror of the canonical cross-session memory checklist
// (~/.claude/.../memory/app-action-items.md). The local sync script
// (Apps/SEDX-site/sync-action-items.mjs) parses that markdown and writes a
// JSON snapshot to the SCRATCHPAD KV namespace under "action-items"; this
// function only reads it back. Lives under /scratchpad/* so Cloudflare Access
// gates it (see dashboard-data.js for the auth model).
//
// Storage: KV key "action-items" →
//   { updatedAt: ISO8601, source: 'app-action-items.md',
//     totals: { open, done },
//     groups: [{ app, note, open, done, todo: [..], doneItems: [..] }] }

const KV_KEY = 'action-items';
const DEFAULT_DOC = { updatedAt: null, totals: { open: 0, done: 0 }, groups: [] };

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(init.headers || {}) },
  });

const text = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

export async function onRequest({ request, env }) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return text('Unauthorized', 401);
  if (!env.SCRATCHPAD) return text('KV binding missing', 500);
  if (request.method !== 'GET') return text('Method not allowed', 405);

  const raw = await env.SCRATCHPAD.get(KV_KEY);
  let doc;
  try {
    doc = raw ? JSON.parse(raw) : { ...DEFAULT_DOC };
  } catch {
    doc = { ...DEFAULT_DOC };
  }
  return json(doc);
}
