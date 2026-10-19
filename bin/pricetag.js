#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const pt = require('../lib');
const hook = require('../lib/hook');
const report = require('../lib/report');
const doctor = require('../lib/doctor');
const { git, fmt, pricing, config } = pt;
const pkg = require('../package.json');

const REPO_URL = 'https://github.com/hsiddhu2/pricetag';

process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });

// ---- argument parsing ----
const argv = process.argv.slice(2);
if (argv[0] === '-h' || argv[0] === '--help') argv[0] = 'help';
if (argv[0] === '-v' || argv[0] === '--version') { console.log(pkg.version); process.exit(0); }
const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'status';
const flags = { _: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    const k = eq > -1 ? a.slice(2, eq) : a.slice(2);
    const v = eq > -1 ? a.slice(eq + 1) : (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    flags[k] = v;
  } else if (a === '-n') flags.n = argv[++i];
  else flags._.push(a);
}

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');
const json = (o) => out(JSON.stringify(o, null, 2));

function requireRepo() {
  const root = git.repoRoot();
  if (!root) { err('pricetag: not inside a git repository'); process.exit(2); }
  return root;
}

function plain(sum) {
  return {
    tokens: sum.tokens, input: sum.input, output: sum.output, cacheRead: sum.cacheRead, cacheWrite: sum.cacheWrite,
    unpricedTokens: sum.unpricedTokens, costUsd: Number(sum.cost.toFixed(4)), activeMinutes: sum.activeMinutes,
    sessions: sum.sessions, messages: sum.messages, agents: Object.keys(sum.agents || {}), models: Object.keys(sum.models),
    first: sum.first ? new Date(sum.first).toISOString() : null, last: sum.last ? new Date(sum.last).toISOString() : null,
  };
}

