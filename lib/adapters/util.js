'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SLACK_MS = 300000;   // 5 minutes of clock skew allowed on mtime checks

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function n(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
function home() { return os.homedir(); }

// Recursively list files under dir that end with one of exts.
function* walk(dir, exts) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, exts);
    else if (e.isFile() && exts.some(x => e.name.endsWith(x))) yield p;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Iterate parsed JSON objects from a JSONL file, skipping bad lines.
function* jsonl(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* torn or partial line */ }
  }
}

function fresh(file, since) { return !since || mtime(file) >= since - SLACK_MS; }

// VS Code family globalStorage roots, for extension-based agents.
function vscodeGlobalStorage() {
  const h = home();
  const bases = process.platform === 'darwin'
    ? [path.join(h, 'Library', 'Application Support')]
    : process.platform === 'win32'
      ? [process.env.APPDATA || path.join(h, 'AppData', 'Roaming')]
      : [process.env.XDG_CONFIG_HOME || path.join(h, '.config')];
  const products = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Positron'];
  const out = [];
  for (const b of bases) for (const p of products) out.push(path.join(b, p, 'User', 'globalStorage'));
  for (const d of ['.vscode-server', '.vscode-server-insiders', '.cursor-server']) out.push(path.join(h, d, 'data', 'User', 'globalStorage'));
  return out;
}

module.exports = { SLACK_MS, isDir, isFile, mtime, n, home, walk, readJson, jsonl, fresh, vscodeGlobalStorage };

// Minimal: read a `cwd:` line from a small YAML file.
function readYamlCwd(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^cwd:\s*["']?(.+?)["']?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
module.exports.readYamlCwd = readYamlCwd;
