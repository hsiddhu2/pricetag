'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { BIN, sandbox, writeClaude, commit } = require('./helpers');

test('notes mode (default): usage lands in refs/notes/pricetag, never in the message', () => {
  const sb = sandbox();
  const T0 = Date.now();
  assert.match(sb.pt('init'), /installed commit-msg[\s\S]*installed post-commit[\s\S]*git notes/);
  writeClaude(sb.proj, sb.repo, [{ ts: T0 - 1000, id: 'a', req: 'a' }]);
  const sha = commit(sb, 'first');
  assert.doesNotMatch(sb.git('log', '-1', '--format=%B'), /Agent-Usage/);
  assert.match(sb.git('notes', '--ref=pricetag', 'show', sha), /^Agent-Usage: 2k tok \| 1m \| claude-code\/sonnet-4-5 \| ~\$0\.02 API-equiv\n?$/);
  assert.match(sb.pt('log'), /1\/1 commits with agent usage/);
  // nothing new -> no note on the next commit, and no double counting
  const sha2 = commit(sb, 'second');
  assert.throws(() => sb.git('notes', '--ref=pricetag', 'show', sha2));
});

test('trailer mode: final message gets the trailer, editor abort is safe, amend sums', () => {
  const sb = sandbox({ repoName: 'pt repo-' });   // path with a space
  const T0 = Date.now();
  sb.pt('init', '--trailer');
  assert.strictEqual(sb.pt('config', 'mode').trim(), 'trailer');
  writeClaude(sb.proj, sb.repo, [{ ts: T0 - 1000, id: 'a', req: 'a' }]);
  commit(sb, 'first');
  assert.match(sb.git('log', '-1', '--format=%B'), /^first\n\nAgent-Usage: 2k tok \| 1m \| claude-code\/sonnet-4-5 \| ~\$0\.02 API-equiv\n*$/);

  // editor closed empty: commit aborted, HEAD unchanged
  writeClaude(sb.proj, sb.repo, [{ ts: T0 + 1000, id: 'b', req: 'b' }]);
  const before = sb.git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(sb.repo, 'g'), '1'); sb.git('add', '.');
  assert.throws(() => sb.sh('git', ['commit', '-q'], { env: { ...sb.env, GIT_EDITOR: 'true' } }), /Aborting|empty/i);
  assert.strictEqual(sb.git('rev-parse', 'HEAD'), before);

  // typed subject stays clean
  sb.sh('git', ['commit', '-q'], { env: { ...sb.env, GIT_EDITOR: sb.typeSubject } });
  assert.match(sb.git('log', '-1', '--format=%B'), /^typed subject\n\nAgent-Usage: 2k tok/);

  // amend with more work sums old + new, single trailer
  writeClaude(sb.proj, sb.repo, [{ ts: T0 + 1000, id: 'b', req: 'b' }, { ts: T0 + 2000, id: 'c', req: 'c' }]);
  sb.sh('git', ['commit', '-q', '--amend'], { env: { ...sb.env, GIT_EDITOR: 'true' } });
  const body = sb.git('log', '-1', '--format=%B');
  assert.match(body, /Agent-Usage: 4k tok/);
  assert.strictEqual((body.match(/Agent-Usage/g) || []).length, 1);

  // merge commit skipped
  sb.git('checkout', '-q', '-b', 'side'); commit(sb, 'side', 's');
  sb.git('checkout', '-q', 'main'); commit(sb, 'main2', 'm');
  writeClaude(sb.proj, sb.repo, [{ ts: T0 + 3000, id: 'd', req: 'd' }]);
  sb.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  assert.doesNotMatch(sb.git('log', '-1', '--format=%B'), /Agent-Usage/);

  // PRICETAG=0 skips and the work carries forward
  writeClaude(sb.proj, sb.repo, [{ ts: T0 + 3000, id: 'd', req: 'd' }, { ts: T0 + 4000, id: 'e', req: 'e' }]);
  fs.writeFileSync(path.join(sb.repo, 'h'), '1'); sb.git('add', '.');
  sb.sh('git', ['commit', '-q', '-m', 'manual'], { env: { ...sb.env, PRICETAG: '0' } });
  assert.doesNotMatch(sb.git('log', '-1', '--format=%B'), /Agent-Usage/);
  commit(sb, 'after skip', 'i');
  assert.match(sb.git('log', '-1', '--format=%B'), /Agent-Usage: 4k tok/);
});

