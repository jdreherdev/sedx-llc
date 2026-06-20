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

// H1 (# ) headers switch "boards"; H2 (## ) headers start an app group; the
// default board (before any H1) is the general action backlog.
function boardKey(title) {
  if (/revenuecat|\bRC\b/i.test(title)) return 'rc';
  if (/play console/i.test(title)) return 'play';
  if (/app store connect|\bASC\b/i.test(title)) return 'asc';
  return 'actions';
}

function finalize(groups) {
  return groups
    .map(g => ({ ...g, open: g.todo.length, done: g.doneItems.length }))
    .filter(g => g.open || g.done);
}

function parse(md) {
  const boards = { actions: [], rc: [], play: [], asc: [] };
  let board = 'actions';
  let cur = null;
  for (const raw of md.split('\n')) {
    const h1 = raw.match(/^#\s+(.+?)\s*$/);
    if (h1) { board = boardKey(h1[1].replace(/\*\*/g, '').trim()); cur = null; continue; }
    const h2 = raw.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      const full = h2[1].replace(/\*\*/g, '').trim();
      const m = full.match(/^(.*?)\s*\((.+)\)\s*$/);
      cur = { app: (m ? m[1] : full).trim(), note: m ? m[2].trim() : '', todo: [], doneItems: [] };
      boards[board].push(cur);
      continue;
    }
    const it = raw.match(/^[-*]\s+\[([ xX~])\]\s+(.+?)\s*$/);
    if (it && cur) {
      const text = it[2].replace(/\*\*/g, '').trim();
      if (it[1] === ' ' || it[1] === '~') cur.todo.push(text);
      else cur.doneItems.push(text);
    }
  }
  return {
    actions: finalize(boards.actions),
    rc: finalize(boards.rc),
    play: finalize(boards.play),
    asc: finalize(boards.asc),
  };
}

const sumTotals = groups =>
  groups.reduce((t, g) => ({ open: t.open + g.open, done: t.done + g.done }), { open: 0, done: 0 });

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
const parsed = parse(md);
const board = (title, groups) => ({ title, totals: sumTotals(groups), groups });
const doc = {
  updatedAt: new Date().toISOString(),
  source: 'app-action-items.md',
  // Backward-compatible top-level = the general action backlog.
  totals: sumTotals(parsed.actions),
  groups: parsed.actions,
  boards: {
    rc: board('RevenueCat', parsed.rc),
    play: board('Play Console', parsed.play),
    asc: board('App Store Connect', parsed.asc),
  },
};

const line = (name, gs) => `${name}: ${gs.length} groups · ${sumTotals(gs).open} open · ${sumTotals(gs).done} done`;
const summary = [line('actions', parsed.actions), line('rc', parsed.rc), line('play', parsed.play), line('asc', parsed.asc)].join('\n');

if (process.argv.includes('--dry')) {
  console.log(JSON.stringify(doc, null, 2));
  console.log('\n' + summary);
} else {
  await putKV(doc);
  console.log('Pushed action-items —\n' + summary);
}
