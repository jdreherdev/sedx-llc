#!/usr/bin/env node
// seed-lifetime.js — one-time (re-runnable) seed of the dashboard's Android
// lifetime-downloads store. The metrics Worker accrues new installs daily but
// only reads the current + previous month, so it can't see history older than
// that on a cold start. This sums "Daily User Installs" across ALL retained Play
// install reports per app and writes KV `dashboard-lifetime.android` = { pkg:
// { total, lastDate } }. The Worker then only adds days newer than lastDate, so
// re-running this is safe (it just resets the baseline to the true total).
//
// iOS lifetime is NOT seeded — the App Store apps just launched, so the Worker
// accrues it from day one via App Store Connect Sales reports.
//
// Usage:  node SEDX-site/seed-lifetime.js [--dry]
// GCS auth: any app's google-service-account.json (shared SA, storage scope).
// KV auth:  Apps/.cloudflare-token (see collect-dashboard.js).

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const APPS_DIR = path.resolve(__dirname, '..');
const CF_ACCOUNT = '2cc28133149548e6653b30b50396ae9a';
const CF_NAMESPACE = 'bb2bde463eb9447d89b62a352322d280';
const CF_TOKEN_FILE = path.join(APPS_DIR, '.cloudflare-token');
const SA_FILE = path.join(APPS_DIR, 'Counted', 'google-service-account.json');
const BUCKET = 'pubsite_prod_6833260647245584473';
const KEY = 'dashboard-lifetime';
const DRY = process.argv.includes('--dry');

function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { ...headers, ...(data != null ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let c = ''; res.on('data', d => (c += d)); res.on('end', () => resolve({ status: res.statusCode, body: c })); });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}
// Binary-safe GET (the install CSVs are UTF-16LE) -> Buffer.
function reqBuf(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject); r.end();
  });
}
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function gcsToken() {
  const sa = JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const c = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_only', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const s = crypto.createSign('RSA-SHA256'); s.update(`${h}.${c}`);
  const res = await req('POST', 'https://oauth2.googleapis.com/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(`${h}.${c}.${b64url(s.sign(sa.private_key))}`) });
  if (res.status !== 200) throw new Error(`token ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).access_token;
}
const gcs = p => `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o${p}`;

// Sum "Daily User Installs" and find the latest date in one overview CSV.
async function sumFile(token, name) {
  const r = await reqBuf(gcs(`/${encodeURIComponent(name)}?alt=media`), { Authorization: `Bearer ${token}` });
  if (r.status !== 200) return { sum: 0, lastDate: '0000-00-00' };
  const buf = r.buf;
  const utf16 = buf[0] === 0xff && buf[1] === 0xfe;
  const text = (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { sum: 0, lastDate: '0000-00-00' };
  const hdr = lines[0].split(',');
  const iDate = hdr.indexOf('Date'), iDaily = hdr.indexOf('Daily User Installs');
  let sum = 0, lastDate = '0000-00-00';
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (iDaily >= 0) { const v = +c[iDaily]; if (!isNaN(v)) sum += v; }
    if (iDate >= 0 && c[iDate] > lastDate) lastDate = c[iDate];
  }
  return { sum, lastDate };
}

(async () => {
  const token = await gcsToken();
  const list = JSON.parse((await req('GET', gcs(`?prefix=${encodeURIComponent('stats/installs/')}&maxResults=1000`), { headers: { Authorization: `Bearer ${token}` } })).body);
  const byPkg = {};
  for (const o of list.items || []) {
    const m = o.name.match(/installs_(.+)_(\d{6})_overview\.csv$/);
    if (m) (byPkg[m[1]] ||= []).push(o.name);
  }

  const android = {};
  for (const pkg of Object.keys(byPkg).sort()) {
    let total = 0, lastDate = '0000-00-00';
    for (const name of byPkg[pkg].sort()) { const { sum, lastDate: ld } = await sumFile(token, name); total += sum; if (ld > lastDate) lastDate = ld; }
    android[pkg] = { total, lastDate };
    process.stderr.write(`${pkg.padEnd(30)} total=${String(total).padEnd(5)} lastDate=${lastDate}\n`);
  }
  const grand = Object.values(android).reduce((s, a) => s + a.total, 0);
  process.stderr.write(`\nGRAND lifetime Android downloads = ${grand}\n`);

  // Preserve any existing iOS lifetime; only (re)seed Android.
  let existing = {};
  try { const g = await req('GET', `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_NAMESPACE}/values/${KEY}`, { headers: { Authorization: `Bearer ${fs.readFileSync(CF_TOKEN_FILE, 'utf8').trim()}` } }); if (g.status === 200) existing = JSON.parse(g.body); } catch {}
  const value = { android, ios: existing.ios || {}, seededAt: new Date().toISOString() };

  if (DRY) { console.log(JSON.stringify(value, null, 2)); return; }
  const cfToken = (process.env.CF_API_TOKEN || fs.readFileSync(CF_TOKEN_FILE, 'utf8')).trim();
  const put = await req('PUT', `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_NAMESPACE}/values/${KEY}`,
    { headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(value) });
  if (put.status !== 200) { console.error(`KV put failed ${put.status}: ${put.body.slice(0, 200)}`); process.exit(1); }
  process.stderr.write(`Seeded KV "${KEY}" (${Object.keys(android).length} apps).\n`);
})().catch(e => { console.error(e); process.exit(1); });
