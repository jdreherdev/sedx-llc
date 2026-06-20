// Parse the canonical cross-session action-item checklist (a Claude memory file)
// and push a JSON snapshot to the scratchpad KV key "action-items", which the
// sedx.llc dashboard renders below the build table (see
// functions/scratchpad/action-items.js).
//
// Run after editing the checklist:  node SEDX-site/sync-action-items.mjs
//   --dry   print the parsed snapshot, do not write KV
// Needs Apps/.cloudflare-token (KV R/W) — same token the collector uses.
// No npm deps; Node 18+ (global fetch).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const APPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CF_ACCOUNT = '2cc28133149548e6653b30b50396ae9a';
const CF_NAMESPACE = 'bb2bde463eb9447d89b62a352322d280'; // scratchpad KV
const CF_TOKEN_FILE = path.join(APPS_DIR, '.cloudflare-token');
const KEY = 'action-items';

// Canonical checklist lives in the project's Claude memory dir. Override with
// ACTION_ITEMS_FILE if your home/workspace path differs.
const MEM_FILE =
  process.env.ACTION_ITEMS_FILE ||
  path.join(
    os.homedir(),
    '.claude/projects/-Users-jdreher-Downloads-Apps/memory/app-action-items.md',
  );

function parse(md) {
  const groups = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const full = h[1].replace(/\*\*/g, '').trim();
      const m = full.match(/^(.*?)\s*\((.+)\)\s*$/);
      cur = { app: (m ? m[1] : full).trim(), note: m ? m[2].trim() : '', todo: [], doneItems: [] };
      groups.push(cur);
      continue;
    }
    const it = raw.match(/^[-*]\s+\[([ xX~])\]\s+(.+?)\s*$/);
    if (it && cur) {
      const text = it[2].replace(/\*\*/g, '').trim();
      if (it[1] === ' ' || it[1] === '~') cur.todo.push(text);
      else cur.doneItems.push(text);
    }
  }
  return groups
    .map(g => ({ ...g, open: g.todo.length, done: g.doneItems.length }))
    .filter(g => g.open || g.done);
}

async function putKV(value) {
  const token = (process.env.CF_API_TOKEN || fs.readFileSync(CF_TOKEN_FILE, 'utf8')).trim();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_NAMESPACE}/values/${KEY}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(value) },
  );
  if (!res.ok) {
    console.error(`KV push failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
}

const md = fs.readFileSync(MEM_FILE, 'utf8');
const groups = parse(md);
const totals = groups.reduce(
  (t, g) => ({ open: t.open + g.open, done: t.done + g.done }),
  { open: 0, done: 0 },
);
const doc = { updatedAt: new Date().toISOString(), source: 'app-action-items.md', totals, groups };

if (process.argv.includes('--dry')) {
  console.log(JSON.stringify(doc, null, 2));
  console.log(`\n${groups.length} groups · ${totals.open} open · ${totals.done} done`);
} else {
  await putKV(doc);
  console.log(`Pushed action-items: ${groups.length} groups · ${totals.open} open · ${totals.done} done`);
}