const commands = {

  // What the next commit will carry, plus recent commits.
  status() {
    requireRepo();
    const plan = config.get('plan');
    const p = pt.pending(process.cwd(), { branch: flags.branch || null });
    const s = p.summary;
    if (flags.json) return json({ pending: plain(s), mode: config.get('mode'), plan, hookInstalled: hook.installed() });
    out();
    if (s.tokens) {
      out(`  Uncommitted agent work   ${fmt.tokens(s.tokens)} tokens  (${fmt.tokens(s.cacheRead + s.cacheWrite)} cached)`);
      out(`  Active time              ${fmt.minutes(s.activeMinutes)} across ${s.sessions} session${s.sessions === 1 ? '' : 's'}`);
      out(`  Agents                   ${Object.keys(s.agents).join(', ')}  ·  ${Object.keys(s.models).map(fmt.shortModel).join(', ')}`);
      out(`  Cost                     ${fmt.costLabel(s, plan)}`);
      if (s.unpricedTokens) out(`  Unpriced                 ${fmt.tokens(s.unpricedTokens)} tokens on models with no known price (pricetag prices --update)`);
    } else {
      out('  No agent work in this repo since the last commit.');
    }
    out();
    const recent = git.commits(['-n', String(flags.n || 8)], process.cwd()).reverse();
    if (recent.length) {
      out('  Recent commits');
      for (const c of recent) {
        const t = fmt.parseTrailer(c.value);
        out(`  ${c.short}  ${(t ? fmt.tokens(t.tokens) : '–').padStart(7)}  ${(t ? fmt.money(t.cost) + (t.uncertain ? '?' : '') : '').padStart(8)}  ${c.subject.slice(0, 64)}`);
      }
      out();
    }
    const mode = config.get('mode');
    if (!hook.installed()) out('  Hooks not installed. Run: pricetag init');
    else out(`  Recording: ${mode === 'off' ? 'off' : mode === 'notes' ? 'git notes (local)' : 'commit trailer'}  ·  plan: ${plan}`);
    out();
  },

  init() {
    requireRepo();
    const self = fs.realpathSync(__filename);
    for (const r of hook.install(self)) out(`pricetag: ${r.msg}`);
    if (self.includes(`${path.sep}_npx${path.sep}`)) out('pricetag: running from the npx cache. For hooks that survive `npm cache clean`, run: npm i -g pricetag');
    if (flags.trailer) config.set('mode', 'trailer');
    if (flags.plan) config.set('plan', String(flags.plan));
    if (flags.client) config.set('client', String(flags.client));
    if (flags.action) commands.action();
    const mode = config.get('mode');
    out(`pricetag: recording to ${mode === 'trailer' ? 'commit trailers' : 'git notes (local only)'}. Change with: pricetag config mode trailer|notes|off`);
  },

  uninstall() {
    requireRepo();
    out(hook.uninstall() ? 'pricetag: hooks removed' : 'pricetag: no hooks found');
  },

  // Hook entry points. Never fail a commit.
  hook() {
    try {
      const [which, msgFile] = flags._;
      const log = v => { if (process.env.PRICETAG_QUIET !== '1') err(`pricetag: ${fmt.KEY}: ${v}`); };
      if (which === 'commit-msg') hook.runCommitMsg(msgFile, { pending: () => pt.pending(process.cwd()), log });
      else if (which === 'post-commit') hook.runPostCommit({ pending: (o) => pt.pending(process.cwd(), o), log });
    } catch (e) {
      if (process.env.PRICETAG_DEBUG) err(String(e && e.stack || e));
    }
  },

  // Usage across repos, grouped. The agency and team view.
  report() {
    const since = report.parseSince(flags.since);
    const until = flags.until ? report.parseSince(flags.until) : Infinity;
    const by = String(flags.by || 'repo');
    const plan = flags.plan ? String(flags.plan) : (git.repoRoot() ? config.get('plan') : 'auto');
    let events = pt.loadEvents({ since }).filter(e => e.ts >= since && e.ts <= until);
    if (flags.repo) {
      const root = flags.repo === true ? requireRepo() : fs.realpathSync(String(flags.repo));
      events = pt.attribute.select(events, { repoRoot: root, since, until });
    }
    if (flags.agent) events = events.filter(e => e.agent === flags.agent);
    const rows = report.group(events, by);
    const total = pt.attribute.summarize(events);
    const view = rows.map(r => ({
      [by]: r.key,
      tokens: fmt.tokens(r.summary.tokens),
      cached: r.summary.tokens ? Math.round((r.summary.cacheRead + r.summary.cacheWrite) / r.summary.tokens * 100) + '%' : '',
      time: fmt.minutes(r.summary.activeMinutes),
      sessions: r.summary.sessions,
      agents: Object.keys(r.summary.agents).join('+'),
      cost: fmt.costLabel(r.summary, plan),
    }));
    if (flags.json) return json({ since: new Date(since).toISOString(), by, plan, total: plain(total), rows: rows.map(r => ({ key: r.key, ...plain(r.summary) })) });
    const cols = [
      { key: by, label: by }, { key: 'tokens', label: 'tokens', right: true }, { key: 'cached', label: 'cached', right: true },
      { key: 'time', label: 'time', right: true }, { key: 'sessions', label: 'sessions', right: true }, { key: 'agents', label: 'agents' }, { key: 'cost', label: 'cost', right: true },
    ];
    if (flags.csv) return out(fmt.csv(view, cols));
    out();
    out(`  Agent usage by ${by} since ${new Date(since).toISOString().slice(0, 10)}${flags.repo ? ' (this repo)' : ''}`);
    out();
    out(view.length ? fmt.table(view, cols) : '  No agent usage found in this window. Try: pricetag doctor');
    out();
    out(`  Total  ${fmt.tokens(total.tokens)} tokens · ${fmt.minutes(total.activeMinutes)} · ${total.sessions} sessions · ${fmt.costLabel(total, plan)}`);
    if (plan !== 'api') out('  Dollars are what this usage would cost at API list prices. On a flat plan it is not a bill.');
    out();
  },

  log() {
    requireRepo();
    const list = git.commits(['-n', String(flags.n || 20)], process.cwd()).reverse();
    const total = pt.sumTrailers(list);
    if (flags.json) return json(list.map(c => ({ ...c, usage: fmt.parseTrailer(c.value) })));
    out();
    for (const c of list) {
      const t = fmt.parseTrailer(c.value);
      out(`  ${c.short}  ${(t ? fmt.tokens(t.tokens) : '–').padStart(7)}  ${(t ? fmt.minutes(t.minutes) : '').padStart(7)}  ${(t ? fmt.money(t.cost) + (t.uncertain ? '?' : '') : '').padStart(8)}  ${c.subject.slice(0, 60)}`);
    }
    out();
    out(`  ${total.tagged}/${list.length} commits with agent usage · ${fmt.tokens(total.tokens)} tokens · ${fmt.minutes(total.minutes)} · ${fmt.money(total.cost)}${total.uncertain ? '+?' : ''}`);
    out();
  },

  pr() {
    requireRepo();
    const plan = config.get('plan');
    const base = flags.base || git.defaultBranch(process.cwd()) || 'main';
    let range = `${base}..HEAD`;
    try { git.git(['rev-parse', '--verify', base]); } catch { try { git.git(['rev-parse', '--verify', `origin/${base}`]); range = `origin/${base}..HEAD`; } catch { /* keep */ } }
    const list = git.commits(range, process.cwd());
    const total = pt.sumTrailers(list);
    const costWord = plan === 'api' ? 'est. cost' : 'API-equivalent';
    const lines = ['### Agent usage'];
    lines.push('');
    if (!list.length) {
      lines.push(`_No commits ahead of \`${base}\`._`);
    } else {
      lines.push(`**${fmt.tokens(total.tokens)} tokens** · ${fmt.minutes(total.minutes)} of agent time · ${total.tagged}/${list.length} commits recorded${total.agents.length ? ' · ' + total.agents.join(', ') : ''} · ${costWord} ${fmt.money(total.cost)}${total.uncertain ? '+?' : ''}`);
      lines.push('');
      lines.push('<details><summary>Per commit</summary>');
      lines.push('');
      lines.push('| commit | subject | tokens | time | cost |');
      lines.push('|---|---|---:|---:|---:|');
      for (const c of list) {
        const t = fmt.parseTrailer(c.value);
        lines.push(`| \`${c.short}\` | ${c.subject.replace(/\|/g, '\\|').slice(0, 60)} | ${t ? fmt.tokens(t.tokens) : '–'} | ${t ? fmt.minutes(t.minutes) : '–'} | ${t ? fmt.money(t.cost) + (t.uncertain ? '?' : '') : '–'} |`);
      }
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
    lines.push(`<sub>Tokens are read from local agent transcripts and recorded per commit by [pricetag](${REPO_URL}). Dollars are estimates at API list prices${plan === 'api' ? '' : ', not a bill'}.</sub>`);
    out(lines.join('\n'));
  },

  badge() {
    requireRepo();
    const list = git.commits(['HEAD'], process.cwd());
    const total = pt.sumTrailers(list);
    const esc = t => encodeURIComponent(String(t).replace(/-/g, '--').replace(/_/g, '__'));
    const label = esc(flags.label || 'agent usage');
    const value = esc(`${fmt.tokens(total.tokens)} tokens`);
    const url = `https://img.shields.io/badge/${label}-${value}-ff6b35`;
    const md = `[![${decodeURIComponent(label)}](${url})](${REPO_URL})`;
    if (flags.write) {
      const file = path.resolve(flags.write === true ? 'README.md' : String(flags.write));
      const START = '<!-- pricetag -->', END = '<!-- /pricetag -->';
      let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const block = `${START}${md}${END}`;
      text = text.includes(START) && text.includes(END) ? text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block) : block + '\n\n' + text;
      fs.writeFileSync(file, text);
      out(`pricetag: badge written to ${path.relative(process.cwd(), file)}`);
    } else out(md);
  },

  config() {
    const [key, value] = flags._;
    if (!key) {
      const all = config.all();
      if (flags.json) return json(all);
      for (const [k, v] of Object.entries(all)) out(`  ${k.padEnd(8)} ${v || '(unset)'}`);
      return;
    }
    if (flags.unset) { config.unset(key); return out(`pricetag: ${key} unset`); }
    if (value === undefined) return out(config.get(key));
    requireRepo();
    config.set(key, value, process.cwd(), { global: !!flags.global });
    out(`pricetag: ${key} = ${value}`);
  },

  doctor() {
    const since = report.parseSince(flags.since || '7d');
    const d = doctor.run(pt.ADAPTERS, { since });
    const root = git.repoRoot();
    d.repo = root ? { root, hooksInstalled: hook.installed(), settings: config.all() } : null;
    d.pricesAsOf = pricing.asOf();
    if (flags.json) return json(d);
    out();
    out(`  node ${d.node} · ${d.git || 'git not found'} · ${d.platform}`);
    out(`  prices as of ${d.pricesAsOf}  (pricetag prices --update to refresh)`);
    out();
    for (const a of d.adapters) {
      out(`  ${a.name.padEnd(12)} ${a.status}${a.err ? ' (' + a.err + ')' : ''}`);
      for (const r of a.roots) out(`               ${r}`);
      if (a.roots.length) out(`               ${a.files} files · ${a.events} events in the last ${flags.since || '7d'}`);
    }
    out();
    if (d.repo) {
      out(`  repo         ${d.repo.root}`);
      out(`  hooks        ${d.repo.hooksInstalled ? 'installed' : 'not installed (pricetag init)'}`);
      out(`  settings     ${Object.entries(d.repo.settings).map(([k, v]) => `${k}=${v || '-'}`).join('  ')}`);
    } else out('  not inside a git repository');
    out();
  },

  action() {
    const root = requireRepo();
    const dir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'pricetag.yml');
    if (fs.existsSync(file) && !flags.force) return out('pricetag: .github/workflows/pricetag.yml exists (use --force to overwrite)');
    fs.writeFileSync(file, WORKFLOW);
    out('pricetag: wrote .github/workflows/pricetag.yml (PR usage comment)');
  },

  async prices() {
    if (flags.update) {
      const url = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
      const fresh = pricing.fromLiteLLM(await fetchJson(url));
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(pricing.USER_FILE, 'utf8')); } catch { /* none */ }
      const table = { ...prev, ...fresh, _asOf: new Date().toISOString().slice(0, 10) };
      fs.mkdirSync(path.dirname(pricing.USER_FILE), { recursive: true });
      fs.writeFileSync(pricing.USER_FILE, JSON.stringify(table, null, 2));
      return out(`pricetag: ${Object.keys(fresh).length} model prices merged into ${pricing.USER_FILE}`);
    }
    const t = pricing.loadTable();
    if (flags.json) return json(t);
    out(`  $ per 1M tokens · as of ${pricing.asOf()}`);
    out('  model                        in      out  cache-w  cache-r');
    for (const [k, v] of Object.entries(t).sort()) if (!k.startsWith('_')) out(`  ${k.padEnd(26)} ${String(v.input).padStart(6)} ${String(v.output).padStart(8)} ${String(v.cacheWrite).padStart(8)} ${String(v.cacheRead).padStart(8)}`);
    out(`\n  Override file: ${pricing.USER_FILE}   Refresh: pricetag prices --update`);
  },

  help() {
    out(`pricetag ${pkg.version} — what your AI coding agents cost, per repo, branch and client

  pricetag                     agent work not yet committed, and recent commits
  pricetag report              usage across all repos (--by repo|client|branch|agent|model|day --since 30d --csv --json)
  pricetag init [--trailer]    install hooks (records to local git notes; --trailer writes commit trailers)
  pricetag log [-n 20]         commits with their recorded usage
  pricetag pr [--base main]    markdown summary for the current branch
  pricetag config <key> [val]  mode (off|notes|trailer) · plan (auto|api|subscription|copilot) · client · scope
  pricetag doctor              which agents were detected and where
  pricetag prices [--update]   price table
  pricetag badge [--write]     README badge
  pricetag uninstall

  Skip one commit:  PRICETAG=0 git commit ...
  ${REPO_URL}`);
  },
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, res => {
      if (res.statusCode >= 300 && res.headers.location) return fetchJson(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out after 10s')));
  });
}

const WORKFLOW = `name: pricetag
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  usage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: hsiddhu2/pricetag@v0
`;

(async () => {
  const fn = commands[cmd];
  if (!fn) { err(`pricetag: unknown command "${cmd}"`); commands.help(); process.exit(2); }
  await fn();
})().catch(e => { err('pricetag: ' + (e && e.message || e)); process.exit(1); });
