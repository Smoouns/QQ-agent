import './isolated-env.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_CONFIG, DATA_DIR, setRuntimeConfig } from '../src/config.js';
import { ChatStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { SessionRegistry } from '../src/sessions.js';
import { selectWindow } from '../src/context.js';
import { buildUserPrompt, buildSystemPrompt } from '../src/prompt.js';
import { addUsage, emptyUsage, cacheHitRate, cacheCoverage } from '../src/llm.js';
import { Orchestrator } from '../src/orchestrator.js';
import { todayKey } from '../src/util.js';

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.sticker.enabled = false; cfg.memory.consolidateEnabled = false;
cfg.store.historyCount = 4;
setRuntimeConfig(cfg);
const store = new ChatStore(), memory = new MemoryStore(path.join(DATA_DIR, 'cache-memory'));
let checks = 0;
const check = async (name, fn) => { await fn(); console.log(`✓ ${++checks}. ${name}`); };
const append = (key, text) => store.appendIncoming(key, { senderId: '123', senderName: '小明', text });
const prompt = (key, trigger, extra = {}) => buildUserPrompt({ chatKey: key, kind: 'group', store, memory, triggerEntries: trigger, selfId: '999', ...extra });

await check('已读迁移、时钟、记忆和管理员变化只改变记录后的动态尾部', () => {
  const key = 'group:901';
  for (let i = 0; i < 4; i++) append(key, `历史${i}`);
  const first = append(key, '新消息？');
  const a = prompt(key, [first], { now: 1700000000000 });
  store.markAllRead(key);
  store.appendSelf(key, { text: '已发送的回复' });
  const second = append(key, '下一条');
  const selectedMemories = [{ record: { id: 'record', version: 1, kind: 'fact', subjectIds: ['qq:123'], status: 'active', evidence: 'direct', content: '新增动态记忆' }, reason: '测试', score: 1 }];
  const b = prompt(key, [second], { now: 1700000900000, selectedMemories });
  const stablePrefix = a.slice(0, a.indexOf('\n\n【当前时间】'));
  assert.ok(b.startsWith(stablePrefix));
  assert.ok(b.indexOf('已发送的回复') < b.indexOf('下一条'));
  assert.equal(b.split('新消息？').length - 1, 1);
  assert.ok(b.indexOf('新增动态记忆') > b.indexOf('【当前时间】'));
  assert.equal(buildSystemPrompt({ entries: [{ senderId: '123' }] }), buildSystemPrompt({ entries: [] }));
});

await check('历史 4→6 保持窗口头，超过后裁回 4；存档和未读不受影响', () => {
  const key = 'group:902';
  for (let i = 0; i < 4; i++) append(key, `${i}`);
  let m = append(key, '4');
  let w = selectWindow(store, key, [m]);
  assert.deepEqual(w.history.map((m) => m.id), [1, 2, 3, 4]);
  m = append(key, '5'); w = selectWindow(store, key, [m]);
  assert.deepEqual(w.history.map((m) => m.id), [1, 2, 3, 4, 5]);
  // A direct admin command selects permissions context without resetting the chat anchor.
  selectWindow(store, key, [m], { limit: 0, trackWindow: false });
  m = append(key, '6'); w = selectWindow(store, key, [m]);
  assert.equal(w.history.length, 6); assert.equal(w.rolledOver, false);
  m = append(key, '7'); w = selectWindow(store, key, [m]);
  assert.deepEqual(w.history.map((m) => m.id), [4, 5, 6, 7]);
  assert.equal(w.rolledOver, true); assert.equal(w.maxHistory, 6);
  assert.equal(store.getChatMeta(key).total, 8); assert.equal(store.unreadCount(key), 8);
  assert.equal(new ChatStore().getChatMeta(key).total, 8);
});

await check('默认历史 80→120；会话独立设置和零历史都有效', () => {
  cfg.store.historyCount = 80;
  const key = 'group:903';
  for (let i = 0; i < 80; i++) append(key, `${i}`);
  let m = append(key, 'first');
  const first = selectWindow(store, key, [m]); assert.equal(first.history.length, 80);
  for (let i = 0; i < 40; i++) m = append(key, `${i}`);
  const grown = selectWindow(store, key, [m]); assert.equal(grown.history.length, 120);
  assert.equal(grown.history[0].id, first.history[0].id);
  m = append(key, 'roll'); assert.equal(selectWindow(store, key, [m]).history.length, 80);
  cfg.store.chatHistoryCounts[key] = 2;
  assert.equal(selectWindow(store, key, [m]).history.length, 2);
  cfg.store.chatHistoryCounts[key] = 0;
  assert.equal(selectWindow(store, key, [m]).history.length, 0);
  assert.equal(selectWindow(store, key, store.peekUnread(key, Infinity)).trigger.length, 122);
});

await check('隐私变化立即过滤历史、重设锚点，不因缓存保留屏蔽消息', () => {
  const key = 'group:904'; cfg.store.chatHistoryCounts[key] = 4;
  for (let i = 0; i < 5; i++) append(key, '需要隐藏');
  const m = store.appendIncoming(key, { senderId: '456', text: '可见' });
  prompt(key, [m]); cfg.blocklist['904'] = ['123'];
  const next = prompt(key, [m]); assert.ok(!next.includes('需要隐藏'));
  assert.deepEqual(selectWindow(store, key, [m]).history, []);
});

await check('缺失缓存字段与明确零命中区分；混合统计仅用已报告输入作分母', () => {
  const unknown = addUsage(emptyUsage(), { prompt_tokens: 100, completion_tokens: 2 });
  assert.equal(cacheHitRate(unknown), null); assert.equal(unknown.cacheUnreportedCalls, 1);
  const zero = addUsage(emptyUsage(), { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(cacheHitRate(zero), 0); assert.equal(zero.cacheReportedCalls, 1);
  const mixed = addUsage(unknown, { prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } });
  assert.equal(cacheHitRate(mixed), 0.5); assert.equal(mixed.promptTokens, 300);
  assert.equal(mixed.cacheReportedPromptTokens, 200);
  assert.equal(mixed.cacheUnreportedCalls, 1);
  assert.equal(cacheHitRate({ promptTokens: 100, cachedTokens: 0 }), null);
  assert.equal(cacheCoverage({ promptTokens: 100, calls: 3 }).cacheUnreportedCalls, 3);
  for (const usage of [{ prompt_cache_hit_tokens: 50 }, { input_tokens_details: { cached_tokens: 50 } }, { total_cached_tokens: 50 }]) {
    assert.equal(cacheHitRate(addUsage(emptyUsage(), { prompt_tokens: 100, ...usage })), 0.5);
  }
});

await check('私聊系统策略独立于群聊，显式旧档位覆盖仍保留', () => {
  cfg.responseRules.groupMode = 'rules'; cfg.store.contextTier = 1;
  const group = buildSystemPrompt({ chatKey: 'group:905' });
  const direct = buildSystemPrompt({ chatKey: 'private:905' });
  assert.ok(!group.includes('【私聊响应策略】')); assert.match(direct, /每批新消息都应/);
  cfg.responseRules.chats['private:906'] = { mode: 'legacy' };
  assert.ok(!buildSystemPrompt({ chatKey: 'private:906' }).includes('【私聊响应策略】'));
});

await check('私聊聚批按独立空隙重置但受最长等待约束，暂停清除计时', async () => {
  const orch = new Orchestrator({ store, memory, sessions: new SessionRegistry(), stickers: {}, sender: {}, onebot: {} });
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    cfg.wakeDelayMs = 9999;
    cfg.responseRules.privateQuietMs = 2000; cfg.responseRules.privateMaxWaitMs = 5000;
    append('private:907', '第一条'); orch.scheduleWake('private:907');
    assert.equal(orch.wakeTimers.get('private:907')._idleTimeout, 2000);
    now += 1500; append('private:907', '第二条'); orch.scheduleWake('private:907');
    assert.equal(orch.wakeTimers.get('private:907')._idleTimeout, 2000);
    now += 3000; append('private:907', '第三条'); orch.scheduleWake('private:907');
    assert.equal(orch.wakeTimers.get('private:907')._idleTimeout, 500);
    const waiting = [...orch.sessions.current.values()].filter((s) => s.chatKey === 'private:907');
    assert.equal(waiting.length, 1); assert.equal(waiting[0].trigger.length, 3);
    cfg.responseRules.chats['private:908'] = { privateQuietMs: 400, privateMaxWaitMs: 1000 };
    append('private:908', '覆盖'); orch.scheduleWake('private:908');
    assert.equal(orch.wakeTimers.get('private:908')._idleTimeout, 400);
    orch.setPaused(true); assert.equal(orch.batchStartedAt.size, 0);
  } finally { Date.now = realNow; await orch.abortAll(); }
});

await check('实际定时器将三条私聊合并一次，下一批仍会独立唤醒', async () => {
  const key = 'private:909';
  cfg.responseRules.chats[key] = { privateQuietMs: 30, privateMaxWaitMs: 1000 };
  const orch = new Orchestrator({ store, memory, sessions: new SessionRegistry(), stickers: {}, sender: {}, onebot: {} });
  const batches = [];
  orch.wake = async () => {
    const ids = store.peekUnread(key, Infinity).map((m) => m.id);
    batches.push(ids); store.acknowledge(key, ids);
  };
  try {
    for (let i = 0; i < 3; i++) { append(key, `连发${i}`); orch.onIncoming(key); }
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(batches, [[1, 2, 3]]);
    append(key, '第二批'); orch.onIncoming(key);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(batches, [[1, 2, 3], [4]]);
  } finally { await orch.abortAll(); }
});

await check('今日统计保留旧数据的不确定性，新增报告不会污染分母', () => {
  const dayKey = todayKey();
  fs.writeFileSync(path.join(DATA_DIR, 'usage-today.json'), JSON.stringify({ dayKey, promptTokens: 1000, completionTokens: 0, totalTokens: 1000, cachedTokens: 0, runs: 2 }));
  const sessions = new SessionRegistry();
  const s = sessions.create({ chatKey: 'private:910', trigger: [] });
  addUsage(s.usage, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } });
  s.usage.calls++;
  const running = sessions.todayUsage(dayKey);
  assert.equal(cacheHitRate(running), 0.5); assert.equal(running.cacheUnreportedCalls, 2);
  sessions.finish(s.id, 'done');
  const saved = sessions.todayUsage(dayKey);
  assert.equal(cacheHitRate(saved), 0.5); assert.equal(saved.cacheUnreportedCalls, 2);
});
console.log(`\n${checks} cache context checks passed`);
