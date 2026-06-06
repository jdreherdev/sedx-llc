#!/usr/bin/env node
// collect-dashboard.js — gathers a build-status snapshot for every Apps/* app
// and pushes it to the SEDX-site dashboard (Cloudflare KV key "dashboard").
//
// For each app it reports:
//   - local version + versionCode (from app.json — what's committed on disk)
//   - live Play Store track status per track (production / beta / alpha /
//     internal): current versionCode(s), release name, status, rollout %.
//     Source of truth = Google Play Developer API, authed with the app's own
//     google-service-account.json.
//
// The browser dashboard (/scratchpad/dashboard/) reads this back via
// /scratchpad/dashboard-data (both gated by the existing Access app).
//
// Usage:   node SEDX-site/collect-dashboard.js
//   --dry  print the snapshot JSON instead of pushing to KV
//
// No external npm deps — uses node's built-in https + crypto.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const APPS_DIR = path.resolve(__dirname, '..');
const CF_ACCOUNT = '2cc28133149548e6653b30b50396ae9a';
const CF_NAMESPACE = 'bb2bde463eb9447d89b62a352322d280'; // scratchpad KV
const CF_TOKEN_FILE = path.join(APPS_DIR, '.cloudflare-token');
const KV_KEY = 'dashboard';
const CONFIG_KEY = 'dashboard-config';
const TRACKS = ['production', 'beta', 'alpha', 'internal'];
const DRY = process.argv.includes('--dry');
const EMIT_CONFIG = process.argv.includes('--emit-config');

// ---- tiny https JSON helper -------------------------------------------------
function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          ...headers,
          ...(data != null ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      res => {
        let chunks = '';
        res.on('data', c => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      },
    );
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---- Google service-account → access token (RS256 JWT, scope androidpublisher)
async function getGoogleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claim}.${sig}`;
  const res = await req('POST', 'https://oauth2.googleapis.com/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' +
      encodeURIComponent(assertion),
  });
  if (res.status !== 200) throw new Error(`token ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).access_token;
}

// ---- Play track status for one package -------------------------------------
async function getPlayTracks(token, pkg) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
  const auth = { Authorization: `Bearer ${token}` };

  const edit = await req('POST', `${base}/edits`, { headers: auth });
  if (edit.status === 404) return { onPlay: false, tracks: {} };
  if (edit.status !== 200) throw new Error(`edit ${edit.status}: ${edit.body.slice(0, 160)}`);
  const editId = JSON.parse(edit.body).id;

  try {
    const tr = await req('GET', `${base}/edits/${editId}/tracks`, { headers: auth });
    if (tr.status !== 200) throw new Error(`tracks ${tr.status}: ${tr.body.slice(0, 160)}`);
    const out = {};
    for (const t of JSON.parse(tr.body).tracks || []) {
      // newest non-empty release on the track
      const rel = (t.releases || []).find(r => (r.versionCodes || []).length) || (t.releases || [])[0];
      if (!rel) continue;
      out[t.track] = {
        versionCodes: rel.versionCodes || [],
        name: rel.name || null,
        status: rel.status || null, // completed | inProgress | halted | draft
        userFraction: rel.userFraction != null ? rel.userFraction : null,
      };
    }
    return { onPlay: true, tracks: out };
  } finally {
    // abandon the edit so we never leave drafts lying around
    await req('DELETE', `${base}/edits/${editId}`, { headers: auth }).catch(() => {});
  }
}

// ---- discover apps ----------------------------------------------------------
function discoverApps() {
  const apps = [];
  for (const name of fs.readdirSync(APPS_DIR)) {
    const dir = path.join(APPS_DIR, name);
    const appJson = path.join(dir, 'app.json');
    if (!fs.existsSync(appJson)) continue;
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(appJson, 'utf8'));
    } catch {
      continue;
    }
    const e = cfg.expo || cfg;
    const android = e.android || {};
    const ios = e.ios || {};
    const pkg = android.package || null;
    if (!pkg && !ios.bundleIdentifier) continue;
    apps.push({
      name,
      displayName: e.name || name,
      appId: pkg || ios.bundleIdentifier,
      androidPackage: pkg,
      iosBundleId: ios.bundleIdentifier || null,
      version: e.version || null,
      versionCode: android.versionCode != null ? android.versionCode : null,
      saPath: path.join(dir, 'google-service-account.json'),
    });
  }
  return apps.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ---- push a JSON value to a KV key -----------------------------------------
async function putKV(key, value) {
  const cfToken = (process.env.CF_API_TOKEN || fs.readFileSync(CF_TOKEN_FILE, 'utf8')).trim();
  const put = await req(
    'PUT',
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_NAMESPACE}/values/${key}`,
    { headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(value) },
  );
  if (put.status !== 200) {
    console.error(`KV push failed (${key}) ${put.status}: ${put.body.slice(0, 300)}`);
    process.exit(1);
  }
}

// ---- main -------------------------------------------------------------------
(async () => {
  const apps = discoverApps();

  // --emit-config: write the app list (no Play calls) to the dashboard-config
  // KV key, which the scheduled Cloudflare Worker reads. Run this on the laptop
  // whenever apps are added/renamed or dev versions should be refreshed.
  if (EMIT_CONFIG) {
    const config = {
      emittedAt: new Date().toISOString(),
      apps: apps
        .filter(a => a.androidPackage)
        .map(a => ({
          name: a.name,
          displayName: a.displayName,
          androidPackage: a.androidPackage,
          version: a.version,
        })),
    };
    if (DRY) {
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    await putKV(CONFIG_KEY, config);
    process.stderr.write(`Emitted ${config.apps.length} apps to KV "${CONFIG_KEY}" at ${config.emittedAt}\n`);
    return;
  }

  const results = [];

  for (const app of apps) {
    const row = {
      name: app.name,
      displayName: app.displayName,
      appId: app.appId,
      androidPackage: app.androidPackage,
      version: app.version,
      versionCode: app.versionCode,
      onPlay: false,
      tracks: {},
      error: null,
    };

    if (app.androidPackage && fs.existsSync(app.saPath)) {
      try {
        const sa = JSON.parse(fs.readFileSync(app.saPath, 'utf8'));
        const token = await getGoogleToken(sa);
        const { onPlay, tracks } = await getPlayTracks(token, app.androidPackage);
        row.onPlay = onPlay;
        row.tracks = tracks;
      } catch (err) {
        row.error = String(err.message || err);
      }
    }

    const live = Object.keys(row.tracks).filter(t => TRACKS.includes(t));
    process.stderr.write(
      `${app.displayName.padEnd(22)} v${String(app.version).padEnd(9)} ` +
        `${row.onPlay ? `tracks: ${live.join(',') || '—'}` : row.error ? `ERR ${row.error}` : 'not on Play'}\n`,
    );
    results.push(row);
  }

  const snapshot = {
    snapshotAt: new Date().toISOString(),
    apps: results,
    summary: {
      total: results.length,
      onProduction: results.filter(r => r.tracks.production).length,
      onTesting: results.filter(r => r.tracks.internal || r.tracks.alpha || r.tracks.beta).length,
    },
  };

  if (DRY) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  await putKV(KV_KEY, snapshot);
  process.stderr.write(
    `\nPushed ${results.length} apps to KV "${KV_KEY}" at ${snapshot.snapshotAt}\n` +
      `  production: ${snapshot.summary.onProduction}  testing: ${snapshot.summary.onTesting}\n`,
  );
})().catch(err => {
  console.error(err);
  process.exit(1);
});
