'use strict';
const fs = require('fs');
const path = require('path');
const attribute = require('./attribute');
const config = require('./config');

// Parse "30d", "12h", "2026-10-01" or an epoch into ms.
function parseSince(v, now = Date.now()) {
  if (!v) return now - 30 * 864e5;
  const m = String(v).match(/^(\d+)([dhwmy])$/);
  if (m) return now - Number(m[1]) * { d: 864e5, h: 36e5, w: 7 * 864e5, m: 30 * 864e5, y: 365 * 864e5 }[m[2]];
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return t;
  throw new Error(`cannot parse --since "${v}" (use 12h, 30d, 2w, 3m, 1y or a date)`);
}

// Find the git repo root for a directory, walking up. Cached per call site.
function repoRootOf(dir, cache) {
  if (!dir) return null;
  if (cache.has(dir)) return cache.get(dir);
  let cur = path.resolve(dir);
  let found = null;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) { found = cur; break; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  cache.set(dir, found);
  return found;
}

const GROUPS = ['repo', 'client', 'branch', 'agent', 'model', 'day', 'session'];

function keyFor(e, by, ctx) {
  switch (by) {
    case 'repo': return repoRootOf(e.cwd, ctx.cache) || e.cwd || '(unknown)';
    case 'client': return config.clientFor(repoRootOf(e.cwd, ctx.cache)) || '(no client)';
    case 'branch': return e.branch || '(unknown)';
    case 'agent': return e.agent;
    case 'model': return e.model;
    case 'day': return new Date(e.ts).toISOString().slice(0, 10);
    case 'session': return `${e.agent}:${e.sessionId}`;
    default: throw new Error(`unknown --by "${by}" (use ${GROUPS.join(', ')})`);
  }
}

// events -> [{ key, summary }] sorted by cost desc then tokens desc.
function group(events, by, { table } = {}) {
  const ctx = { cache: new Map() };
  const buckets = new Map();
  for (const e of events) {
    const k = keyFor(e, by, ctx);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  const rows = [...buckets.entries()].map(([key, evs]) => ({ key, summary: attribute.summarize(evs, { table }) }));
  rows.sort((a, b) => (b.summary.cost - a.summary.cost) || (b.summary.tokens - a.summary.tokens));
  return rows;
}

module.exports = { parseSince, repoRootOf, group, GROUPS };
