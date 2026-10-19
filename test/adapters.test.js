'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const codex = require('../lib/adapters/codex');
const copilot = require('../lib/adapters/copilot');
const opencode = require('../lib/adapters/opencode');
const cline = require('../lib/adapters/cline');
const FX = path.join(__dirname, 'fixtures');

const total = evs => evs.reduce((a, e) => ({ input: a.input + e.usage.input, output: a.output + e.usage.output, cacheRead: a.cacheRead + e.usage.cacheRead, cacheWrite: a.cacheWrite + e.usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

test('codex: token_usage_record preferred, re-emitted token_count skipped, cached subtracted from input', () => {
  const evs = codex.load({ dirs: [path.join(FX, 'codex')] });
  assert.strictEqual(evs.length, 2);
  assert.deepStrictEqual(total(evs), { input: 3774, output: 1816, cacheRead: 22656, cacheWrite: 0 });
  assert.strictEqual(evs[0].model, 'gpt-5.3-codex');
  assert.strictEqual(evs[0].cwd, '/home/dev/projects/pricetag');
  assert.strictEqual(evs[0].sessionId, '0199f3a2-7b1c-7d2e-8f3a-4b5c6d7e8f90');
  assert.strictEqual(evs[0].agent, 'codex');
});

test('codex: falls back to token_count when no records exist, skipping re-emits', () => {
  const src = fs.readFileSync(path.join(FX, 'codex', fs.readdirSync(path.join(FX, 'codex'))[0]), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-codex-'));
  fs.writeFileSync(path.join(dir, 'rollout-x.jsonl'), src.split('\n').filter(l => !l.includes('"token_usage_record"')).join('\n'));
  const evs = codex.load({ dirs: [dir] });
  assert.strictEqual(evs.length, 2);
  assert.deepStrictEqual(total(evs), { input: 3774, output: 1816, cacheRead: 22656, cacheWrite: 0 });
});

test('copilot: shutdown metrics, cache-inclusive input corrected, credits reported', () => {
  const evs = copilot.load({ dirs: [path.join(FX, 'copilot', 'session-state')] });
  assert.strictEqual(evs.length, 1);
  assert.deepStrictEqual(evs[0].usage, { input: 2150, output: 1875, cacheRead: 38120, cacheWrite: 12040 });
  assert.strictEqual(evs[0].model, 'claude-sonnet-4.5');
  assert.strictEqual(evs[0].cwd, '/home/dev/projects/pricetag');
  assert.ok(Math.abs(evs[0].reported.credits - 5.95) < 1e-9);
});

test('copilot: resumed legs emit deltas, compaction resets the baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-cop-'));
  const sd = path.join(dir, 'abc'); fs.mkdirSync(sd);
  const shutdown = (ts, inp, out, cr, cw, aiu) => JSON.stringify({ type: 'session.shutdown', timestamp: ts, data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: inp, outputTokens: out, cacheReadTokens: cr, cacheWriteTokens: cw }, totalNanoAiu: aiu } } } });
  fs.writeFileSync(path.join(sd, 'events.jsonl'), [
    JSON.stringify({ type: 'session.start', timestamp: '2026-10-18T10:00:00Z', data: { sessionId: 'abc', context: { cwd: '/w' } } }),
    shutdown('2026-10-18T10:10:00Z', 1000, 100, 600, 0, 2e9),
    shutdown('2026-10-18T10:20:00Z', 1500, 150, 900, 0, 3e9),      // cumulative: delta 500/50/300
    JSON.stringify({ type: 'session.compaction_complete', timestamp: '2026-10-18T10:25:00Z', data: { success: true } }),
    shutdown('2026-10-18T10:30:00Z', 200, 20, 100, 0, 1e9),        // reset: taken as is
  ].join('\n'));
  const evs = copilot.load({ dirs: [dir] });
  assert.deepStrictEqual(evs.map(e => e.usage.input), [400, 200, 100]);
  assert.deepStrictEqual(evs.map(e => e.reported.credits), [2, 1, 1]);
});

