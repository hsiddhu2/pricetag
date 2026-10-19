'use strict';
// Reads Claude Code's local transcripts (~/.claude/projects/**/*.jsonl).
// Emits one usage event per assistant message. No network, no prompt text.

const fs = require('fs');
const path = require('path');
const os = require('os');

function roots() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const list = [];
  if (env) for (const d of env.split(',')) list.push(path.join(d.trim(), 'projects'));
  list.push(path.join(os.homedir(), '.claude', 'projects'));
  list.push(path.join(os.homedir(), '.config', 'claude', 'projects'));
  return [...new Set(list)].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// Parse one transcript file into usage events.
function parseFile(file, seen = new Set()) {
  const out = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message;
    if (!msg || !msg.usage) continue;
    if (e.type && e.type !== 'assistant') continue;
    const u = msg.usage;
    const key = `${msg.id || ''}:${e.requestId || ''}`;
    if (key !== ':' && seen.has(key)) continue;   // streamed duplicates
    seen.add(key);
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    const n = x => Number(x) || 0;
    const usage = { input: n(u.input_tokens), output: n(u.output_tokens), cacheWrite: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens) };
    if (!(usage.input + usage.output + usage.cacheWrite + usage.cacheRead)) continue;   // <synthetic> / error rows
    if (!msg.model || msg.model === '<synthetic>') continue;
    out.push({
      agent: 'claude-code',
      ts,
      model: msg.model,
      cwd: e.cwd || null,
      branch: e.gitBranch || null,
      sessionId: e.sessionId || path.basename(file, '.jsonl'),
      usage,
    });
  }
  return out;
}

// since: ms epoch. Files not modified since then are skipped (fast path for hooks).
function load({ since = 0, dirs = roots() } = {}) {
  const seen = new Set();
  const events = [];
  for (const root of dirs) {
    for (const file of walk(root)) {
      // skip files untouched since the window start (5 min slack for clock skew)
      try { if (since && fs.statSync(file).mtimeMs < since - 300000) continue; } catch { continue; }
      for (const ev of parseFile(file, seen)) if (ev.ts >= since) events.push(ev);
    }
  }
  return events;
}

module.exports = { name: 'claude-code', load, parseFile, roots };
