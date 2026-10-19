'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');

function version(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function countFiles(dir, ext) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(`${d}/${e.name}`);
      else if (ext.some(x => e.name.endsWith(x))) n++;
    }
  }
  return n;
}

// Inspect every adapter: where it looks, what it found, how many events in the window.
function run(adapters, { since }) {
  const out = { node: process.version, git: version('git', ['--version']), platform: process.platform, adapters: [] };
  for (const a of adapters) {
    const roots = a.roots();
    let events = 0, err = null;
    try { events = a.load({ since }).length; } catch (e) { err = e.message; }
    out.adapters.push({
      name: a.name,
      roots,
      files: roots.reduce((n, r) => n + countFiles(r, a.extensions || ['.jsonl']), 0),
      events, err,
      status: roots.length ? (events ? 'ok' : 'found, no recent usage') : 'not found',
    });
  }
  return out;
}

module.exports = { run };
