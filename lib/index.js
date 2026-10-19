'use strict';
const fs = require('fs');
const path = require('path');
const claudeCode = require('./adapters/claude-code');
const attribute = require('./attribute');
const git = require('./git');
const fmt = require('./format');
const pricing = require('./pricing');
const config = require('./config');

const ADAPTERS = [claudeCode];

function loadEvents(opts) {
  return ADAPTERS.flatMap(a => a.load(opts));
}

// Agent work in this repo that no commit has claimed yet.
// `since` defaults to the HEAD commit time. A watermark in .git/pricetag-last records
// the newest event already counted, so nothing is counted twice.
function pending(cwd = process.cwd(), { branch = null, since = null, until = Infinity } = {}) {
  const root = git.repoRoot(cwd);
  if (!root) return null;
  const markFile = path.join(git.gitDir(cwd) || root, 'pricetag-last');
  let mark = 0;
  try { mark = Number(fs.readFileSync(markFile, 'utf8')) || 0; } catch { /* none */ }
  const start = Math.max(since == null ? git.headTime(cwd) : since, mark);
  const scope = config.get('scope', cwd) || root;
  const events = attribute.select(loadEvents({ since: start }), { repoRoot: scope, since: start, until, branch })
    .filter(e => e.ts > mark);
  const summary = attribute.summarize(events);
  const commit = () => { try { if (summary.last) fs.writeFileSync(markFile, String(summary.last)); } catch { /* best effort */ } };
  return { root, since: start, until, summary, commit };
}

// Sum parsed trailers of a set of commits.
function sumTrailers(commits) {
  const s = { cost: 0, tokens: 0, cached: 0, minutes: 0, uncertain: false, tagged: 0, models: new Set(), agents: new Set() };
  for (const c of commits) {
    const t = fmt.parseTrailer(c.value);
    if (!t) continue;
    s.tagged += 1;
    if (t.cost != null) s.cost += t.cost;
    s.uncertain = s.uncertain || t.uncertain;
    s.tokens += t.tokens; s.cached += t.cached; s.minutes += t.minutes;
    t.models.forEach(m => s.models.add(m));
    t.agents.forEach(a => a && s.agents.add(a));
  }
  return { ...s, models: [...s.models], agents: [...s.agents] };
}

module.exports = { loadEvents, pending, sumTrailers, attribute, git, fmt, pricing, config, ADAPTERS };
