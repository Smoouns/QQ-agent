import './isolated-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { buildToolDefs, executeTool, toOpenAiTools } from '../src/tools.js';
import { MemoryStore } from '../src/memory.js';
import { addUsage, emptyUsage } from '../src/llm.js';
import { modelLabel } from '../src/model-prices.js';
import { queryUsage, usageRange, sessionUsageRows } from '../src/usage-query.js';

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.api.useOfficialPrice = false;
cfg.api.priceInputPerM = cfg.api.priceOutputPerM = cfg.api.priceCachedPerM = 0;
cfg.api.modelPrices = { test: { in: 10, out: 20, cached: 1 }, [modelLabel('special', 'test')]: { in: 100, out: 200, cached: 10 } };
setRuntimeConfig(cfg);
const dir = path.join(DATA_DIR, 'sessions'); fs.mkdirSync(dir, { recursive: true });
const memory = new MemoryStore(path.join(DATA_DIR, 'memory'));
const now = Date.now(), hour = 3600000, at = Math.floor((now - hour) / 1000) * 1000;
const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } };
const normalized = addUsage(emptyUsage(), usage);
const msg = (tokens = usage, time = at, model = 'test') => ({ role: 'assistant', raw: { created: time / 1000, model, usage: tokens } });
const session = (id, chatKey, messages = [msg()]) => ({ id, chatKey, startedAt: at, model: 'test', messages, usage: { promptTokens: 999999, calls: 99 } });
const save = (s) => fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s));
const ctx = { memory, chatKey: 'group:1', sessions: { current: new Map() } };
let count = 0;
async function check(label, fn) { await fn(); console.log(`✓ ${++count}. ${label}`); }

await check('默认滚动七天；北京时间完整结束日；ISO 时区；拒绝无效或反向区间', () => {
  assert.deepEqual(usageRange({}, now), { start: now - 7 * 86400000, end: now });
  assert.deepEqual(usageRange({ start: '2026-11-01', end: '2026-11-01' }), {
    start: Date.parse('2026-10-31T16:00:00Z'), end: Date.parse('2026-11-01T15:59:59.999Z') });
  assert.equal(usageRange({ start: '2026-11-01T00:00:00+08:00' }, now).start, Date.parse('2026-10-31T16:00:00Z'));
  for (const args of [{ start: '2026-02-30' }, { start: 'yesterday' }, { start: 123 }, { start: null },
    { start: '2026-11-06T12:00:00' }, { start: '2026-11-06T24:00:00Z' }, { start: '2027-01-01', end: '2026-01-01' },
    { chatKey: 'private:1' }, []]) assert.throws(() => usageRange(args, now));
});

await check('跨群聊私聊全量统计；逐次 usage 不与运行总计重复；搜索独立纳入总量', () => {
  const a = session('a', 'group:1');
  a.searchUsageCalls = [{ at, model: 'test', usage: normalized, usageReported: true }];
  save(a); save(session('b', 'private:2')); save(session('outside', 'group:3', [msg(usage, now - 8 * 86400000)]));
  const r = queryUsage(ctx, {}, { now });
  assert.equal(r.scope, 'all_chats'); assert.equal(r.total.totalTokens, 3300);
  assert.equal(r.breakdown.chat.totalTokens, 2200); assert.equal(r.breakdown.search.totalTokens, 1100);
  assert.equal(r.total.cachedInputTokens, 600); assert.equal(r.total.calls, 3);
  assert.equal(r.total.estimatedCostCny, 0.0306);
  assert.ok(!JSON.stringify(r).includes('private:2'));
});

await check('活跃运行替代磁盘旧副本，包含尚未落盘的当前调用且只算一次', () => {
  const live = session('a', 'group:1', [msg(), msg()]);
  ctx.sessions.current.set('a', live); ctx.session = live;
  const r = queryUsage(ctx, {}, { now });
  assert.equal(r.total.totalTokens, 3300); // two live chat calls + private chat, stale search excluded
  assert.equal(r.breakdown.search.calls, 0);
  ctx.sessions.current.clear(); delete ctx.session;
});

