'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NOTES_REF = 'pricetag';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
}

function repoRoot(cwd = process.cwd()) {
  try { return fs.realpathSync(git(['rev-parse', '--show-toplevel'], { cwd })); } catch { return null; }
}

function gitDir(cwd = process.cwd()) {
  try { return path.resolve(cwd, git(['rev-parse', '--git-dir'], { cwd })); } catch { return null; }
}

function commitTime(ref, cwd) {
  try { return Number(git(['log', '-1', '--format=%ct', ref], { cwd })) * 1000; } catch { return 0; }
}

function headTime(cwd) { return commitTime('HEAD', cwd); }

function currentBranch(cwd) {
  try { return git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }); } catch { return null; }
}

// Commits in a range, oldest first, with the Agent-Usage value from the trailer or the
// pricetag notes ref (trailer wins when both exist).
function commits(range, cwd) {
  const SEP = '\x1e', FS = '\x1f';
  const args = ['log', `--notes=${NOTES_REF}`, `--format=%H${FS}%ct${FS}%s${FS}%(trailers:key=Agent-Usage,valueonly)${FS}%N${SEP}`, '--reverse'];
  if (Array.isArray(range)) args.push(...range); else if (range) args.push(range);
  let out = '';
  try { out = git(args, { cwd }); } catch { return []; }
  return out.split(SEP).map(s => s.replace(/^\n+/, '')).filter(s => s.trim()).map(rec => {
    const [hash, ct, subject, trailer, note] = rec.split(FS);
    const fromNote = (note || '').split('\n').map(l => l.trim()).find(l => l.startsWith('Agent-Usage:'));
    const value = (trailer || '').trim() || (fromNote ? fromNote.slice('Agent-Usage:'.length).trim() : '');
    return { hash, short: hash.slice(0, 7), time: Number(ct) * 1000, subject, value: value || null, source: (trailer || '').trim() ? 'trailer' : fromNote ? 'note' : null };
  });
}

function addTrailer(msgFile, key, value) {
  try {
    execFileSync('git', ['interpret-trailers', '--in-place', '--if-exists', 'replace', '--trailer', `${key}: ${value}`, msgFile], { stdio: 'ignore' });
    return true;
  } catch { /* fall through */ }
  const text = fs.readFileSync(msgFile, 'utf8');
  const lines = text.split('\n');
  const firstComment = lines.findIndex(l => l.startsWith('#'));
  const trailer = `${key}: ${value}`;
  if (firstComment === -1) {
    fs.writeFileSync(msgFile, text.replace(/\s*$/, '') + `\n\n${trailer}\n`);
  } else {
    const body = lines.slice(0, firstComment).join('\n').replace(/\s*$/, '');
    fs.writeFileSync(msgFile, `${body}\n\n${trailer}\n${lines.slice(firstComment).join('\n')}`);
  }
  return true;
}

function readNote(sha, cwd) {
  try { return git(['notes', `--ref=${NOTES_REF}`, 'show', sha], { cwd }); } catch { return null; }
}

function writeNote(sha, text, cwd) {
  execFileSync('git', ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-m', text, sha], { cwd, stdio: 'ignore' });
}

function isAncestor(a, b, cwd) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, stdio: 'ignore' }); return true; } catch { return false; }
}

function defaultBranch(cwd) {
  try { return git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd }).replace(/^origin\//, ''); } catch { /* next */ }
  for (const b of ['main', 'master']) {
    try { git(['rev-parse', '--verify', b], { cwd }); return b; } catch { /* next */ }
  }
  return null;
}

module.exports = { NOTES_REF, git, repoRoot, gitDir, commitTime, headTime, currentBranch, commits, addTrailer, readNote, writeNote, isAncestor, defaultBranch };