test('hooks coexist with existing hooks, exit 0 lines and husky v9', () => {
  const sb = sandbox();
  const hookDir = path.join(sb.repo, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'commit-msg'), '#!/bin/sh\necho existing >> "$1.log"\nexit 0\n', { mode: 0o755 });
  assert.match(sb.pt('init', '--trailer'), /added to existing commit-msg/);
  const text = fs.readFileSync(path.join(hookDir, 'commit-msg'), 'utf8');
  assert.ok(text.indexOf('# pricetag-hook') < text.lastIndexOf('exit 0'), 'inserted before exit');
  writeClaude(sb.proj, sb.repo, [{ ts: Date.now() - 1000, id: 'a', req: 'a' }]);
  commit(sb, 'x');
  assert.match(fs.readFileSync(path.join(sb.repo, '.git', 'COMMIT_EDITMSG.log'), 'utf8'), /existing/);
  assert.match(sb.git('log', '-1', '--format=%B'), /Agent-Usage/);
  // node missing from PATH: commit still succeeds, no trailer. A PATH with only git in it,
  // because CI runners keep a system node in /usr/bin.
  if (process.platform !== 'win32') {
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const onlyGit = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-onlygit-'));
    fs.symlinkSync(gitBin, path.join(onlyGit, 'git'));
    writeClaude(sb.proj, sb.repo, [{ ts: Date.now() + 1000, id: 'b', req: 'b' }]);
    fs.writeFileSync(path.join(sb.repo, 'z'), '1'); sb.git('add', '.');
    sb.sh('git', ['commit', '-q', '-m', 'no node'], { env: { ...sb.env, PATH: onlyGit } });
    assert.doesNotMatch(sb.git('log', '-1', '--format=%B'), /Agent-Usage/);
  }
  // uninstall leaves the pre-existing hook
  assert.match(sb.pt('uninstall'), /removed/);
  const after = fs.readFileSync(path.join(hookDir, 'commit-msg'), 'utf8');
  assert.match(after, /echo existing/); assert.doesNotMatch(after, /pricetag/);
  assert.ok(!fs.existsSync(path.join(hookDir, 'post-commit')));
  // husky
  fs.mkdirSync(path.join(sb.repo, '.husky', '_'), { recursive: true });
  sb.git('config', 'core.hooksPath', '.husky/_');
  sb.pt('init');
  assert.ok(fs.existsSync(path.join(sb.repo, '.husky', 'post-commit')));
  assert.ok(!fs.existsSync(path.join(sb.repo, '.husky', '_', 'post-commit')));
});

test('config: keys, validation, env override, client registry', () => {
  const sb = sandbox();
  assert.match(sb.pt('config'), /mode\s+notes[\s\S]*plan\s+auto/);
  sb.pt('config', 'plan', 'api');
  assert.strictEqual(sb.pt('config', 'plan').trim(), 'api');
  assert.throws(() => sb.pt('config', 'plan', 'gold'), /must be one of/);
  assert.throws(() => sb.pt('config', 'colour', 'red'), /unknown setting/);
  assert.strictEqual(sb.sh('node', [BIN, 'config', 'mode'], { env: { ...sb.env, PRICETAG_MODE: 'off' } }).trim(), 'off');
  sb.pt('config', 'client', 'Acme Corp');
  const reg = JSON.parse(fs.readFileSync(path.join(sb.env.PRICETAG_HOME, 'clients.json'), 'utf8'));
  assert.strictEqual(reg[sb.repo], 'Acme Corp');
  sb.pt('config', 'client', '--unset');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(sb.env.PRICETAG_HOME, 'clients.json'), 'utf8')), {});
});