test('opencode: V2 and V1 rows, reasoning billed as output, fork copies skipped', { skip: !opencode.readerAvailable() && 'no sqlite reader on this Node' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-oc-'));
  const sql = fs.readFileSync(path.join(FX, 'opencode', 'opencode-fixture.sql'), 'utf8');
  const db = path.join(dir, 'opencode.db');
  try { execFileSync('sqlite3', [db], { input: sql, stdio: ['pipe', 'ignore', 'ignore'] }); }
  catch {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(db); d.exec(sql.replace(/PRAGMA[^;]*;/g, '')); d.close();
  }
  const evs = opencode.load({ dirs: [dir] });
  const v2 = evs.filter(e => e.sessionId === 'ses_01HZ3K9T2Q8W7R6E5Y4U3I2O1P');
  assert.strictEqual(v2.length, 2);
  assert.deepStrictEqual(total(v2), { input: 3774, output: 1816 + 1024, cacheRead: 22656, cacheWrite: 1200 });
  assert.strictEqual(v2[0].cwd, '/home/dev/projects/pricetag');
  assert.strictEqual(v2[0].model, 'claude-sonnet-4-5');
  assert.ok(evs.some(e => e.sessionId === 'ses_01HX0LEGACY00000000000000' && e.model === 'claude-sonnet-4-20250514'), 'V1 row read');
  assert.ok(v2.every(e => e.reported && e.reported.cost > 0));
});

test('opencode: legacy JSON storage', () => {
  const evs = opencode.load({ dirs: [path.join(FX, 'opencode')] });
  const legacy = evs.filter(e => e.sessionId === 'ses_01HZ3K9T2Q8W7R6E5Y4U3I2O1P');
  assert.strictEqual(legacy.length, 1);
  assert.deepStrictEqual(legacy[0].usage, { input: 1500, output: 600, cacheRead: 7000, cacheWrite: 0 });
  assert.strictEqual(legacy[0].cwd, '/home/dev/projects/pricetag');
});

test('cline extension: tokensIn is already uncached, cwd from taskHistory', () => {
  const src = { dir: path.join(FX, 'cline', 'tasks'), agent: 'cline', gross: () => false, kind: 'tasks', state: path.join(FX, 'cline', 'state', 'taskHistory.json') };
  const evs = cline.load({ dirs: [src] });
  assert.strictEqual(evs.length, 3);
  assert.deepStrictEqual(total(evs), { input: 4754, output: 2117, cacheRead: 36606, cacheWrite: 1200 });
  assert.strictEqual(evs[0].cwd, '/home/dev/projects/pricetag');
  assert.strictEqual(evs[0].model, 'claude-sonnet-4-5');
  assert.ok(Math.abs(evs.reduce((a, e) => a + e.reported.cost, 0) - 0.0432) < 1e-6);
});

test('roo: tokensIn is cache-inclusive after 2025-11-02, cwd from history_item', () => {
  const src = { dir: path.join(FX, 'roo', 'tasks'), agent: 'roo', gross: (ts, t) => ts >= Date.parse('2025-11-02') || t.apiProtocol === 'openai', kind: 'tasks' };
  const evs = cline.load({ dirs: [src] });
  assert.strictEqual(evs.length, 3);
  assert.deepStrictEqual(total(evs), { input: 4754, output: 2117, cacheRead: 36606, cacheWrite: 1200 });
  assert.strictEqual(evs[0].agent, 'roo');
  assert.strictEqual(evs[0].cwd, '/home/dev/projects/pricetag');
});

test('cline cli sessions: metrics.inputTokens is cache-inclusive, cwd from manifest', () => {
  const evs = cline.load({ dirs: [{ dir: path.join(FX, 'cline-cli', 'sessions'), agent: 'cline', kind: 'sessions' }] });
  assert.strictEqual(evs.length, 2);
  assert.deepStrictEqual(evs.map(e => e.usage.input), [2240, 1534]);
  assert.strictEqual(evs[0].cwd, '/home/dev/projects/pricetag');
  assert.strictEqual(evs[0].model, 'claude-sonnet-4-5');
});

test('all adapters: since filter and zero-token rows', () => {
  const far = Date.parse('2030-01-01');
  assert.strictEqual(codex.load({ dirs: [path.join(FX, 'codex')], since: far }).length, 0);
  assert.strictEqual(copilot.load({ dirs: [path.join(FX, 'copilot', 'session-state')], since: far }).length, 0);
});

test('roo: model comes from the environment details tag', () => {
  const src = { dir: path.join(FX, 'roo', 'tasks'), agent: 'roo', gross: (ts, t) => ts >= Date.parse('2025-11-02') || t.apiProtocol === 'openai', kind: 'tasks' };
  const evs = cline.load({ dirs: [src] });
  assert.notStrictEqual(evs[0].model, 'unknown');
});

test('copilot dotted model ids are priced', () => {
  const pricing = require('../lib/pricing');
  const evs = copilot.load({ dirs: [path.join(FX, 'copilot', 'session-state')] });
  assert.ok(pricing.price(evs[0].model, evs[0].usage) > 0);
});
