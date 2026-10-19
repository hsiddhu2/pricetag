'use strict';
// Git hooks. Two are installed and each checks `pricetag.mode` at run time, so changing
// the mode never needs a reinstall:
//   commit-msg  -> mode=trailer: adds an Agent-Usage trailer to the final message
//   post-commit -> mode=notes:   writes the same value to refs/notes/pricetag (local, not pushed)
// Neither can fail a commit. Everything is wrapped and exits 0.

const fs = require('fs');
const path = require('path');
const git = require('./git');
const fmt = require('./format');
const config = require('./config');

const MARK_START = '# pricetag-hook';
const MARK_END = '# /pricetag-hook';
const HOOKS = ['commit-msg', 'post-commit'];

// Respects core.hooksPath. Under husky v9 the configured path is .husky/_ (gitignored,
// regenerated on install), so the user-facing .husky/<hook> file is used instead.
function hookFile(name, cwd = process.cwd()) {
  let dir = path.resolve(cwd, git.git(['rev-parse', '--git-path', 'hooks'], { cwd }));
  if (path.basename(dir) === '_' && path.basename(path.dirname(dir)) === '.husky') dir = path.dirname(dir);
  return path.join(dir, name);
}

function snippet(self, hookName) {
  const bin = self.replace(/(["$`\\])/g, '\\$1');
  return [
    MARK_START,
    '[ "$PRICETAG" = "0" ] || {',
    `  if command -v node >/dev/null 2>&1 && [ -f "${bin}" ]; then node "${bin}" hook ${hookName} "$@" || true;`,
    `  elif command -v pricetag >/dev/null 2>&1; then pricetag hook ${hookName} "$@" || true;`,
    `  elif command -v npx >/dev/null 2>&1; then npx --no-install pricetag hook ${hookName} "$@" 2>/dev/null || true; fi;`,
    '}',
    MARK_END,
  ].join('\n');
}

function stripSnippet(text) {
  return text.replace(new RegExp(`\\n?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`, 'g'), '\n');
}

function installOne(self, hookName, cwd) {
  const file = hookFile(hookName, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const snip = snippet(self, hookName);
  let msg;
  if (fs.existsSync(file)) {
    let cur = stripSnippet(fs.readFileSync(file, 'utf8'));
    const shebang = (cur.match(/^#!(.*)$/m) || [])[1] || '';
    if (shebang && !/\b(sh|bash|dash|zsh|ksh)\b/.test(shebang)) {
      return { file, msg: `skipped ${hookName}: the existing hook is not a shell script (${shebang.trim()}). Add this line to it yourself:\n    node "${self}" hook ${hookName} "$@" || true`, skipped: true };
    }
    const lines = cur.replace(/\s+$/, '').split('\n');
    if (/^\s*(exit|exec)\b/.test(lines[lines.length - 1] || '')) lines.splice(lines.length - 1, 0, snip);
    else lines.push(snip);
    cur = lines.join('\n') + '\n';
    if (!cur.startsWith('#!')) cur = '#!/bin/sh\n' + cur;
    fs.writeFileSync(file, cur);
    msg = `added to existing ${hookName}`;
  } else {
    fs.writeFileSync(file, `#!/bin/sh\n${snip}\nexit 0\n`);
    msg = `installed ${hookName}`;
  }
  fs.chmodSync(file, 0o755);
  return { file, msg };
}

function install(self, cwd = process.cwd()) {
  // Let git copy our notes across a rebase. Amend is handled by the hook itself (see
  // runPostCommit), because git copies notes after post-commit has already run.
  try {
    git.git(['config', 'notes.rewriteRef', `refs/notes/${git.NOTES_REF}`], { cwd });
    git.git(['config', 'notes.rewrite.amend', 'false'], { cwd });
  } catch { /* read-only config */ }
  return HOOKS.map(h => installOne(self, h, cwd));
}

function removeFrom(file) {
  if (!fs.existsSync(file)) return false;
  const cur = fs.readFileSync(file, 'utf8');
  if (!cur.includes(MARK_START)) return false;
  const cleaned = stripSnippet(cur);
  const body = cleaned.replace(/^#!\/bin\/sh\s*/, '').replace(/\s*exit 0\s*$/, '').trim();
  if (!body) fs.unlinkSync(file); else fs.writeFileSync(file, cleaned);
  return true;
}

function uninstall(cwd = process.cwd()) {
  for (const k of ['notes.rewriteRef', 'notes.rewrite.amend']) { try { git.git(['config', '--unset', k], { cwd }); } catch { /* not set */ } }
  let removed = false;
  for (const h of [...HOOKS, 'prepare-commit-msg']) if (removeFrom(hookFile(h, cwd))) removed = true;
  return removed;
}

function installed(cwd = process.cwd()) {
  try {
    return HOOKS.every(h => { const f = hookFile(h, cwd); return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(MARK_START); });
  } catch { return false; }
}

function commentChar(cwd) {
  let cc = '#';
  try { cc = git.git(['config', 'core.commentChar'], { cwd }) || '#'; } catch { /* default */ }
  return cc === 'auto' ? '#' : cc;
}

function hasContent(text, cwd) {
  const cc = commentChar(cwd);
  return text.split('\n').some(l => !l.startsWith(cc) && !/^\s*$/.test(l) && !l.startsWith(fmt.KEY + ':'));
}

// Merges, squashes, reverts, cherry-picks and rebases are not new agent work.
function inSpecialState(cwd) {
  return ['MERGE_HEAD', 'SQUASH_MSG', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'].some(n => gitPathExists(n, cwd));
}

function gitPathExists(name, cwd) {
  try { return fs.existsSync(path.resolve(cwd, git.git(['rev-parse', '--git-path', name], { cwd }))); } catch { return false; }
}

// commit-msg: trailer mode only.
function runCommitMsg(msgFile, { cwd = process.cwd(), pending, log = () => {} } = {}) {
  if (config.get('mode', cwd) !== 'trailer') return null;
  if (!msgFile || !fs.existsSync(msgFile)) return null;
  if (inSpecialState(cwd)) return null;
  const text = fs.readFileSync(msgFile, 'utf8');
  if (!hasContent(text, cwd)) return null;
  const prev = fmt.parseTrailer((text.match(new RegExp(`^${fmt.KEY}:\\s*(.*)$`, 'm')) || [])[1]);
  const p = pending();
  if (!p) return null;
  const sum = prev ? fmt.mergeIntoSummary(prev, p.summary) : p.summary;
  const v = fmt.trailer(sum, { plan: config.get('plan', cwd) });
  if (!v) return null;
  git.addTrailer(msgFile, fmt.KEY, v);
  p.commit();
  log(v);
  return v;
}

// post-commit: notes mode only. The window is from the previous commit to now.
function runPostCommit({ cwd = process.cwd(), pending, log = () => {} } = {}) {
  if (config.get('mode', cwd) !== 'notes') return null;
  let head, parents;
  try {
    head = git.git(['rev-parse', 'HEAD'], { cwd });
    parents = git.git(['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd }).split(/\s+/).slice(1);
  } catch { return null; }
  if (parents.length > 1) return null;                         // merge commit
  if (inSpecialState(cwd)) return null;
  const since = parents.length ? git.commitTime(parents[0], cwd) : 0;
  const p = pending({ since });
  if (!p) return null;
  // --amend: the replaced commit is HEAD@{1} and the reflog says so. Carry its note forward.
  let prev = null;
  try {
    const reflog = git.git(['reflog', '-1', '--format=%gs'], { cwd });
    if (/^commit \(amend\)/.test(reflog)) {
      const old = git.git(['rev-parse', '--verify', 'HEAD@{1}'], { cwd });
      const line = (git.readNote(old, cwd) || '').split('\n').find(l => l.startsWith(fmt.KEY + ':'));
      if (line) prev = fmt.parseTrailer(line.slice(fmt.KEY.length + 1));
    }
  } catch { /* no reflog */ }
  if (!prev && !p.summary.tokens) return null;
  const sum = prev ? fmt.mergeIntoSummary(prev, p.summary) : p.summary;
  const v = fmt.trailer(sum, { plan: config.get('plan', cwd) });
  if (!v) return null;
  git.writeNote(head, `${fmt.KEY}: ${v}`, cwd);
  p.commit();
  log(v);
  return v;
}

module.exports = { install, uninstall, installed, runCommitMsg, runPostCommit, hookFile, HOOKS, MARK_START };
