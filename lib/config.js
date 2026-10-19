'use strict';
// Settings live in git config (per repo) under the `pricetag.` namespace, so there is
// no new file to learn and `git config --list` shows everything. A small global
// registry maps repo paths to client names for cross-repo reports.

const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('./git');

const DEFAULTS = {
  mode: 'notes',          // off | notes | trailer
  plan: 'auto',           // auto | api | subscription | copilot
  scope: '',              // extra directory whose sessions count for this repo
  client: '',             // client or project label for reports
};

const KEYS = Object.keys(DEFAULTS);

function get(key, cwd = process.cwd()) {
  if (!KEYS.includes(key)) throw new Error(`unknown setting "${key}" (known: ${KEYS.join(', ')})`);
  const env = process.env[`PRICETAG_${key.toUpperCase()}`];
  if (env !== undefined && env !== '') return env;
  try {
    const v = git.git(['config', '--get', `pricetag.${key}`], { cwd });
    if (v) return v;
  } catch { /* unset */ }
  return DEFAULTS[key];
}

function set(key, value, cwd = process.cwd(), { global = false } = {}) {
  if (!KEYS.includes(key)) throw new Error(`unknown setting "${key}" (known: ${KEYS.join(', ')})`);
  validate(key, value);
  const args = ['config'];
  if (global) args.push('--global');
  args.push(`pricetag.${key}`, value);
  git.git(args, { cwd });
  if (key === 'client') registerClient(git.repoRoot(cwd), value);
}

function unset(key, cwd = process.cwd()) {
  try { git.git(['config', '--unset', `pricetag.${key}`], { cwd }); } catch { /* not set */ }
  if (key === 'client') registerClient(git.repoRoot(cwd), '');
}

function validate(key, value) {
  const allowed = { mode: ['off', 'notes', 'trailer'], plan: ['auto', 'api', 'subscription', 'copilot'] };
  if (allowed[key] && !allowed[key].includes(value)) {
    throw new Error(`${key} must be one of: ${allowed[key].join(', ')}`);
  }
}

function all(cwd = process.cwd()) {
  const out = {};
  for (const k of KEYS) out[k] = get(k, cwd);
  return out;
}

// ---- client registry (global) ----

function configDir() {
  if (process.env.PRICETAG_HOME) return process.env.PRICETAG_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pricetag');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pricetag');
}

const REGISTRY = () => path.join(configDir(), 'clients.json');

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY(), 'utf8')); } catch { return {}; }
}

function registerClient(repoRoot, client) {
  if (!repoRoot) return;
  const reg = readRegistry();
  if (client) reg[repoRoot] = client; else delete reg[repoRoot];
  fs.mkdirSync(path.dirname(REGISTRY()), { recursive: true });
  fs.writeFileSync(REGISTRY(), JSON.stringify(reg, null, 2) + '\n');
}

function clientFor(repoRoot) {
  if (!repoRoot) return '';
  return readRegistry()[repoRoot] || '';
}

module.exports = { DEFAULTS, KEYS, get, set, unset, all, configDir, readRegistry, registerClient, clientFor };
