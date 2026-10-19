'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pricing = require('../lib/pricing');
const fmt = require('../lib/format');
const attr = require('../lib/attribute');
const report = require('../lib/report');
const cc = require('../lib/adapters/claude-code');
const { claudeEvent, line } = require('./helpers');

test('pricing: exact, prefix and bedrock lookups, no false prefix match', () => {
  const c = pricing.price('claude-sonnet-4-5-20250929', { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 });
  assert.strictEqual(Number(c.toFixed(2)), 3 + 15 + 3.75 + 0.3);
  assert.deepStrictEqual(pricing.lookup('claude-opus-4-1-20250805'), pricing.BUILTIN['claude-opus-4-1']);
  assert.ok(pricing.lookup('claude-sonnet-4-6'), 'current model priced from snapshot');
  assert.ok(pricing.lookup('us.anthropic.claude-opus-5-5-v1:0'), 'bedrock id normalizes');
  assert.ok(pricing.lookup('claude-opus-5-5-fast'), 'non-numeric suffix falls back to base');
  assert.strictEqual(pricing.lookup('claude-opus-4-10'), null, 'newer version never priced as older');
  assert.strictEqual(pricing.price('mystery-9', { input: 10 }), null);
  assert.match(pricing.asOf(), /^\d{4}-\d{2}-\d{2}$/);
});

test('pricing: snapshot prefers plain Anthropic entries and newest dated id', () => {
  const t = pricing.fromLiteLLM({
    'anthropic.claude-3-7-sonnet-20240620-v1:0': { input_cost_per_token: 3.6e-6, output_cost_per_token: 18e-6, cache_read_input_token_cost: 0.36e-6 },
    'anthropic.claude-3-7-sonnet-20250219-v1:0': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 0.3e-6 },
    'claude-opus-4.5': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
    'claude-opus-4-5': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 0.5e-6 },
  });
  assert.strictEqual(t['claude-3-7-sonnet'].input, 3);
  assert.strictEqual(t['claude-opus-4.5'], undefined, 'dotted duplicate dropped');
  assert.strictEqual(t['claude-opus-4-5'].cacheRead, 0.5);
});

test('format: trailer round-trips in both plan framings', () => {
  const sum = { tokens: 2140331, cacheRead: 1800000, cacheWrite: 0, cost: 1.4213, unpricedTokens: 0, activeMinutes: 98,
    agents: { 'claude-code': true }, models: { 'claude-sonnet-5-5': {} } };
  const sub = fmt.trailer(sum);
  assert.strictEqual(sub, '2.1M tok (1.8M cached) | 1h 38m | claude-code/sonnet-5-5 | ~$1.42 API-equiv');
  const api = fmt.trailer(sum, { plan: 'api' });
  assert.strictEqual(api, '2.1M tok (1.8M cached) | 1h 38m | claude-code/sonnet-5-5 | $1.42 est.');
  for (const v of [sub, api]) {
    const p = fmt.parseTrailer(v);
    assert.strictEqual(p.tokens, 2100000);
    assert.strictEqual(p.cached, 1800000);
    assert.strictEqual(p.minutes, 98);
    assert.strictEqual(p.cost, 1.42);
    assert.deepStrictEqual(p.agents, ['claude-code']);
    assert.deepStrictEqual(p.models, ['sonnet-5-5']);
  }
  assert.strictEqual(fmt.parseTrailer(sub).plan, 'subscription');
  assert.strictEqual(fmt.parseTrailer(api).plan, 'api');
  const unpriced = fmt.trailer({ ...sum, cost: 0, unpricedTokens: 5 });
  assert.match(unpriced, /\? \(unpriced model\)$/);
  assert.strictEqual(fmt.parseTrailer(unpriced).cost, null);
  assert.strictEqual(fmt.parseTrailer('garbage'), null);
  assert.strictEqual(fmt.trailer({ ...sum, tokens: 0 }), null);
});

