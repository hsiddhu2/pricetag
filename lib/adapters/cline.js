'use strict';
// Cline, Roo Code and Kilo Code (VS Code extensions) and the Cline CLI.
//
// Extension tasks: <globalStorage>/<extension-id>/tasks/<taskId>/ui_messages.json holds
// rows {ts, type:"say", say:"api_req_started", text:"<JSON>", modelInfo?}. The text JSON
// carries tokensIn, tokensOut, cacheReads, cacheWrites, cost. The file is rewritten in
// place as usage arrives.
//   Cline:    tokensIn is already the uncached count (disjoint buckets).
//   Roo/Kilo: tokensIn includes cache reads and writes for rows dated 2025-11-02 or later.
// Working directory: Cline keeps it in <globalStorage>/<ext>/state/taskHistory.json
// (cwdOnTaskInitialization); Roo in tasks/<id>/history_item.json (workspace). Fallback is the
// "Current Workspace Directory (...)" line in api_conversation_history.json.
//
// Cline CLI and Cline 4.x: <sessions>/<id>/<id>.messages.json with assistant messages that
// carry metrics {inputTokens (cache-inclusive), outputTokens, cacheReadTokens, cacheWriteTokens,
// cost}; <id>.json has cwd. Sessions dir: $CLINE_SESSION_DATA_DIR, else $CLINE_DATA_DIR/sessions,
// else $CLINE_DIR/data/sessions, else ~/.cline/data/sessions.
// Verified against cline/cline (message-translator.ts, session persistence), RooCodeInc/Roo-Code
// (Task.ts), tokscale and codeburn.

const fs = require('fs');
const path = require('path');
const u = require('./util');

const ROO_CUTOFF = Date.parse('2025-11-02');
const ROO_GROSS = (ts, t) => ts >= ROO_CUTOFF || t.apiProtocol === 'openai';

const EXTENSIONS = [
  { id: 'saoudrizwan.claude-dev', agent: 'cline', gross: () => false },
  // Roo and Kilo report gross input (cache included) since v3.29.5 (2025-11-02). Before that
  // only rows sent over the OpenAI protocol were gross.
  { id: 'rooveterinaryinc.roo-cline', agent: 'roo', gross: ROO_GROSS },
  { id: 'kilocode.kilo-code', agent: 'kilo', gross: ROO_GROSS },
];

function sessionsDir() {
  if (process.env.CLINE_SESSION_DATA_DIR) return process.env.CLINE_SESSION_DATA_DIR;
  if (process.env.CLINE_DATA_DIR) return path.join(process.env.CLINE_DATA_DIR, 'sessions');
  return path.join(process.env.CLINE_DIR || path.join(u.home(), '.cline'), 'data', 'sessions');
}

// Returns [{ dir, agent, gross, kind }]
function sources() {
  const out = [];
  for (const base of u.vscodeGlobalStorage()) {
    for (const ext of EXTENSIONS) {
      const tasks = path.join(base, ext.id, 'tasks');
      if (u.isDir(tasks)) out.push({ dir: tasks, agent: ext.agent, gross: ext.gross, kind: 'tasks', state: path.join(base, ext.id, 'state', 'taskHistory.json') });
    }
  }
  const sess = sessionsDir();
  if (u.isDir(sess)) out.push({ dir: sess, agent: 'cline', kind: 'sessions' });
  return out;
}

function roots() { return sources().map(s => s.dir); }

const WS_RE = /Current Workspace Directory \((.+?)\)|Working Directory:\s*(\S+)/;
const MODEL_RE = /<model>([^<]+)<\/model>/;

// Reads the head of api_conversation_history.json once for the workspace path and the
// model Roo records in its environment details. Nothing from it is kept.
function headOfHistory(taskDir) {
  try {
    const fd = fs.openSync(path.join(taskDir, 'api_conversation_history.json'), 'r');
    const buf = Buffer.alloc(256 * 1024);
    const len = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, len);
  } catch { return ''; }
}

function cwdForTask(taskDir, taskId, src, history, head) {
  const hist = u.readJson(path.join(taskDir, 'history_item.json'));
  if (hist && hist.workspace) return hist.workspace;
  if (history && history.get(taskId)) return history.get(taskId);
  const m = head.match(WS_RE);
  return m ? (m[1] || m[2]) : null;
}

