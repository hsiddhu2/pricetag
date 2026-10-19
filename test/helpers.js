'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'pricetag.js');

// An isolated HOME with a fake Claude Code transcript dir and a fresh git repo.
function sandbox({ repoName = 'pt-repo-' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), repoName)));
  const claudeDir = path.join(home, '.claude');
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, '.codex'), COPILOT_HOME: path.join(home, '.copilot'),
    PRICETAG_HOME: path.join(home, '.config', 'pricetag'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), PRICETAG_QUIET: '1',
  };
  delete env.PRICETAG_MODE; delete env.PRICETAG_PLAN; delete env.PRICETAG_SCOPE; delete env.PRICETAG_CLIENT;
  const sh = (c, a, opts = {}) => execFileSync(c, a, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const pt = (...a) => sh('node', [BIN, ...a]);
  const git = (...a) => sh('git', a);
  git('init', '-q', '-b', 'main');
  const proj = path.join(claudeDir, 'projects', 'x');
  fs.mkdirSync(proj, { recursive: true });
  return { home, repo, env, sh, pt, git, proj, claudeDir };
}

function line(obj) { return JSON.stringify(obj) + '\n'; }

// 2k tokens per event, $0.018 on sonnet-4-5 -> renders as $0.02
const USAGE_1K = { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function claudeEvent({ ts, cwd, model = 'claude-sonnet-4-5-20250929', id, req, usage = USAGE_1K, branch, type = 'assistant', sessionId = 's1' }) {
  return line({ type, timestamp: new Date(ts).toISOString(), cwd, gitBranch: branch, sessionId, requestId: req, message: { id, model, usage } });
}

function writeClaude(proj, repo, events, file = 's.jsonl') {
  fs.writeFileSync(path.join(proj, file), events.map(e => claudeEvent({ cwd: repo, ...e })).join(''));
}

function commit(sb, msg, file = 'f') {
  fs.writeFileSync(path.join(sb.repo, file), String(Math.random()));
  sb.git('add', '.');
  sb.git('commit', '-q', '-m', msg);
  return sb.git('rev-parse', 'HEAD').trim();
}

module.exports = { BIN, sandbox, line, claudeEvent, writeClaude, commit, USAGE_1K };
