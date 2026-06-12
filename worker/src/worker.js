// sedx-dashboard-cron — Cloudflare Worker (Cron Trigger).
//
// Every 6h it refreshes the build dashboard with zero laptop involvement:
//   1. read the app list from KV "dashboard-config" (written by the laptop:
//      `node SEDX-site/collect-dashboard.js --emit-config`)
//   2. for each app, query the Google Play Developer API for live track status,
//      authed with the single shared service account (Worker secret GOOGLE_SA_KEY)
//   3. write the snapshot to KV "dashboard", read by /scratchpad/
//
// KV is reached via the SCRATCHPAD binding (no Cloudflare token needed here).
// The gated Pages Function /scratchpad/dashboard-data serves what we write.

const TRACKS = ['production', 'beta', 'alpha', 'internal'];
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const CONCURRENCY = 5;

// ---- base64url helpers ------------------------------------------------------
const b64urlStr = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = bytes => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return b64urlStr(bin);
};
const pemToDer = pem => {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(b64);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der.buffer;
};

// ---- Google service-account → access token (RS256, WebCrypto) ---------------
async function getGoogleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' +
      encodeURIComponent(assertion),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

// ---- Play track status for one package -------------------------------------
// Two subrequests per app (create edit + list tracks). We deliberately do NOT
// DELETE/abandon the edit: the free Workers plan caps a single invocation at 50
// subrequests, and a 3rd call per app would blow that budget at ~17 apps. The
// edits are read-only drafts we never commit, and Play expires them on its own.
// (The laptop collector still abandons them — it has no subrequest limit.)
async function getPlayTracks(token, pkg) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
  const auth = { Authorization: `Bearer ${token}` };

  const edit = await fetch(`${base}/edits`, { method: 'POST', headers: auth });
  if (edit.status === 404) return { onPlay: false, tracks: {} };
  if (!edit.ok) throw new Error(`edit ${edit.status}: ${(await edit.text()).slice(0, 160)}`);
  const editId = (await edit.json()).id;

  const tr = await fetch(`${base}/edits/${editId}/tracks`, { headers: auth });
  if (!tr.ok) throw new Error(`tracks ${tr.status}: ${(await tr.text()).slice(0, 160)}`);
  const out = {};
  for (const t of (await tr.json()).tracks || []) {
    const rel = (t.releases || []).find(r => (r.versionCodes || []).length) || (t.releases || [])[0];
    if (!rel) continue;
    out[t.track] = {
      versionCodes: rel.versionCodes || [],
      name: rel.name || null,
      status: rel.status || null,
      userFraction: rel.userFraction != null ? rel.userFraction : null,
    };
  }
  return { onPlay: true, tracks: out };
}

// ---- run a list of async thunks with bounded concurrency -------------------
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- collect + write snapshot ----------------------------------------------
async function refresh(env) {
  if (!env.SCRATCHPAD) throw new Error('SCRATCHPAD KV binding missing');
  if (!env.GOOGLE_SA_KEY) throw new Error('GOOGLE_SA_KEY secret missing');

  const cfg = (await env.SCRATCHPAD.get('dashboard-config', 'json')) || { apps: [] };
  const apps = (cfg.apps || []).filter(a => a.androidPackage);
  if (!apps.length) throw new Error('dashboard-config has no apps — run --emit-config on the laptop');

  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const token = await getGoogleToken(sa);

  const results = await pool(apps, CONCURRENCY, async app => {
    const row = {
      name: app.name,
      displayName: app.displayName,
      appId: app.androidPackage,
      androidPackage: app.androidPackage,
      iosUrl: app.iosUrl || null,
      version: app.version,
      onPlay: false,
      tracks: {},
      error: null,
    };
    try {
      const { onPlay, tracks } = await getPlayTracks(token, app.androidPackage);
      row.onPlay = onPlay;
      row.tracks = tracks;
    } catch (err) {
      row.error = String(err.message || err);
    }
    return row;
  });

  const snapshot = {
    snapshotAt: new Date().toISOString(),
    source: 'cron',
    apps: results,
    summary: {
      total: results.length,
      onProduction: results.filter(r => r.tracks.production).length,
      onTesting: results.filter(r => r.tracks.internal || r.tracks.alpha || r.tracks.beta).length,
    },
  };

  await env.SCRATCHPAD.put('dashboard', JSON.stringify(snapshot));
  return snapshot;
}

export default {
  // 6-hourly cron. Awaited by the runtime; a throw shows as a failed
  // invocation in `wrangler tail` / the dashboard.
  async scheduled(event, env, ctx) {
    await refresh(env);
  },

  // Optional manual trigger: POST with header `X-Trigger: <TRIGGER_SECRET>`.
  // Returns the summary. Disabled unless the TRIGGER_SECRET secret is set.
  async fetch(request, env) {
    if (!env.TRIGGER_SECRET) return new Response('Not found', { status: 404 });
    if (request.headers.get('X-Trigger') !== env.TRIGGER_SECRET)
      return new Response('Forbidden', { status: 403 });
    try {
      const snap = await refresh(env);
      return Response.json({ ok: true, snapshotAt: snap.snapshotAt, summary: snap.summary });
    } catch (err) {
      return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
    }
  },
};
