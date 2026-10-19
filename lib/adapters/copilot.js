'use strict';
// GitHub Copilot CLI. Reads $COPILOT_HOME (default ~/.copilot)/session-state/<id>/events.jsonl.
// Token usage is written once per session leg in the session.shutdown event
// (data.modelMetrics[model].usage), cumulative across --resume legs within the same file,
// and reset by session.compaction_complete. So usage is session-granular: a session that
// spans a commit is attributed to the commit after it ends. inputTokens includes cache
// reads and writes. totalNanoAiu / 1e9 is the AI credit count GitHub bills (1 credit = $0.01).
// Only the five event types used here are parsed. Verified against ccusage's copilot
// parser and redacted real session files.

const path = require('path');
const fs = require('fs');
const u = require('./util');

function roots() {
  const env = process.env.COPILOT_HOME;
  const base = env && env.trim() ? env.trim() : path.join(u.home(), '.copilot');
  return [path.join(base, 'session-state')].filter(u.isDir);
}

function cleanModel(m) { return String(m).replace(/-1m(-internal)?$/, ''); }

function parseFile(file) {
  const out = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  let cwd = null, sessionId = path.basename(path.dirname(file));
  let baseline = {};                      // model -> last usage seen at a shutdown
  const sub = (a, b) => Math.max(0, u.n(a) - u.n(b));
  for (const e of u.jsonl(text)) {
    const d = e.data || {};
    if (e.type === 'session.start') { cwd = (d.context && d.context.cwd) || cwd; sessionId = d.sessionId || sessionId; continue; }
    if (e.type === 'session.compaction_complete' && d.success !== false) { baseline = {}; continue; }
    if (e.type !== 'session.shutdown' || !d.modelMetrics) continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    for (const [model, m] of Object.entries(d.modelMetrics)) {
      const us = m.usage || {};
      const prev = baseline[model] || {};
      const input = sub(us.inputTokens, prev.inputTokens);
      const output = sub(us.outputTokens, prev.outputTokens);
      const cacheRead = sub(us.cacheReadTokens, prev.cacheReadTokens);
      const cacheWrite = sub(us.cacheWriteTokens, prev.cacheWriteTokens);
      const credits = sub(m.totalNanoAiu, prev.totalNanoAiu) / 1e9;
      baseline[model] = { ...us, totalNanoAiu: m.totalNanoAiu };
      const usage = { input: Math.max(0, input - cacheRead - cacheWrite), output, cacheRead, cacheWrite };
      if (!(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)) continue;
      out.push({ agent: 'copilot', ts, model: cleanModel(model), cwd, branch: null, sessionId, usage, reported: { credits } });
    }
  }
  if (!cwd) {
    const ws = u.readYamlCwd(path.join(path.dirname(file), 'workspace.yaml'));
    if (ws) for (const ev of out) ev.cwd = ws;
  }
  return out;
}

function load({ since = 0, dirs = roots() } = {}) {
  const events = [];
  for (const root of dirs) {
    for (const file of u.walk(root, ['events.jsonl'])) {
      if (!u.fresh(file, since)) continue;
      for (const ev of parseFile(file)) if (ev.ts >= since) events.push(ev);
    }
  }
  return events;
}

module.exports = { name: 'copilot', extensions: ['events.jsonl'], roots, load, parseFile };