await check('日期过滤按调用时间且边界包含；可查询七天以前的历史', () => {
  const old = Date.parse('2025-03-01T00:00:00+08:00');
  save({ ...session('dated', 'group:8', [msg(usage, old - 1), msg(usage, old), msg(usage, old + 86400000 - 1), msg(usage, old + 86400000)]), startedAt: old - hour });
  const r = queryUsage(ctx, { start: '2025-03-01', end: '2025-03-01' }, { now });
  assert.equal(r.total.calls, 2); assert.equal(r.total.totalTokens, 2200);
});

await check('新记忆调用保存时间、模型、渠道、缓存；旧累计值不虚构时间且重载后仍可查', () => {
  memory.recordUsage('group:1', usage, { at, model: 'test', vendor: 'special' });
  const db = JSON.parse(fs.readFileSync(memory.file, 'utf8'));
  db.jobs['private:9'] = { usage: { calls: 2, promptTokens: 450, completionTokens: 50, totalTokens: 500 } };
  fs.writeFileSync(memory.file, JSON.stringify(db));
  ctx.memory = new MemoryStore(memory.directory);
  ctx.memory.recordUsage('private:9', { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } }, { at, model: 'test' });
  const ledger = new MemoryStore(memory.directory).usageLedger();
  assert.equal(ledger.calls.length, 2); assert.equal(ledger.untrackedCalls, 2); assert.equal(ledger.untrackedTokens, 500);
  assert.equal(ledger.calls[0].vendor, 'special'); assert.equal(ledger.calls[0].at, at);
  const r = queryUsage(ctx, {}, { now });
  assert.equal(r.breakdown.memory.totalTokens, 2200); assert.equal(r.breakdown.memory.cachedInputTokens, 400);
  assert.equal(r.breakdown.memory.estimatedCostCny, 0.1122);
  assert.equal(r.total.totalTokens, 5500); assert.match(r.notes.join(' '), /2 次旧记忆.*500 token/);
});

await check('未知价格、缺失 usage、损坏文件和旧搜索账本均明确暴露缺口', () => {
  const missing = session('missing', 'group:3', [msg(null), msg(usage, at, 'unknown-model')]);
  missing.webSearchCount = 1;
  missing.searchUsageCalls = undefined;
  missing.messages.push({ toolCall: { name: 'web_search', result: 'truncated' } });
  save(missing); fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const r = queryUsage(ctx, {}, { now });
  assert.equal(r.total.unreportedUsageCalls, 1); assert.equal(r.total.unpricedCalls, 1);
  assert.match(r.notes.join(' '), /不是订阅账单/); assert.match(r.notes.join(' '), /旧运行缺少完整搜索/);
  assert.match(r.notes.join(' '), /1 个存档无法读取/); assert.match(r.notes.join(' '), /仅为可计价部分/);
});

await check('旧运行聚合回退及 Responses token 格式；首次/续轮/收尾归类保持正确', () => {
  const legacy = sessionUsageRows({ id: 'legacy', startedAt: at, usage: { calls: 2, promptTokens: 300, completionTokens: 30 } }).chat[0];
  assert.equal(legacy.calls, 2); assert.equal(legacy.totalTokens, 330); assert.equal(legacy.timeEstimated, true);
  assert.equal(legacy.cacheUnreportedCalls, 2);
  const calls = sessionUsageRows(session('phases', 'group:1', [msg(), msg({ input_tokens: 5, output_tokens: 3 }), { ...msg(), requestPhase: 'finalization' }])).chat;
  assert.deepEqual(calls.map((r) => r.phase), ['first', 'continuation', 'finalization']);
  assert.equal(calls[1].totalTokens, 8);
});

await check('工具通过正式执行入口提供全局汇总，错误参数不会发起模型请求', async () => {
  ctx.session = {};
  const defs = buildToolDefs();
  assert.ok(toOpenAiTools(defs).some((d) => d.function.name === 'usage_query'));
  const result = await executeTool(defs, ctx, 'usage_query', {});
  assert.ok(!result.isError, result.content);
  assert.equal(JSON.parse(result.content).scope, 'all_chats');
  assert.ok(result.content.length < 6000);
  assert.equal((await executeTool(defs, ctx, 'usage_query', { start: 'bad' })).isError, true);
});

console.log(`usage-query: ${count} checks passed`);