test('report: by repo and client across repos, csv and json', () => {
  const sb = sandbox();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-other-')));
  sb.sh('git', ['init', '-q'], { cwd: other });
  sb.pt('config', 'client', 'Acme');
  const now = Date.now();
  writeClaude(sb.proj, sb.repo, [{ ts: now - 60000, id: 'a', req: 'a' }, { ts: now - 50000, id: 'b', req: 'b', cwd: other }, { ts: now - 40000, id: 'c', req: 'c', cwd: path.join(other, 'src') }]);
  const byRepo = sb.pt('report', '--by', 'repo', '--since', '1d');
  assert.match(byRepo, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+4k'));
  assert.match(byRepo, /Total  6k tokens/);
  const byClient = sb.pt('report', '--by', 'client', '--since', '1d');
  assert.match(byClient, /Acme\s+2k/); assert.match(byClient, /\(no client\)\s+4k/);
  const csv = sb.pt('report', '--by', 'client', '--since', '1d', '--csv');
  assert.match(csv.split('\n')[0], /^client,tokens,cached,time,sessions,agents,cost$/);
  const j = JSON.parse(sb.pt('report', '--by', 'agent', '--since', '1d', '--json'));
  assert.strictEqual(j.total.tokens, 6000);
  assert.strictEqual(j.rows[0].key, 'claude-code');
  const thisRepo = sb.pt('report', '--repo', '--since', '1d');
  assert.match(thisRepo, /Total  2k tokens/);
  assert.match(sb.pt('report', '--since', '1h', '--plan', 'api'), /est\./);
});

test('status, pr, badge, doctor, help, version', () => {
  const sb = sandbox();
  sb.pt('init');
  writeClaude(sb.proj, sb.repo, [{ ts: Date.now() - 1000, id: 'a', req: 'a' }]);
  assert.match(sb.pt(), /Uncommitted agent work\s+2k tokens/);
  commit(sb, 'first');
  sb.git('checkout', '-q', '-b', 'feat');
  writeClaude(sb.proj, sb.repo, [{ ts: Date.now() + 1000, id: 'b', req: 'b' }]);
  commit(sb, 'feature work');
  const pr = sb.pt('pr', '--base', 'main');
  assert.match(pr, /### Agent usage/); assert.match(pr, /1\/1 commits recorded/); assert.match(pr, /feature work/); assert.match(pr, /not a bill/);
  assert.match(sb.pt('badge'), /img\.shields\.io\/badge\/agent%20usage-4k%20tokens/);
  assert.match(sb.pt('badge', '--label', 'ai-usage'), /ai--usage/);
  sb.pt('badge', '--write', 'README.md');
  assert.match(fs.readFileSync(path.join(sb.repo, 'README.md'), 'utf8'), /<!-- pricetag -->/);
  const doc = sb.pt('doctor');
  assert.match(doc, /claude-code\s+ok/); assert.match(doc, /hooks\s+installed/);
  assert.match(execFileSync('node', [BIN, '--help'], { cwd: os.tmpdir(), encoding: 'utf8' }), /pricetag report/);
  assert.match(execFileSync('node', [BIN, '--version'], { encoding: 'utf8' }), /^\d+\.\d+\.\d+/);
  const j = JSON.parse(sb.pt('--json'));
  assert.strictEqual(j.mode, 'notes');
});

test('performance: commit with hook stays fast with 75 MB of unrelated transcripts', () => {
  const sb = sandbox();
  sb.pt('init');
  const u = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const row = JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 3600e3).toISOString(), cwd: '/elsewhere', sessionId: 'big', requestId: 'r', message: { id: 'm', model: 'claude-sonnet-4-5', usage: u, content: 'x'.repeat(900) } }) + '\n';
  const big = row.repeat(Math.ceil(25e6 / row.length));
  // two stale files (skipped by mtime) and one fresh 25 MB file that must be parsed
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sb.proj, `big${i}.jsonl`), big);
  const old = new Date(Date.now() - 864e5);
  fs.utimesSync(path.join(sb.proj, 'big0.jsonl'), old, old);
  fs.utimesSync(path.join(sb.proj, 'big1.jsonl'), old, old);
  writeClaude(sb.proj, sb.repo, [{ ts: Date.now() - 1000, id: 'a', req: 'a' }], 'real.jsonl');
  fs.writeFileSync(path.join(sb.repo, 'f'), '1'); sb.git('add', '.');
  const t0 = process.hrtime.bigint();
  sb.git('commit', '-q', '-m', 'perf');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 4000, `commit with hook took ${ms.toFixed(0)} ms`);
  const t1 = process.hrtime.bigint();
  sb.pt('--json');
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 4000);
});

