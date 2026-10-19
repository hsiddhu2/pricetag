'use strict';
// Prices are USD per 1M tokens. These are list prices and will drift.
// Run `pricetag prices --update` to refresh from LiteLLM's public table,
// or override with ~/.pricetag/prices.json. Unknown models are counted
// but priced as "?" so the number is never silently wrong.

const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILTIN = {
  // key: substring matched against the model id (longest match wins)
  'claude-opus-4-1':   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4':     { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-5': { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-4':   { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude-haiku-4-5':  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
  'claude-3-7-sonnet': { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude-3-5-haiku':  { input: 0.8, output: 4, cacheWrite: 1,     cacheRead: 0.08 },
  'gpt-5-mini':        { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
  'gpt-5':             { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  'o4-mini':           { input: 1.1, output: 4.4, cacheWrite: 1.1, cacheRead: 0.275 },
  'gemini-2.5-pro':    { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.31 },
  'gemini-2.5-flash':  { input: 0.3, output: 2.5, cacheWrite: 0.3, cacheRead: 0.075 },
};

const USER_FILE = path.join(os.homedir(), '.pricetag', 'prices.json');

function loadTable() {
  let table = { ...BUILTIN };
  try { table = { ...table, ...require('./prices.json') }; } catch (_) { /* no snapshot */ }
  try {
    if (fs.existsSync(USER_FILE)) {
      const user = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
      table = { ...table, ...user };
    }
  } catch (_) { /* ignore a broken override file */ }
  return table;
}

function lookup(model, table = loadTable()) {
  if (!model) return null;
  const m = normalize(String(model).toLowerCase());
  if (table[m]) return table[m];
  let best = null;
  for (const key of Object.keys(table)) {
    if (key.startsWith('_')) continue;
    const k = key.toLowerCase();
    // prefix on a word boundary with a non-numeric suffix, e.g. "claude-opus-5-5" matches
    // "claude-opus-5-5-fast" but never "claude-opus-5-55" or a newer "claude-opus-5-5-1".
    const rest = m.startsWith(k + '-') ? m.slice(k.length + 1) : null;
    if (rest !== null && !/^\d/.test(rest) && (!best || k.length > best.length)) best = k;
  }
  return best ? table[best] : null;
}

// usage: { input, output, cacheWrite, cacheRead } token counts
// Date of the newest price table in use (user override or bundled snapshot).
function asOf() {
  try { const u = JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); if (u._asOf) return u._asOf; } catch { /* none */ }
  try { return require('./prices.json')._asOf || 'unknown'; } catch { return 'unknown'; }
}

function price(model, usage, table) {
  const p = lookup(model, table);
  if (!p) return null;
  return (
    (usage.input      || 0) * p.input      +
    (usage.output     || 0) * p.output     +
    (usage.cacheWrite || 0) * p.cacheWrite +
    (usage.cacheRead  || 0) * p.cacheRead
  ) / 1e6;
}

// Normalize provider-specific ids to the bare model name:
// "bedrock/us.anthropic.claude-opus-5-5-v1:0" -> "claude-opus-5-5"
function normalize(name) {
  let n = String(name)
    .replace(/\[\d+[mk]\]$/i, '')
    .replace(/^.*\//, '')
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '');
  // Copilot and some gateways write claude-sonnet-4.5; the table uses claude-sonnet-4-5.
  if (/^claude-/.test(n)) n = n.replace(/(\d)\.(\d)/g, '$1-$2');
  return n;
}

// Convert LiteLLM's table (per-token prices) into our per-1M shape.
// Several provider entries map to one bare name; the plain Anthropic entry wins,
// then anthropic./us. Bedrock ids, then others. Entries with no cache prices lose
// to entries that have them. Dotted versions (claude-opus-4.5) are dropped when a
// dashed form exists.
function fromLiteLLM(json) {
  const rank = name => {
    if (!/[/.:]/.test(name.replace(/\d\.\d/g, ''))) return 0;        // plain
    if (/^anthropic\./.test(name)) return 1;
    if (/^(us|global)\.anthropic\./.test(name)) return 2;
    if (/^bedrock\//.test(name)) return 3;
    return 4;
  };
  const best = {};
  for (const [name, v] of Object.entries(json)) {
    if (!v || typeof v !== 'object' || v.input_cost_per_token == null) continue;
    if (!/claude|gpt|^o[1-9]|gemini/.test(name)) continue;
    const key = normalize(name);
    const hasCache = v.cache_read_input_token_cost != null;
    const score = rank(name) + (hasCache ? 0 : 10);
    const date = Number((name.match(/(\d{8})/) || [])[1] || 0);   // newer dated entry wins a tie
    const b = best[key];
    if (b && (b.score < score || (b.score === score && b.date >= date))) continue;
    best[key] = { score, date, v };
  }
  const out = {};
  const r = n => Math.round(n * 1e6 * 1e4) / 1e4;
  for (const [key, { v }] of Object.entries(best)) {
    if (/\d\.\d/.test(key) && best[key.replace(/(\d)\.(\d)/g, '$1-$2')]) continue;
    out[key] = {
      input: r(v.input_cost_per_token),
      output: r(v.output_cost_per_token || 0),
      cacheWrite: r(v.cache_creation_input_token_cost ?? v.input_cost_per_token),
      // No published cache price: assume the common 0.1x of input rather than full price.
      cacheRead: r(v.cache_read_input_token_cost ?? v.input_cost_per_token * 0.1),
    };
  }
  return out;
}

module.exports = { BUILTIN, USER_FILE, loadTable, lookup, price, fromLiteLLM, normalize, asOf };
