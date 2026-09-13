import './isolated-env.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_RESPONSE_RULES, normalizeResponseRules, responseSettings, ResponseActivity } from '../src/response-rules.js';
import { DEFAULT_CONFIG, DATA_DIR, setRuntimeConfig, updateConfig } from '../src/config.js';
import { ChatStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { SessionRegistry } from '../src/sessions.js';
import { Orchestrator } from '../src/orchestrator.js';

let now = Date.now(), checks = 0;
const defaults = { ...DEFAULT_RESPONSE_RULES, mode: 'rules' };
const entry = (id, senderId = '1', extra = {}) => ({ id, senderId, ts: now, receivedAt: now, allowed: true, ...extra });
async function check(name, fn) { await fn(); console.log(`✓ ${++checks}. ${name}`); }
await check('默认群聊规则、私聊旧档位；会话覆盖、数值边界和删除后继承默认', () => {
  assert.equal(responseSettings({}, 'group:1').mode, 'rules');
  assert.equal(responseSettings({}, 'private:1').mode, 'legacy');
  assert.equal(responseSettings({}, 'group:1').maxPerMinute, 2);
  assert.equal(responseSettings({}, 'group:1').windowMs, 60000);
  assert.equal(responseSettings({}, 'group:1').fallbackMessages, 20);
  const responseRules = normalizeResponseRules({ maxPerMinute: 0, chats: { 'group:1': { silenceEnabled: false, maxPerMinute: 4 },
    'private:2': { mode: 'rules' }, 'private:3': { mode: 'all' }, bad: { mode: 'all' } } });
  assert.equal(responseRules.maxPerMinute, 1); assert.ok(!responseRules.chats.bad);
  assert.equal(responseSettings({ responseRules }, 'group:1').maxPerMinute, 4);
  assert.equal(responseSettings({ responseRules }, 'private:2').mode, 'legacy');
  assert.equal(responseSettings({ responseRules }, 'private:3').mode, 'all');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  updateConfig({ responseRules });
  const next = updateConfig({ responseRules: { chats: { __replace__: {} } } });
  assert.deepEqual(next.responseRules.chats, {});
});
await check('多人热聊与单人连发独立达标，必须等空隙；不按概率抽签', () => {
  const a = new ResponseActivity({ now: () => now });
  a.observe('group:1', Array.from({ length: 6 }, (_, i) => entry(i + 1, String(i % 2))), defaults);
  assert.equal(a.evaluate('group:1', defaults).shouldRespond, false);
  now += 2000; assert.equal(a.evaluate('group:1', defaults).reason, '热聊参与');
  a.observe('group:2', Array.from({ length: 4 }, (_, i) => entry(i + 1)), defaults);
  now += 2000; assert.equal(a.evaluate('group:2', defaults).shouldRespond, false);
  a.observe('group:2', [entry(5)], defaults); now += 2000;
  assert.equal(a.evaluate('group:2', defaults).reason, '热聊参与');
});
await check('持续刷屏最多等待 15 秒，不随新消息无限推迟；过期消息退出热度窗口', () => {
  const a = new ResponseActivity({ now: () => now });
  const s = { ...defaults, fallbackMessages: 0 };
  a.observe('group:1', Array.from({ length: 5 }, (_, i) => entry(i + 1)), s);
  for (let i = 6; i <= 20; i++) { now += 1000; a.observe('group:1', [entry(i)], s); }
  assert.equal(a.evaluate('group:1', s).reason, '热聊参与');
  now += 61000; a.observe('group:1', [], s);
  assert.equal(a.evaluate('group:1', s).shouldRespond, false);
});
await check('冷场按最后人类消息重置，机器人发言取消；模型沉默也只触发一次', () => {
  const a = new ResponseActivity({ now: () => now });
  a.observe('group:1', [entry(1)], defaults); now += 100000;
  a.observe('group:1', [entry(2, '2')], defaults); now += 30000;
  assert.equal(a.evaluate('group:1', defaults).shouldRespond, false);
  now += 90000; assert.equal(a.evaluate('group:1', defaults).reason, '冷场接话');
  a.consume('group:1', 2, true); now += 300000;
  assert.equal(a.evaluate('group:1', defaults).shouldRespond, false);
  a.observe('group:2', [entry(1), entry(2, 'self', { self: true })], defaults); now += 120000;
  assert.equal(a.evaluate('group:2', defaults).shouldRespond, false);
});
await check('滚动一分钟共享两次额度、群间隔离、冷却阻止；跳过不延后补发', () => {
  const a = new ResponseActivity({ now: () => now });
  const s = { ...defaults, silenceMs: 10000 };
  for (let i = 1; i <= 2; i++) {
    a.observe('group:1', [entry(i)], s); now += 20000;
    assert.equal(a.evaluate('group:1', s).shouldRespond, true); a.consume('group:1', i, true);
  }
  a.observe('group:1', [entry(3)], s); now += 10000;
  const denied = a.evaluate('group:1', s);
  assert.equal(denied.reason, '自动参与额度已用完'); assert.ok(denied.drop);
  a.consume('group:1', 3); now += 60000;
  assert.equal(a.evaluate('group:1', s).shouldRespond, false);
  a.observe('group:2', [entry(1)], s); now += 10000;
  assert.equal(a.evaluate('group:2', s).shouldRespond, true);
  a.consume('group:2', 1, true); a.observe('group:2', [entry(2)], s); now += 10000;
  assert.equal(a.evaluate('group:2', s).reason, '自动参与冷却中');
  now += 60000;
  assert.equal(a.evaluate('group:2', { ...s, cooldownMs: 120000 }).reason, '自动参与冷却中');
});
await check('已读标志不影响活动统计，机器人/屏蔽/命令不增加热度，私聊不自动触发', () => {
  const a = new ResponseActivity({ now: () => now });
  a.observe('group:1', [entry(1, '1', { allowed: false }), entry(2, '1', { command: true })], defaults);
  now += 120000; assert.equal(a.evaluate('group:1', defaults).shouldRespond, false);
  a.observe('group:2', [entry(1, '1', { read: true })], defaults); now += 120000;
  assert.equal(a.evaluate('group:2', defaults).shouldRespond, true);
  a.observe('private:1', [entry(1)], defaults); now += 120000;
  assert.equal(a.evaluate('private:1', defaults).shouldRespond, false);
});

await check('保底跨热聊窗口与已读批次累计，20 条触发一次，模型处理后清零', () => {
  const a = new ResponseActivity({ now: () => now });
  const s = { ...defaults, hotEnabled: false, silenceEnabled: false };
  for (let i = 1; i <= 20; i++) {
    now += 70000; a.observe('group:1', [entry(i, '1', { read: true })], s);
    assert.equal(a.evaluate('group:1', s).shouldRespond, false);
  }
  now += 2000; a.observe('group:1', [], s);
  const result = a.evaluate('group:1', s);
  assert.equal(result.reason, '保底参与'); assert.match(result.detail, /累计 20 条/);
  assert.equal(a.state('group:1').messages.length, 1);
  a.consume('group:1', 20, true); now += 120000;
  assert.equal(a.state('group:1').unanswered.length, 0);
  assert.equal(a.evaluate('group:1', s).shouldRespond, false);
});
await check('保底可设为 15 或关闭，排除命令与屏蔽消息，机器人发言重置', () => {
  const a = new ResponseActivity({ now: () => now });
  const s = { ...defaults, hotEnabled: false, silenceEnabled: false, fallbackMessages: 15 };
  a.observe('group:1', Array.from({ length: 14 }, (_, i) => entry(i + 1)), s);
  a.observe('group:1', [entry(15, '1', { command: true }), entry(16, '1', { allowed: false })], s);
  now += 2000; assert.equal(a.evaluate('group:1', s).shouldRespond, false);
  a.observe('group:1', [entry(17)], s); now += 2000;
  assert.equal(a.evaluate('group:1', s).reason, '保底参与');
  assert.equal(a.evaluate('private:1', s).shouldRespond, false);
  a.observe('group:1', [], { ...s, fallbackMessages: 0 });
  assert.equal(a.evaluate('group:1', { ...s, fallbackMessages: 0 }).shouldRespond, false);
  a.observe('group:1', [entry(18, 'self', { self: true })], s);
  assert.equal(a.state('group:1').unanswered.length, 0);
  const override = responseSettings({ responseRules: { chats: { 'group:1': { fallbackMessages: 15 } } } }, 'group:1');
  assert.equal(override.fallbackMessages, 15);
});
await check('保底被限流时保留计数但不自动补发，后续新消息才重新判断', () => {
  const a = new ResponseActivity({ now: () => now });
  const s = { ...defaults, hotEnabled: false, silenceEnabled: false, fallbackMessages: 3, maxPerMinute: 1 };
  a.consume('group:1', 0, true);
  a.observe('group:1', [entry(1), entry(2), entry(3)], s); now += 2000;
  assert.equal(a.evaluate('group:1', s).reason, '自动参与额度已用完');
  a.consume('group:1', 3, false, { preserveFallback: true });
  now += 60000; a.observe('group:1', [], s);
  assert.equal(a.evaluate('group:1', s).shouldRespond, false);
  assert.equal(a.state('group:1').unanswered.length, 3);
  a.observe('group:1', [entry(4)], s); now += 2000;
  assert.equal(a.evaluate('group:1', s).reason, '保底参与');
  a.consume('group:1', 4, true); assert.equal(a.state('group:1').unanswered.length, 0);
});
await check('一分钟热聊窗口能够合并相隔 35 秒的两组发言', () => {
  const a = new ResponseActivity({ now: () => now });
  a.observe('group:1', [entry(1, '1'), entry(2, '1'), entry(3, '1')], defaults);
  now += 35000;
  a.observe('group:1', [entry(4, '2'), entry(5, '2'), entry(6, '2')], defaults);
  now += 2000;
  assert.equal(a.evaluate('group:1', defaults).reason, '热聊参与');
});

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.allowAllWhenEmpty = true; cfg.memory.consolidateEnabled = false; cfg.sticker.enabled = false;
cfg.api.model = 'local-mock'; cfg.api.vision = false; cfg.webSearch.enabled = false;
cfg.responseRules.silenceMs = 10000; cfg.store.historyCount = 0;
setRuntimeConfig(cfg);
let calls = 0;
const server = http.createServer(async (req, res) => {
  for await (const ignored of req) { /* drain mock request */ }
  calls++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }], usage: { prompt_tokens: 1, completion_tokens: 0 } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
cfg.api.baseUrl = `http://127.0.0.1:${server.address().port}`;
const realNow = Date.now;
Date.now = () => now;
const store = new ChatStore(), sessions = new SessionRegistry();
const orch = new Orchestrator({ store, sessions, memory: new MemoryStore(path.join(DATA_DIR, 'rule-memory')), stickers: {}, sender: {},
  onebot: { selfId: '999', selfNickname: 'bot', getGroupInfo: async () => ({ group_name: '测试群' }) } });
orch.responseActivity.now = () => now;
orch.scheduleWake = () => {};
const append = (key, text = '普通消息', extra = {}) => {
  const m = store.appendIncoming(key, { senderId: '123', text, mid: store.boundary(key) + 1, ...extra });
  orch.onIncoming(key); return m;
};
try {
  await check('编排器跳过的原话继续存档；零历史窗口也能将已读冷场消息发送模型一次', async () => {
    const m = append('group:10'); const before = calls;
    await orch.wake('group:10'); assert.equal(calls, before); assert.equal(store.unreadCount('group:10'), 0);
    now += 10000; await orch.wake('group:10'); assert.equal(calls, before + 1);
    const session = sessions.get(sessions.index[0].id);
    assert.equal(session.responseDecision.reason, '冷场接话'); assert.equal(session.autoParticipationCharged, true);
    assert.deepEqual(session.contextSelection.triggerIds, [m.id]);
    now += 120000; await orch.wake('group:10'); assert.equal(calls, before + 1);
    assert.equal(store.findByLocalId('group:10', m.id).text, '普通消息');
  });
  await check('实际模型运行受两次额度限制，@ 和引用机器人不占额度', async () => {
    const key = 'group:11', before = calls;
    for (let i = 0; i < 2; i++) { append(key); now += 20000; await orch.wake(key); }
    assert.equal(calls, before + 2);
    append(key); now += 10000; await orch.wake(key); assert.equal(calls, before + 2);
    append(key, '@bot'); await orch.wake(key); assert.equal(calls, before + 3);
    append(key, '接着问', { reply: { senderId: '999', mid: '8888' } }); await orch.wake(key);
    assert.equal(calls, before + 4); assert.equal(orch.responseActivity.state(key).calls.length, 2);
  });
  await check('每群参数覆盖与私聊默认旧档位，配置热修改不会补发旧候选', async () => {
    cfg.responseRules.chats['group:12'] = { mode: 'direct' };
    append('group:12'); now += 120000; const before = calls;
    await orch.wake('group:12'); assert.equal(calls, before);
    append('private:123'); await orch.wake('private:123'); assert.equal(calls, before + 1);
    cfg.responseRules.chats['private:123'] = { mode: 'direct' };
    append('private:123'); await orch.wake('private:123'); assert.equal(calls, before + 1);
    append('group:13'); cfg.responseRules.chats['group:13'] = { silenceMs: 20000 };
    now += 30000; await orch.wake('group:13'); assert.equal(calls, before + 1);
  });
  await check('等待期间禁用、暂停、屏蔽或移出白名单会取消候选', async () => {
    const before = calls;
    append('group:14'); cfg.responseRules.chats['group:14'] = { mode: 'direct' }; now += 10000; await orch.wake('group:14');
    append('group:15'); orch.setPaused(true); now += 10000; await orch.wake('group:15'); orch.setPaused(false); await orch.wake('group:15');
    append('group:16'); cfg.blocklist = { '16': ['123'] }; now += 10000; await orch.wake('group:16');
    append('group:17'); cfg.deny.groups = ['17']; now += 10000; await orch.wake('group:17');
    assert.equal(calls, before); cfg.blocklist = {}; cfg.deny.groups = [];
  });
  await check('并发满时丢弃自动候选，避免释放后补发', async () => {
    append('group:18'); now += 10000; const before = calls;
    orch.runningChats.add('group:other1'); orch.runningChats.add('group:other2');
    await orch.wake('group:18'); orch.runningChats.clear();
    await orch.wake('group:18'); assert.equal(calls, before);
  });
  await check('旧存档不在重启后自动捧场，运行期新消息才启动统计', async () => {
    store.appendIncoming('group:19', { senderId: '123', text: '旧消息', ts: now - 1000000 });
    orch.onIncoming('group:19'); now += 10000; const before = calls;
    await orch.wake('group:19'); assert.equal(calls, before);
    append('group:19'); now += 10000; await orch.wake('group:19'); assert.equal(calls, before + 1);
  });
  await check('实际热聊累计跨越已读批次，防抖计时受最长等待限制', async () => {
    const key = 'group:20', before = calls;
    for (let i = 0; i < 5; i++) { append(key); await orch.wake(key); }
    assert.equal(calls, before); assert.equal(store.unreadCount(key), 0);
    Orchestrator.prototype.scheduleWake.call(orch, key, 60000);
    assert.ok(orch.wakeTimers.get(key)._idleTimeout <= 15000);
    clearTimeout(orch.wakeTimers.get(key)); orch.pendingWake.delete(key);
    now += 2000; await orch.wake(key); assert.equal(calls, before + 1);
    assert.equal(sessions.get(sessions.index[0].id).responseDecision.reason, '热聊参与');
  });
  await check('定时检查无需新消息即可触发冷场，实际自发回复会取消其他群的候选', async () => {
    // Clear earlier test candidates; activity counters and quotas remain isolated by chat.
    for (const key of orch.responseActivity.states.keys()) orch.responseActivity.consume(key, store.boundary(key));
    append('group:21'); await orch.wake('group:21');
    append('group:22'); await orch.wake('group:22'); store.appendSelf('group:22', { text: '已经回复' });
    const before = calls; now += 10000; await orch.tickResponseRules();
    for (let i = 0; i < 100 && orch.runningChats.size; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, before + 1); assert.equal(orch.runningChats.size, 0);
    await orch.tickResponseRules(); assert.equal(calls, before + 1);
  });
  await check('异步准备期间停用规则会在第一次模型请求前拦截且不扣额度', async () => {
    append('group:23'); now += 10000; const before = calls;
    const old = orch.onebot.getGroupInfo;
    orch.onebot.getGroupInfo = async () => { cfg.responseRules.chats['group:23'] = { mode: 'direct' }; return {}; };
    try { await orch.wake('group:23'); } finally { orch.onebot.getGroupInfo = old; }
    assert.equal(calls, before); assert.equal(orch.responseActivity.state('group:23').calls.length, 0);
  });
  await check('热聊达到最长等待后，新消息不使准备中的请求饿死，消息边界保持固定', async () => {
    const key = 'group:24';
    for (let i = 0; i < 5; i++) append(key);
    now += 15000; const before = calls;
    const old = orch.onebot.getGroupInfo;
    orch.onebot.getGroupInfo = async () => { append(key, '准备请求期间到达'); return {}; };
    try { await orch.wake(key); } finally { orch.onebot.getGroupInfo = old; }
    assert.equal(calls, before + 1);
    assert.equal(store.unreadCount(key), 1);
    const session = sessions.get(sessions.index[0].id);
    assert.deepEqual(session.contextSelection.triggerIds, [1, 2, 3, 4, 5]);
    assert.equal(orch.responseActivity.state(key).handled, 5);
  });
  await check('实际保底在已读消息上触发模型，保留准备期间的新消息计数', async () => {
    const key = 'group:25', before = calls;
    cfg.responseRules.chats[key] = { hotEnabled: false, silenceEnabled: false, fallbackMessages: 3 };
    for (let i = 0; i < 3; i++) { append(key); await orch.wake(key); now += 3000; }
    assert.equal(calls, before); assert.equal(store.unreadCount(key), 0);
    now += 15000;
    const old = orch.onebot.getGroupInfo;
    orch.onebot.getGroupInfo = async () => { append(key, '下一轮的新消息'); return {}; };
    try { await orch.wake(key); } finally { orch.onebot.getGroupInfo = old; }
    assert.equal(calls, before + 1);
    assert.equal(sessions.get(sessions.index[0].id).responseDecision.reason, '保底参与');
    assert.deepEqual(orch.responseActivity.state(key).unanswered.map((m) => m.id), [4]);
  });
} finally {
  await orch.abortAll(); Date.now = realNow;
  await new Promise((r) => server.close(r));
}
console.log(`\n${checks} response rule checks passed`);
