'use strict';
// OpenCode (sst/opencode). Usage lives in a SQLite database:
//   $OPENCODE_DATA_DIR, else $XDG_DATA_HOME/opencode, else ~/.local/share/opencode (all OSes)
//   opencode.db (channel builds: opencode-<channel>.db), WAL mode
// Two generations coexist after an upgrade:
//   V2: session_message(id, session_id, time_created, data) + session_v2(id, directory, time_created, fork_boundary)
//   V1: message(id, session_id, time_created, data)         + session(id, directory, time_created)
// data is JSON. Assistant rows carry tokens {input, output, reasoning, cache:{read, write}},
// cost, and the model (V2: model.id / model.providerID, V1: modelID / providerID).
// tokens.input is already the non-cached count. Reasoning tokens are billed as output.
// Forked sessions copy the parent's rows: rows older than their session are skipped.
//
// Reading SQLite without a dependency: node:sqlite (Node 22.5+). On older Node the
// `sqlite3` CLI is used if present, otherwise the pre-SQLite JSON files are read.
// Verified against sst/opencode packages/core (database schema, session/usage.ts),
// ccusage's opencode loader and codeburn's sqlite reader.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const u = require('./util');

function dataDir() {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR;
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg && xdg.trim() ? xdg : path.join(u.home(), '.local', 'share'), 'opencode');
}

function roots() { return [dataDir()].filter(u.isDir); }

function dbFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(f => /^opencode(-[\w.]+)?\.db$/.test(f)).map(f => path.join(dir, f));
}

const Q = `
SELECT m.id, m.session_id, m.time_created, s.directory AS directory, s.time_created AS session_created, CAST(m.data AS BLOB) AS data
FROM session_message m JOIN session_v2 s ON s.id = m.session_id
WHERE m.time_created >= ?
UNION ALL
SELECT m.id, m.session_id, m.time_created, s.directory, s.time_created, CAST(m.data AS BLOB)
FROM message m JOIN session s ON s.id = m.session_id
WHERE m.time_created >= ?`;

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function queryNode(file, since) {
  let sqlite;
  try {
    const w = process.emitWarning;
    process.emitWarning = (msg, ...rest) => { if (!/SQLite/i.test(String(msg))) w.call(process, msg, ...rest); };
    try { sqlite = require('node:sqlite'); } finally { process.emitWarning = w; }
  } catch { return null; }
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    try { db.exec('PRAGMA busy_timeout = 1500'); } catch { /* older node */ }
    const v2 = hasTable(db, 'session_message') && hasTable(db, 'session_v2');
    const v1 = hasTable(db, 'message') && hasTable(db, 'session');
    const parts = [];
    if (v2) parts.push(Q.split('UNION ALL')[0]);
    if (v1) parts.push(Q.split('UNION ALL')[1]);
    if (!parts.length) return [];
    const dec = new TextDecoder('utf-8', { fatal: false });
    return db.prepare(parts.join(' UNION ALL ')).all(...parts.map(() => since)).map(r => ({ ...r, data: dec.decode(r.data) }));
  } finally { db.close(); }
}

function queryCli(file, since) {
  const sql = Q.replace(/\?/g, String(Math.floor(since)));
  let out;
  try { out = execFileSync('sqlite3', ['-readonly', '-json', file, sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); } catch { return null; }
  try { return JSON.parse(out || '[]'); } catch { return []; }
}

function rowsToEvents(rows, file, seen = new Set()) {
  const out = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;             // V1 rows copied into V2 on upgrade
    seen.add(r.id);
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    const role = d.role || d.type;
    if (role !== 'assistant' || !d.tokens) continue;
    if (r.session_created && r.time_created < r.session_created) continue;     // fork copy of parent history
    const t = d.tokens, c = t.cache || {};
    const usage = { input: u.n(t.input), output: u.n(t.output) + u.n(t.reasoning), cacheRead: u.n(c.read), cacheWrite: u.n(c.write) };
    if (!(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)) continue;
    const model = (d.model && d.model.id) || d.modelID || 'unknown';
    const ts = u.n(r.time_created) || u.n(d.time && d.time.created);
    if (!ts) continue;
    out.push({ agent: 'opencode', ts, model, cwd: r.directory || (d.path && d.path.cwd) || null, branch: null, sessionId: r.session_id,
      usage, reported: d.cost > 0 ? { cost: u.n(d.cost) } : undefined, _src: file });
  }
  return out;
}

// Pre-SQLite layout: storage/message/<session>/<message>.json + storage/session/<project>/<session>.json
function loadLegacy(dir, since) {
  const msgDir = path.join(dir, 'storage', 'message');
  if (!u.isDir(msgDir)) return [];
  const sessions = new Map();
  for (const f of u.walk(path.join(dir, 'storage', 'session'), ['.json'])) {
    const s = u.readJson(f);
    if (s && s.id) sessions.set(s.id, s);
  }
  const rows = [];
  for (const f of u.walk(msgDir, ['.json'])) {
    if (!u.fresh(f, since)) continue;
    const d = u.readJson(f);
    if (!d || d.role !== 'assistant') continue;
    const s = sessions.get(d.sessionID) || {};
    rows.push({ id: d.id, session_id: d.sessionID, time_created: d.time && d.time.created, directory: s.directory, session_created: s.time && s.time.created, data: JSON.stringify(d) });
  }
  return rowsToEvents(rows, msgDir).filter(e => e.ts >= since);
}

function readerAvailable() {
  try { require('node:sqlite'); return 'node:sqlite'; } catch { /* no */ }
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return 'sqlite3'; } catch { return null; }
}

function load({ since = 0, dirs = roots() } = {}) {
  const events = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const file of dbFiles(dir)) {
      if (!u.fresh(file, since) && !u.fresh(file + '-wal', since)) continue;
      let rows = queryNode(file, since);
      if (rows == null) rows = queryCli(file, since);
      if (rows == null) continue;                       // no reader on this Node; doctor explains
      for (const ev of rowsToEvents(rows, file, seen)) if (ev.ts >= since) events.push(ev);
    }
    events.push(...loadLegacy(dir, since));
  }
  return events;
}

module.exports = { name: 'opencode', extensions: ['.db', '.json'], roots, load, readerAvailable, rowsToEvents };