function parseTask(taskDir, src, history, seen) {
  const out = [];
  const msgs = u.readJson(path.join(taskDir, 'ui_messages.json'));
  if (!Array.isArray(msgs)) return out;
  const taskId = path.basename(taskDir);
  const meta = u.readJson(path.join(taskDir, 'task_metadata.json')) || {};
  const modelUsage = Array.isArray(meta.model_usage) ? meta.model_usage.slice().sort((a, b) => a.ts - b.ts) : [];
  const histModel = history && history.getModel ? history.getModel(taskId) : null;
  let cwd, head;
  const tagModel = () => { if (head === undefined) head = headOfHistory(taskDir); const m = head.match(MODEL_RE); return m ? m[1].trim() : null; };
  for (const row of msgs) {
    if (row.say !== 'api_req_started' || typeof row.text !== 'string') continue;
    let t; try { t = JSON.parse(row.text); } catch { continue; }
    const ts = u.n(row.ts);
    if (!ts) continue;
    const key = `${src.agent}:${taskId}:${ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cacheRead = u.n(t.cacheReads), cacheWrite = u.n(t.cacheWrites);
    let input = u.n(t.tokensIn);
    if (src.gross && src.gross(ts, t)) input = Math.max(0, input - cacheRead - cacheWrite);
    const usage = { input, output: u.n(t.tokensOut), cacheRead, cacheWrite };
    if (!(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)) continue;
    let model = row.modelInfo && row.modelInfo.modelId;
    if (!model) { const m = modelUsage.filter(x => x.ts <= ts).pop() || modelUsage[0]; model = m && m.model_id; }
    model = model || histModel || tagModel() || 'unknown';
    if (cwd === undefined) { if (head === undefined) head = headOfHistory(taskDir); cwd = cwdForTask(taskDir, taskId, src, history, head); }
    out.push({ agent: src.agent, ts, model, cwd, branch: null, sessionId: taskId, usage, reported: t.cost > 0 ? { cost: u.n(t.cost) } : undefined });
  }
  return out;
}

function loadHistory(file) {
  const arr = u.readJson(file);
  const map = new Map();
  const models = new Map();
  if (Array.isArray(arr)) for (const h of arr) { if (h && h.id) { if (h.cwdOnTaskInitialization) map.set(String(h.id), h.cwdOnTaskInitialization); if (h.modelId) models.set(String(h.id), h.modelId); } }
  map.getModel = id => models.get(id) || null;
  return map;
}

function parseSession(sessDir, seen) {
  const out = [];
  const id = path.basename(sessDir);
  const manifest = u.readJson(path.join(sessDir, `${id}.json`)) || {};
  const data = u.readJson(path.join(sessDir, `${id}.messages.json`));
  if (!data || !Array.isArray(data.messages)) return out;
  for (const m of data.messages) {
    if (m.role !== 'assistant' || !m.metrics) continue;
    const ts = u.n(m.ts);
    if (!ts) continue;
    const key = `cline-cli:${id}:${m.id || ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const k = m.metrics;
    const cacheRead = u.n(k.cacheReadTokens), cacheWrite = u.n(k.cacheWriteTokens);
    const usage = { input: Math.max(0, u.n(k.inputTokens) - cacheRead - cacheWrite), output: u.n(k.outputTokens), cacheRead, cacheWrite };
    if (!(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)) continue;
    out.push({ agent: 'cline', ts, model: (m.modelInfo && m.modelInfo.id) || manifest.model || 'unknown', cwd: manifest.cwd || manifest.workspace_root || null, branch: null, sessionId: id, usage, reported: k.cost > 0 ? { cost: u.n(k.cost) } : undefined });
  }
  return out;
}

function load({ since = 0, dirs = null } = {}) {
  const srcs = dirs ? dirs.map(d => (typeof d === 'string' ? { dir: d, agent: 'cline', gross: () => false, kind: 'tasks' } : d)) : sources();
  const seen = new Set();
  const events = [];
  for (const src of srcs) {
    let entries = [];
    try { entries = fs.readdirSync(src.dir, { withFileTypes: true }); } catch { continue; }
    const history = src.kind === 'tasks' && src.state ? loadHistory(src.state) : null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const d = path.join(src.dir, e.name);
      const probe = src.kind === 'sessions' ? path.join(d, `${e.name}.messages.json`) : path.join(d, 'ui_messages.json');
      if (!u.isFile(probe) || !u.fresh(probe, since)) continue;
      const evs = src.kind === 'sessions' ? parseSession(d, seen) : parseTask(d, src, history, seen);
      for (const ev of evs) if (ev.ts >= since) events.push(ev);
    }
  }
  return events;
}

module.exports = { name: 'cline', extensions: ['ui_messages.json', '.messages.json'], roots, sources, load, parseTask, parseSession };
