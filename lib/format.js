'use strict';
const pricing = require('./pricing');

const KEY = 'Agent-Usage';

function money(n) {
  if (n == null) return '?';
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function minutes(m) {
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

function shortModel(m) {
  return pricing.normalize(String(m)).replace(/^claude-/, '');
}

// How the dollar figure is labelled, by plan. Tokens are the fact, dollars are context.
//   api          -> "$1.42 est."         (you pay per token, this is close to your bill)
//   subscription -> "~$1.42 API-equiv"   (flat plan, this is what it would cost on the API)
//   auto         -> same as subscription (the safe default)
function costLabel(sum, plan = 'auto') {
  const unpriced = sum.unpricedTokens > 0;
  if (!sum.cost && unpriced) return '? (unpriced model)';
  const base = money(sum.cost) + (unpriced ? '+?' : '');
  return plan === 'api' ? `${base} est.` : `~${base} API-equiv`;
}

function agentsLabel(sum) {
  const agents = Object.keys(sum.agents || {});
  const models = [...new Set(Object.keys(sum.models).map(shortModel))];
  if (agents.length === 1) return `${agents[0]}/${models.join('+')}`;
  return agents.join('+') || models.join('+');
}

// Trailer value: "2.1M tok (1.8M cached) | 38m | claude-code/sonnet-5-5 | ~$1.42 API-equiv"
function trailer(sum, { plan = 'auto' } = {}) {
  if (!sum.tokens) return null;
  const cached = sum.cacheRead + sum.cacheWrite;
  const tok = `${tokens(sum.tokens)} tok` + (cached ? ` (${tokens(cached)} cached)` : '');
  return `${tok} | ${minutes(sum.activeMinutes)} | ${agentsLabel(sum)} | ${costLabel(sum, plan)}`;
}

const TRAILER_RE = /^([\d.]+)([kMB]?) tok(?: \(([\d.]+)([kMB]?) cached\))?\s*\|\s*(?:(\d+)h\s*)?(\d+)m\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;
const MULT = { '': 1, k: 1e3, M: 1e6, B: 1e9 };

function parseTrailer(v) {
  if (!v) return null;
  const m = String(v).trim().match(TRAILER_RE);
  if (!m) return null;
  const costPart = m[8];
  let cost = null, uncertain = false;
  const cm = costPart.match(/\$(?:([\d.]+)|(<0\.01))/) || costPart.match(/<\$0\.01/);
  if (cm) cost = cm[1] != null ? Number(cm[1]) : 0.005;
  if (/\?/.test(costPart)) uncertain = true;
  if (cost == null) uncertain = true;
  return {
    tokens: Math.round(Number(m[1]) * MULT[m[2]]),
    cached: m[3] ? Math.round(Number(m[3]) * MULT[m[4]]) : 0,
    minutes: (m[5] ? Number(m[5]) * 60 : 0) + Number(m[6]),
    agents: m[7].split('+').map(s => s.split('/')[0]),
    models: m[7].split('+').map(s => s.split('/').slice(1).join('/')).filter(Boolean),
    cost, uncertain,
    plan: /API-equiv/.test(costPart) ? 'subscription' : 'api',
  };
}

// Fold a previous trailer (from --amend) into a fresh summary.
function mergeIntoSummary(prev, sum) {
  const agents = { ...(sum.agents || {}) };
  for (const a of prev.agents) if (a && !agents[a]) agents[a] = true;
  const models = { ...sum.models };
  for (const m of prev.models) if (m && !Object.keys(models).some(k => shortModel(k) === m)) models[m] = { tokens: 0, cost: 0, priced: true };
  return {
    ...sum,
    tokens: sum.tokens + prev.tokens,
    cacheRead: sum.cacheRead + prev.cached,
    cost: sum.cost + (prev.cost || 0),
    unpricedTokens: sum.unpricedTokens + (prev.cost == null ? prev.tokens : 0),
    activeMinutes: sum.activeMinutes + prev.minutes,
    agents, models,
  };
}

function pad(s, w, right = false) {
  s = String(s);
  return right ? s.padStart(w) : s.padEnd(w);
}

// Render rows as an aligned text table. cols: [{key, label, right}]
function table(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(r[c.key] ?? '').length)));
  const line = cols.map((c, i) => pad(c.label, widths[i], c.right)).join('  ');
  const out = ['  ' + line, '  ' + cols.map((c, i) => '-'.repeat(widths[i])).join('  ')];
  for (const r of rows) out.push('  ' + cols.map((c, i) => pad(r[c.key] ?? '', widths[i], c.right)).join('  '));
  return out.join('\n');
}

function csv(rows, cols) {
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => esc(c.label)).join(','), ...rows.map(r => cols.map(c => esc(r[c.key])).join(','))].join('\n');
}

module.exports = { KEY, money, tokens, minutes, shortModel, costLabel, trailer, parseTrailer, mergeIntoSummary, table, csv };