test('notes survive amend, rebase and reset without double counting', () => {
  const sb = sandbox();
  const T0 = Date.now();
  sb.pt('init');
  assert.strictEqual(sb.git('config', 'notes.rewriteRef').trim(), 'refs/notes/pricetag');
  const note = sha => { try { return sb.git('notes', '--ref=pricetag', 'show', sha).trim(); } catch { return null; } };
  const tok = sha => { const n = note(sha); return n ? n.match(/(\d+)k tok/)[1] : null; };
  const later = (sec) => ({ ...sb.env, GIT_COMMITTER_DATE: new Date(T0 + sec * 1000).toISOString(), GIT_AUTHOR_DATE: new Date(T0 + sec * 1000).toISOString() });

  writeClaude(sb.proj, sb.repo, [{ ts: T0 - 1000, id: 'a', req: 'a' }]);
  const c1 = commit(sb, 'c1');
  assert.strictEqual(tok(c1), '2');
  // amend with no new work, forced to a new SHA: note copied, still 2k
  sb.sh('git', ['commit', '-q', '--amend', '--no-edit'], { env: later(10) });
  const c1b = sb.git('rev-parse', 'HEAD').trim();
  assert.notStrictEqual(c1b, c1);
  assert.strictEqual(tok(c1b), '2');
  // amend with new work: 2k + 2k
  writeClaude(sb.proj, sb.repo, [{ ts: T0 - 1000, id: 'a', req: 'a' }, { ts: T0 + 20000, id: 'b', req: 'b' }]);
  sb.sh('git', ['commit', '-q', '--amend', '--no-edit'], { env: later(30) });
  assert.strictEqual(tok(sb.git('rev-parse', 'HEAD').trim()), '4');
  // branch with two commits of 2k each, then rebase onto an advanced main: notes follow, no inflation
  sb.git('checkout', '-q', '-b', 'feat');
  writeClaude(sb.proj, sb.repo, [{ ts: T0 + 40000, id: 'c', req: 'c' }]);
  sb.sh('git', ['commit', '-q', '--allow-empty', '-m', 'f1'], { env: later(50) });
  writeClaude(sb.proj, sb.repo, [{ ts: T0 + 60000, id: 'd', req: 'd' }]);
  sb.sh('git', ['commit', '-q', '--allow-empty', '-m', 'f2'], { env: later(70) });
  sb.git('checkout', '-q', 'main');
  sb.sh('git', ['commit', '-q', '--allow-empty', '-m', 'm2'], { env: later(80) });
  sb.git('checkout', '-q', 'feat');
  sb.sh('git', ['rebase', '-q', 'main'], { env: later(90) });
  const log = sb.pt('log', '-n', '4');
  const sum = [...log.matchAll(/(\d+)k\s+\dm/g)].map(m => Number(m[1])).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 2 + 2 + 4, `expected 8k across the branch, got ${sum}k in:\n${log}`);
  // reset --hard then a fresh commit: nothing from ORIG_HEAD leaks in
  sb.git('reset', '-q', '--hard', 'HEAD~1');
  sb.sh('git', ['commit', '-q', '--allow-empty', '-m', 'after reset'], { env: later(100) });
  assert.strictEqual(note(sb.git('rev-parse', 'HEAD').trim()), null);
});

test('a broken log source is skipped, not fatal', () => {
  const sb = sandbox();
  const oc = path.join(sb.home, 'oc');
  fs.mkdirSync(oc, { recursive: true });
  fs.writeFileSync(path.join(oc, 'opencode.db'), 'this is not a database');
  writeClaude(sb.proj, sb.repo, [{ ts: Date.now() - 1000, id: 'a', req: 'a' }]);
  const r = sb.sh('node', [BIN, '--json'], { env: { ...sb.env, OPENCODE_DATA_DIR: oc } });
  const j = JSON.parse(r);
  assert.strictEqual(j.pending.tokens, 2000, 'claude-code still counted');
  // Only where a SQLite reader exists can the corrupt file be noticed at all.
  if (require('../lib/adapters/opencode').readerAvailable()) assert.ok(j.errors.some(e => e.adapter === 'opencode'), 'opencode error reported');
});
