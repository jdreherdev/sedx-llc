// sedx-ios-versions — Cloudflare Worker (6h Cron Trigger).
//
// The iOS counterpart to the Android build Worker (sedx-dashboard-cron): it
// tracks each app's iOS version *by release track/state* so the dashboard can
// show an iOS row beside the Android (Play track) row.
//   • App Store — current version + appStoreState (READY_FOR_SALE, IN_REVIEW,
//     PENDING_DEVELOPER_RELEASE, …) via App Store Connect appStoreVersions
//   • TestFlight — latest prerelease (beta) version via preReleaseVersions
// Both come back in ONE call per app: GET /v1/apps/{id}?include=appStoreVersions,
// preReleaseVersions. App ids are resolved once from /v1/apps (bundleId → id).
//
// Writes KV `dashboard-ios-versions` keyed by androidPackage (the dashboard's
// join key); the gated /scratchpad/dashboard-data Pages Function merges it onto
// each app as `iosTracks`. Separate from the build + metrics Workers so each
// stays well under the free-plan 50-subrequest cap.
//
// Auth: ES256 JWT (P-256) — same App Store Connect key as the metrics Worker.
// Secrets: ASC_SALES_KEY (.p8). Vars: ASC_KEY_ID, ASC_ISSUER_ID. (No vendor #.)

const CONCURRENCY = 6;
const ASC = 'https://api.appstoreconnect.apple.com';

// ---- base64url + PEM + ES256 token (WebCrypto) ------------------------------
const b64urlStr = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = bytes => { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return b64urlStr(bin); };
const pemToDer = pem => {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(b64); const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der.buffer;
};
async function ascToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
  const input = `${header}.${claim}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(env.ASC_SALES_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
}

const get = async (token, path) => {
  const r = await fetch(ASC + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 140)}`);
  return r.json();
};

// bundleId -> numeric Apple id, across all apps on the account (one page covers
// the whole catalogue; follow `links.next` just in case).
async function appIdsByBundle(token) {
  const map = {};
  let path = '/v1/apps?limit=200&fields[apps]=bundleId';
  while (path) {
    const j = await get(token, path);
    for (const a of j.data || []) map[a.attributes.bundleId] = a.id;
    const next = j.links?.next;
    path = next ? next.replace(ASC, '') : null;
  }
  return map;
}

// Friendly, compact label for an App Store version state.
const STATE_LABEL = {
  READY_FOR_SALE: 'live', PROCESSING_FOR_APP_STORE: 'processing',
  PENDING_DEVELOPER_RELEASE: 'pending release', PENDING_APPLE_RELEASE: 'pending Apple',
  IN_REVIEW: 'in review', WAITING_FOR_REVIEW: 'waiting review',
  PREPARE_FOR_SUBMISSION: 'preparing', DEVELOPER_REJECTED: 'rejected', REJECTED: 'rejected',
  METADATA_REJECTED: 'metadata rejected', INVALID_BINARY: 'invalid binary',
  REPLACED_WITH_NEW_VERSION: 'replaced', REMOVED_FROM_SALE: 'removed',
};
const stateLabel = s => STATE_LABEL[s] || (s ? s.toLowerCase().replace(/_/g, ' ') : null);
const verNum = v => (v || '').split('.').map(n => parseInt(n, 10) || 0);
const verCmp = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

// One app's iOS tracks: App Store (newest non-replaced version + state) + TestFlight.
async function iosTracksFor(token, appleId) {
  const j = await get(token,
    `/v1/apps/${appleId}?include=appStoreVersions,preReleaseVersions` +
    `&fields[apps]=bundleId&fields[appStoreVersions]=versionString,appStoreState,platform,createdDate` +
    `&fields[preReleaseVersions]=version,platform&limit[appStoreVersions]=5&limit[preReleaseVersions]=5`);
  const inc = j.included || [];
  const asv = inc.filter(x => x.type === 'appStoreVersions' && (x.attributes.platform === 'IOS' || !x.attributes.platform))
    .map(x => x.attributes);
  const pre = inc.filter(x => x.type === 'preReleaseVersions' && (x.attributes.platform === 'IOS' || !x.attributes.platform))
    .map(x => x.attributes);

  // App Store: prefer the newest version that isn't superseded; else the newest.
  const live = asv.filter(v => v.appStoreState !== 'REPLACED_WITH_NEW_VERSION');
  const pick = (live.length ? live : asv).sort((a, b) =>
    (b.createdDate || '').localeCompare(a.createdDate || '') || verCmp(b.versionString, a.versionString))[0];
  const production = pick ? { name: pick.versionString, state: stateLabel(pick.appStoreState) } : null;

  // `production` tracks the newest in-flight version (so the dashboard shows
  // "waiting review" etc.), but the app stays ON SALE the whole time a new
  // version is in review: the prior READY_FOR_SALE version keeps selling until
  // the new one replaces it. Report that separately so consumers (live-app
  // count, homepage store links) don't drop an app just because it shipped an
  // update for review.
  const onSale = asv.find(v => v.appStoreState === 'READY_FOR_SALE');
  const liveNow = onSale ? { live: true, liveVersion: onSale.versionString } : { live: false };

  // TestFlight: highest prerelease (marketing) version.
  const tf = pre.map(v => v.version).sort(verCmp).pop();
  const beta = tf ? { name: tf } : null;

  return (production || beta) ? { production, beta, ...liveNow } : null;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function refresh(env) {
  if (!env.SCRATCHPAD) throw new Error('SCRATCHPAD KV binding missing');
  if (!env.ASC_SALES_KEY || !env.ASC_KEY_ID || !env.ASC_ISSUER_ID) throw new Error('ASC credentials missing');

  const cfg = (await env.SCRATCHPAD.get('dashboard-config', 'json')) || { apps: [] };
  const apps = (cfg.apps || []).filter(a => a.iosBundleId);
  if (!apps.length) throw new Error('dashboard-config has no iOS apps');

  const token = await ascToken(env);
  const idByBundle = await appIdsByBundle(token);

  const targets = apps.map(a => ({ ...a, appleId: idByBundle[a.iosBundleId] })).filter(a => a.appleId);
  const out = {};
  let withData = 0;
  await pool(targets, CONCURRENCY, async app => {
    try {
      const tracks = await iosTracksFor(token, app.appleId);
      // Keep the App Store Connect numeric app id so consumers can build a
      // working App Store URL (apps.apple.com/app/id<appleId>) the moment a
      // listing goes live, without waiting on the flaky iTunes lookup.
      if (tracks) { out[app.androidPackage] = { ...tracks, appleId: app.appleId }; withData++; }
    } catch (e) {
      out[app.androidPackage] = { error: String(e.message || e) };
    }
  });

  await env.SCRATCHPAD.put('dashboard-ios-versions', JSON.stringify({ updatedAt: new Date().toISOString(), apps: out }));
  return { iosApps: targets.length, withData };
}

export default {
  async scheduled(event, env, ctx) { await refresh(env); },
  async fetch(request, env) {
    if (!env.TRIGGER_SECRET) return new Response('Not found', { status: 404 });
    if (request.headers.get('X-Trigger') !== env.TRIGGER_SECRET) return new Response('Forbidden', { status: 403 });
    try { return Response.json({ ok: true, ...(await refresh(env)) }); }
    catch (err) { return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 }); }
  },
};
