'use strict';
const path = require('path');
const pricing = require('./pricing');

const FOLD = process.platform === 'win32' || process.platform === 'darwin';
function canon(p) {
  let r = path.resolve(p);
  try { r = require('fs').realpathSync.native(r); } catch { /* path may not exist any more */ }
  return FOLD ? r.toLowerCase() : r;
}
function underRepo(cwd, repoRoot) {
  if (!cwd || !repoRoot) return false;
  const a = canon(cwd), b = canon(repoRoot);
  return a === b || a.startsWith(b + path.sep);
}

// Aggregate usage events into one summary.
function summarize(events, { table } = {}) {
  const tbl = table || pricing.loadTable();
  const s = {
    cost: 0, unpricedTokens: 0, tokens: 0,
    input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
    models: {}, agents: {}, sessions: new Set(), minutes: new Set(), messages: 0,
    credits: 0, reportedCost: 0, reportedTokens: 0,
    first: null, last: null,
  };
  for (const e of events) {
    const u = e.usage;
    const total = u.input + u.output + u.cacheWrite + u.cacheRead;
    const c = pricing.price(e.model, u, tbl);
    s.tokens += total;
    s.input += u.input; s.output += u.output; s.cacheWrite += u.cacheWrite; s.cacheRead += u.cacheRead;
    s.messages += 1;
    s.agents[e.agent || 'unknown'] = true;
    if (e.reported) {
      if (e.reported.credits) s.credits += e.reported.credits;
      if (e.reported.cost) { s.reportedCost += e.reported.cost; s.reportedTokens += total; }
    }
    const m = s.models[e.model] || (s.models[e.model] = { tokens: 0, cost: 0, priced: c != null });
    m.tokens += total;
    if (c != null) { s.cost += c; m.cost += c; } else s.unpricedTokens += total;
    s.sessions.add(e.sessionId);
    s.minutes.add(Math.floor(e.ts / 60000));
    if (s.first == null || e.ts < s.first) s.first = e.ts;
    if (s.last == null || e.ts > s.last) s.last = e.ts;
  }
  return {
    ...s,
    sessions: s.sessions.size,
    activeMinutes: s.minutes.size,
    minutes: undefined,
  };
}

// Events for one repo in a time window.
function select(events, { repoRoot, since = 0, until = Infinity, branch = null }) {
  return events.filter(e =>
    e.ts >= since && e.ts <= until &&
    underRepo(e.cwd, repoRoot) &&
    (!branch || !e.branch || e.branch === branch)
  );
}

module.exports = { summarize, select, underRepo, canon };
