'use strict';
// OpenAI Codex CLI. Reads rollout files under $CODEX_HOME (default ~/.codex):
//   sessions/YYYY/MM/DD/rollout-*.jsonl and archived_sessions/*.jsonl
// Newer builds may write a compressed sibling rollout-*.jsonl.zst for old files; the
// plain file wins when both exist, and .zst needs Node 22.15+ (zlib zstd).
//
// Usage records, in order of preference:
//   1. type=token_usage_record, one per API response, keyed by payload.response_id
//   2. type=event_msg with payload.type=token_count: info.last_token_usage, which is
//      re-emitted unchanged on rate-limit updates, so repeats are skipped
// cached_input_tokens is a subset of input_tokens, reasoning is a subset of output.
// Verified against openai/codex (codex-rs/protocol, core/src/session) and ccusage's codex parser.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const u = require('./util');

function roots() {
  const env = process.env.CODEX_HOME;
  const base = env && env.trim() ? env.trim() : path.join(u.home(), '.codex');
  return ['sessions', 'archived_sessions'].map(d => path.join(base, d)).filter(u.isDir);
}

function usageOf(t) {
  if (!t) return null;
  const cached = u.n(t.cached_input_tokens);
  return {
    input: Math.max(0, u.n(t.input_tokens) - cached),
    output: u.n(t.output_tokens),
    cacheRead: cached,
    cacheWrite: u.n(t.cache_write_input_tokens),
  };
}

function readText(file) {
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return null;
    try { return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'); } catch { return null; }
  }
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function parseFile(file, seen = new Set()) {
  const out = [];
  const text = readText(file);
  if (text == null) return out;
  let cwd = null, model = null, sessionId = path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
  let hasRecords = text.includes('"token_usage_record"');
  let lastTotal = null;
  for (const e of u.jsonl(text)) {
    const p = e.payload || {};
    if (e.type === 'session_meta') { cwd = p.cwd || cwd; sessionId = p.id || p.session_id || sessionId; continue; }
    if (e.type === 'turn_context') { cwd = p.cwd || cwd; model = p.model || model; continue; }
    let usage = null, key = null;
    if (e.type === 'token_usage_record') {
      usage = usageOf(p.usage);
      key = `rec:${p.response_id || ''}`;
    } else if (!hasRecords && e.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const total = JSON.stringify(p.info.total_token_usage || null);
      if (total === lastTotal) continue;            // re-emitted on rate-limit updates
      lastTotal = total;
      usage = usageOf(p.info.last_token_usage);
      key = `tc:${sessionId}:${e.timestamp}:${total}`;
    } else continue;
    if (!usage || !(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)) continue;
    if (key && key !== 'rec:' && seen.has(key)) continue;
    if (key) seen.add(key);
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    out.push({ agent: 'codex', ts, model: model || 'unknown', cwd, branch: null, sessionId, usage });
  }
  return out;
}

function load({ since = 0, dirs = roots() } = {}) {
  const seen = new Set();
  const events = [];
  for (const root of dirs) {
    const files = [...u.walk(root, ['.jsonl', '.jsonl.zst'])];
    const plain = new Set(files.filter(f => f.endsWith('.jsonl')));
    for (const file of files) {
      if (file.endsWith('.zst') && plain.has(file.slice(0, -4))) continue;
      if (!u.fresh(file, since)) continue;
      for (const ev of parseFile(file, seen)) if (ev.ts >= since) events.push(ev);
    }
  }
  return events;
}

module.exports = { name: 'codex', extensions: ['.jsonl', '.jsonl.zst'], roots, load, parseFile };