test('adapter claude-code: parses, dedupes streamed duplicates, skips user/synthetic/zero rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  const u = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };
  fs.writeFileSync(path.join(dir, 'a.jsonl'),
    claudeEvent({ ts: 1000, cwd: '/r', id: 'm1', req: 'r1', usage: u }) +
    claudeEvent({ ts: 1000, cwd: '/r', id: 'm1', req: 'r1', usage: u }) +
    claudeEvent({ ts: 2000, cwd: '/r', id: 'm2', req: 'r2', usage: u }) +
    claudeEvent({ ts: 3000, cwd: '/r', id: 'm3', req: 'r3', usage: u, type: 'user' }) +
    claudeEvent({ ts: 4000, cwd: '/r', id: 'm4', req: 'r4', usage: u, model: '<synthetic>' }) +
    claudeEvent({ ts: 5000, cwd: '/r', id: 'm5', req: 'r5', usage: { input_tokens: 0, output_tokens: 0 } }) +
    claudeEvent({ ts: 6000, cwd: '/r', id: 'm6', req: 'r6', usage: { input_tokens: '7', output_tokens: null } }) +
    'not json\n' + line({ type: 'assistant', timestamp: 'bad', message: { usage: u } })
  );
  const ev = cc.load({ dirs: [dir] });
  assert.strictEqual(ev.length, 3);
  assert.deepStrictEqual(ev[0].usage, { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 });
  assert.deepStrictEqual(ev[2].usage, { input: 7, output: 0, cacheWrite: 0, cacheRead: 0 }, 'strings coerced');
  assert.strictEqual(ev[0].agent, 'claude-code');
});

test('attribute: window, repo prefix trap, summary with agents', () => {
  const u = { input: 100, output: 100, cacheWrite: 0, cacheRead: 0 };
  const events = [
    { ts: 10 * 60000, cwd: '/repo', model: 'claude-sonnet-4-5', usage: u, sessionId: 'a', agent: 'claude-code' },
    { ts: 11 * 60000, cwd: '/repo/sub', model: 'claude-sonnet-4-5', usage: u, sessionId: 'a', agent: 'claude-code' },
    { ts: 11 * 60000 + 5, cwd: '/repo/sub', model: 'gpt-5', usage: u, sessionId: 'b', agent: 'codex' },
    { ts: 12 * 60000, cwd: '/repository', model: 'claude-sonnet-4-5', usage: u, sessionId: 'c', agent: 'claude-code' },
    { ts: 5 * 60000, cwd: '/repo', model: 'claude-sonnet-4-5', usage: u, sessionId: 'a', agent: 'claude-code' },
  ];
  const sel = attr.select(events, { repoRoot: '/repo', since: 9 * 60000 });
  assert.strictEqual(sel.length, 3);
  const s = attr.summarize(sel);
  assert.strictEqual(s.tokens, 600);
  assert.strictEqual(s.sessions, 2);
  assert.strictEqual(s.activeMinutes, 2);
  assert.deepStrictEqual(Object.keys(s.agents).sort(), ['claude-code', 'codex']);
});

test('report: since parsing and grouping', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.strictEqual(report.parseSince('30d', now), now - 30 * 864e5);
  assert.strictEqual(report.parseSince('2w', now), now - 14 * 864e5);
  assert.strictEqual(report.parseSince('2026-10-01', now), Date.parse('2026-10-01'));
  assert.throws(() => report.parseSince('soon', now));
  const u = { input: 100, output: 0, cacheWrite: 0, cacheRead: 0 };
  const rows = report.group([
    { ts: now, cwd: '/a', model: 'm', usage: u, sessionId: '1', agent: 'codex' },
    { ts: now, cwd: '/a', model: 'm', usage: { ...u, input: 300 }, sessionId: '1', agent: 'codex' },
    { ts: now, cwd: '/b', model: 'm', usage: u, sessionId: '2', agent: 'claude-code' },
  ], 'agent');
  assert.deepStrictEqual(rows.map(r => r.key), ['codex', 'claude-code']);
  assert.strictEqual(rows[0].summary.tokens, 400);
});
