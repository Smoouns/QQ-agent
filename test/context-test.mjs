import './isolated-env.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { ChatStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { SessionRegistry } from '../src/sessions.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SendQueue } from '../src/sender.js';
import { buildUserPrompt, buildSystemPrompt } from '../src/prompt.js';
import { buildToolDefs } from '../src/tools.js';
import { selectWindow, recallMemories, primarySubjects, assertContextAllowed, historyCount } from '../src/context.js';
import { DATA_DIR, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';

const cfg = structuredClone(DEFAULT_CONFIG);
// These existing integration scenarios explicitly exercise the legacy response gate.
cfg.responseRules.groupMode = 'legacy';
cfg.providersImported = true;
cfg.memory.consolidateEnabled = false;
cfg.sticker.enabled = false;
cfg.persona.roleText = '唯一的固定角色文本';
cfg.persona.selfNickname = '机器人';
cfg.api.model = 'context-test';
cfg.api.provider = '';
cfg.api.apiKey = '';
cfg.webSearch.enabled = false;
setRuntimeConfig(cfg);
const store = new ChatStore(2), memory = new MemoryStore(path.join(DATA_DIR, 'context-memory'));
let count = 0;
async function check(name, fn) { await fn(); console.log(`✓ ${++count}. ${name}`); }
let mid = 100;
const append = (chatKey, text, extra = {}) => store.appendIncoming(chatKey, { mid: ++mid, senderId: '123', senderName: '小明', text, ...extra });
const record = (content, extra = {}) => memory.saveRecord({ kind: 'fact', subjectIds: ['123'], visibility: { type: 'chats', chatKeys: ['group:1'] }, content, ...extra });
const tool = (name, ctx, args = {}) => buildToolDefs().find((t) => t.name === name).execute(ctx, args);

await check('旧存档上限不再删除消息，重启与转发展开保留原文', () => {
  for (let i = 0; i < 12; i++) append('group:10', `原话${i}`);
  store.setMaxPerChat(1); store.appendSelf('group:10', { text: '自己的回复' });
  assert.equal(new ChatStore(1).getChatMeta('group:10').total, 13);
  const first = store.findByLocalId('group:10', 1);
  store.updateByMid('group:10', first.mid, { text: '展开内容' });
  assert.equal(store.findByLocalId('group:10', 1).originalText, '原话0');
  const brokenFile = path.join(DATA_DIR, 'messages', 'group_999.json');
  fs.writeFileSync(brokenFile, '{broken');
  assert.throws(() => new ChatStore().appendIncoming('group:999', { text: '不能覆盖' }));
  assert.equal(fs.readFileSync(brokenFile, 'utf8'), '{broken');
});

await check('窗口先过滤再取足 N 条，触发完整且包含交错的自己回复', () => {
  for (let i = 0; i < 10; i++) append('group:11', `历史${i}`, { senderId: i % 2 ? '999' : '123' });
  store.markAllRead('group:11');
  const a = append('group:11', '问题一');
  const self = store.appendSelf('group:11', { text: '上一轮的回复' });
  const b = append('group:11', '问题二');
  cfg.blocklist = { '11': ['999'] };
  const before = JSON.stringify(store.recent('group:11'));
  const w = selectWindow(store, 'group:11', [a, b], { limit: 4 });
  assert.deepEqual(w.history.map((m) => m.id), [3, 5, 7, 9]);
  assert.deepEqual(w.trigger.map((m) => m.id), [a.id, b.id]);
  assert.deepEqual(w.interleaved.map((m) => m.id), [self.id]);
  assert.equal(JSON.stringify(store.recent('group:11')), before);
  append('group:11', '下一批');
  assert.equal(w.boundary, b.id);
  assert.equal(w.history.length, 4);
});

await check('零历史窗口、会话覆盖、慢群跨日记录', () => {
  cfg.store.historyCount = 3;
  cfg.store.chatHistoryCounts = { 'group:12': 0 };
  assert.equal(historyCount('group:12'), 0);
  assert.equal(historyCount('group:13'), 3);
  append('group:12', '昨天', { ts: Date.now() - 86400000 }); store.markAllRead('group:12');
  const m = append('group:12', '今天');
  assert.equal(selectWindow(store, 'group:12', [m]).history.length, 0);
  assert.equal(selectWindow(store, 'group:12', [m], { limit: 1 }).history[0].text, '昨天');
});

await check('引用按消息 ID 补齐且去重，人物使用 QQ 和结构化 @', () => {
  const old = append('group:13', '上周约好了', { senderId: '456' });
  append('group:13', '后续'); store.markAllRead('group:13');
  const m = append('group:13', '这个约定还算数吗', { reply: { mid: old.mid }, mentions: ['789'] });
  const w = selectWindow(store, 'group:13', [m], { limit: 1 });
  assert.deepEqual(w.quotes.map((x) => x.id), [old.id]);
  assert.deepEqual(primarySubjects([m], store, 'group:13').sort(), ['qq:123', 'qq:456', 'qq:789']);
});

await check('分页使用固定游标，新消息、自己回复和屏蔽记录不导致重页', async () => {
  const ctx = { chatKey: 'group:11', store, session: { contextSelection: { boundary: 13, beforeLocalId: 7 } } };
  const a = JSON.parse((await tool('get_recent_messages', ctx, { limit: 2 })).content);
  assert.deepEqual(a.messages.map((m) => m.localId), [3, 5]);
  append(ctx.chatKey, '分页时又来了');
  const b = JSON.parse((await tool('get_recent_messages', ctx, { limit: 2, beforeLocalId: a.nextBeforeLocalId })).content);
  assert.deepEqual(b.messages.map((m) => m.localId), [1]);
  assert.equal(b.hasMore, false);
  const c = JSON.parse((await tool('get_recent_messages', ctx, { limit: 2 })).content);
  assert.deepEqual(c.messages, a.messages);
});

const preference = record('喜欢策略游戏', { kind: 'preference', visibility: { type: 'global' } });
record('周日联机不能公开的私聊秘密', { visibility: { type: 'chats', chatKeys: ['private:123'] } });
record('咖啡偏好与饮食', { kind: 'preference', pinned: true });
record('喜欢称呼小明', { kind: 'interaction' });
let event = record('小明和小红周六联机', { title: '周末联机', kind: 'commitment', subjectIds: ['123', '456'], status: 'pending' });
event = memory.saveRecord({ id: event.id, content: '小明和小红改到周日联机' }, { expectedVersion: event.version });
record('已经完成的联机活动', { kind: 'event', status: 'completed' });

await check('召回优先当前话题，未完成和已完成经历均可命中；固定无关项不强塞', () => {
  const rs = recallMemories(memory, 'group:1', { query: '周末联机还是周日吗，玩策略游戏？', subjectIds: ['qq:123', 'qq:456'] });
  assert.ok(rs.some((x) => x.record.id === preference.id));
  assert.equal(rs.filter((x) => x.record.id === event.id).length, 1);
  assert.ok(rs.some((x) => x.record.status === 'completed'));
  assert.ok(rs.length <= 8);
  assert.ok(!rs.some((x) => /咖啡|秘密|周六/.test(x.record.content)));
  assert.equal(recallMemories(memory, 'group:1', { query: '火星地质', subjectIds: [] }).length, 0);
});

await check('同 QQ 跨群使用全局偏好，群和私聊专属内容不跨范围', () => {
  const rs = recallMemories(memory, 'group:2', { query: '策略游戏周日联机', subjectIds: ['qq:123'] });
  assert.deepEqual(rs.map((x) => x.record.id), [preference.id]);
});

await check('工具按主题检索、按 ID 展开旧版本，历史也检查可见范围', async () => {
  const ctx = { chatKey: 'group:1', store, memory, session: {} };
  const found = JSON.parse((await tool('memory_query', ctx, { query: '联机', userId: '123' })).content);
  assert.ok(found.records.some((r) => r.id === event.id));
  const detail = JSON.parse((await tool('memory_query', ctx, { recordId: event.id, includeHistory: true })).content);
  assert.ok(detail.record.history[0].content.includes('周六'));
  const secret = memory.listRecords({ chatKey: 'private:123' }).find((r) => r.content.includes('秘密'));
  const broadened = memory.saveRecord({ id: secret.id, visibility: { type: 'global' } }, { expectedVersion: secret.version });
  const outside = JSON.parse((await tool('memory_query', ctx, { recordId: broadened.id, includeHistory: true })).content);
  assert.equal(outside.record.history.length, 0);
  assert.equal(outside.record.sources.length, 0);
  memory.deleteRecord(broadened.id, broadened.version);
});

let promptSession;
await check('输入按环境、记忆、历史、引用、新消息组装；人设只进 system', () => {
  const old = append('group:1', '联机讨论'); store.markAllRead('group:1');
  const m = append('group:1', '策略游戏周日联机？', { reply: { mid: old.mid } });
  promptSession = {};
  const input = buildUserPrompt({ chatKey: 'group:1', kind: 'group', chatId: '1', store, memory, triggerEntries: [m], session: promptSession, contextLimit: 0 });
  const markers = ['【当前时间】', '【记忆】', '【过去状态】', '【引用补充】', '【本次唤醒】'];
  assert.deepEqual(markers.map((s) => input.indexOf(s)), markers.map((s) => input.indexOf(s)).sort((a, b) => a - b));
  assert.ok(input.includes('QQ:123') && input.includes('#'));
  assert.ok(!input.includes(cfg.persona.roleText));
  assert.ok(!input.includes('undefined'));
  assert.ok(buildSystemPrompt().includes(cfg.persona.roleText));
  assert.equal(promptSession.contextSelection.boundary, m.id);
  assert.ok(promptSession.contextSelection.memories.some((r) => r.id === preference.id));
});

await check('运行中删记忆或改变屏蔽名单阻止继续使用', () => {
  assert.doesNotThrow(() => assertContextAllowed(promptSession, memory, 'group:1'));
  cfg.blocklist['1'] = ['999'];
  assert.throws(() => assertContextAllowed(promptSession, memory, 'group:1'), /范围/);
  delete cfg.blocklist['1'];
  memory.deleteRecord(preference.id, preference.version);
  assert.throws(() => assertContextAllowed(promptSession, memory, 'group:1'), /记忆/);
});

await check('记忆候选很多时保持两路上限，过期和屏蔽记录不进入召回', async () => {
  for (let i = 0; i < 12; i++) record(`航海活动第${i}次`, { kind: i < 3 ? 'preference' : 'event', visibility: { type: 'chats', chatKeys: ['group:30'] } });
  record('航海过期约定', { kind: 'event', expiresAt: Date.now() - 1, visibility: { type: 'chats', chatKeys: ['group:30'] } });
  record('航海被屏蔽者消息', { kind: 'event', subjectIds: ['999'], visibility: { type: 'chats', chatKeys: ['group:30'] } });
  cfg.blocklist['30'] = ['999'];
  const rs = recallMemories(memory, 'group:30', { query: '航海活动', subjectIds: ['qq:123'] });
  assert.equal(rs.length, 8);
  assert.ok(!rs.some((x) => /过期|屏蔽/.test(x.record.content)));
  const old = append('group:30', '被屏蔽原话', { senderId: '999' });
  const boundary = store.boundary('group:30');
  const later = append('group:30', '边界之后的新消息');
  const ctx = { chatKey: 'group:30', store, memory, session: { contextSelection: { boundary, beforeLocalId: boundary + 1 } } };
  assert.equal((await tool('get_message_detail', ctx, { messageId: old.mid })).isError, true);
  assert.equal((await tool('get_message_detail', ctx, { messageId: later.mid })).isError, true);
});

const requests = [];
let responder = () => ({ content: '' });
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const msg = await responder(body);
  if (msg.error) { res.writeHead(msg.error); res.end('mock failure'); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...msg } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
cfg.api.baseUrl = `http://127.0.0.1:${server.address().port}`;
const sessions = new SessionRegistry();
const onebot = { selfId: '888', selfNickname: '机器人', getGroupInfo: async () => ({ group_name: '测试群' }) };
const orch = new Orchestrator({ store, memory, sessions, onebot, stickers: {}, sender: {}, emit: () => {} });
// This suite explicitly drives each wake; no live QQ, auto timers or background models.
const scheduled = [];
orch.scheduleWake = (chatKey) => scheduled.push(chatKey);
const lastSession = () => sessions.get(sessions.index[0]?.id);
const call = (name, args = {}) => ({ id: `tool_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
try {
  await check('第 201 条的 @ 仍触发；触发条件与历史条数独立', async () => {
    cfg.store.contextTier = 1; cfg.store.historyCount = 4;
    for (let i = 0; i < 8; i++) append('group:20', `旧${i}`);
    store.markAllRead('group:20');
    for (let i = 0; i < 201; i++) append('group:20', i === 200 ? '@机器人' : '普通');
    await orch.wake('group:20');
    assert.ok(requests.at(-1).tools.some((t) => t.function.name === 'get_group_members'));
    assert.equal(lastSession().contextSelection.triggerIds.length, 201);
    assert.equal(lastSession().contextSelection.historyIds.length, 4);
    assert.equal(store.unreadCount('group:20'), 0);
  });

  await check('运行启动后的入站消息留到下次；本轮工具结果保留，下轮清空', async () => {
    cfg.store.contextTier = 4;
    append('group:21', '第一批');
    onebot.getGroupInfo = async () => { append('group:21', '运行期间到达'); return { group_name: '测试群' }; };
    let round = 0;
    responder = () => ++round === 1 ? { tool_calls: [call('get_recent_messages')] } : { content: '' };
    const start = requests.length;
    await orch.wake('group:21');
    assert.ok(!requests[start].messages[1].content.includes('运行期间到达'));
    assert.ok(requests[start + 1].messages.some((m) => m.role === 'tool'));
    assert.equal(store.unreadCount('group:21'), 1);
    await orch.wake('group:21');
    assert.equal(requests.at(-1).messages.length, 2);
    assert.ok(requests.at(-1).messages[1].content.includes('运行期间到达'));
  });

  await check('防抖期间与实际运行共用同一次随机判定', async () => {
    cfg.store.contextTier = 3; cfg.store.randomPercent = 10;
    append('group:26', '随机聊天');
    const random = Math.random;
    try {
      Math.random = () => 0.05;
      Orchestrator.prototype.scheduleWake.call(orch, 'group:26', 60000);
      Math.random = () => 0.99;
      append('group:26', '聚批后续');
      Orchestrator.prototype.scheduleWake.call(orch, 'group:26', 60000);
      assert.equal(orch.gateRolls.get('group:26'), 5);
      clearTimeout(orch.wakeTimers.get('group:26'));
      const waitingSessionId = orch.pendingSessions.get('group:26');
      orch.pendingSessions.delete('group:26'); orch.pendingWake.delete('group:26');
      responder = () => ({ content: '' });
      await orch.wake('group:26', { waitingSessionId });
      assert.equal(lastSession().contextReason, '随机命中(5%)');
      assert.equal(orch.gateRolls.has('group:26'), false);
    } finally { Math.random = random; cfg.store.contextTier = 4; clearTimeout(orch.wakeTimers.get('group:26')); }
  });

  await check('整轮重试复用初始提示词，不混入后来更新的记忆', async () => {
    append('group:27', '重试测试联机');
    let n = 0;
    const start = requests.length;
    responder = () => {
      n++;
      if (n === 3) record('重试测试联机后加入的新记忆', { visibility: { type: 'global' }, kind: 'event' });
      return n <= 3 ? { error: 500 } : { content: '' };
    };
    await orch.wake('group:27');
    assert.equal(n, 4);
    assert.equal(requests[start].messages[1].content, requests.at(-1).messages[1].content);
    assert.ok(!requests.at(-1).messages[1].content.includes('后加入的新记忆'));
  });

  await check('单请求重试前也检查记忆权限', async () => {
    const r = record('权限重试特定话题', { visibility: { type: 'global' }, kind: 'event' });
    append('group:28', '权限重试特定话题');
    let n = 0;
    responder = () => { n++; memory.deleteRecord(r.id, r.version); return { error: 500 }; };
    await orch.wake('group:28');
    assert.equal(n, 1);
    assert.equal(lastSession().status, 'error');
  });

  await check('无外部动作的失败保留未读，成功后只确认固定批次', async () => {
    responder = () => ({ error: 400 });
    append('group:22', '失败后应保留');
    await orch.wake('group:22');
    assert.equal(lastSession().status, 'error');
    assert.equal(store.unreadCount('group:22'), 1);
    assert.ok(!scheduled.includes('group:22'));
    responder = () => ({ content: '' });
    await orch.wake('group:22');
    assert.equal(store.unreadCount('group:22'), 0);
  });

  await check('外部动作结果不确定时不自动重放整批', async () => {
    append('group:23', '动作请求');
    orch.sender = { poke: async () => { throw new Error('发送结果不确定'); } };
    let round = 0;
    responder = () => ++round === 1 ? { tool_calls: [call('send_poke', { targetUserId: '123' })] } : { error: 400 };
    await orch.wake('group:23');
    assert.equal(lastSession().sideEffectAttempted, true);
    assert.equal(lastSession().status, 'error');
    assert.equal(store.unreadCount('group:23'), 0);
  });

  await check('模型返回前收紧已用记忆范围，阻止发言', async () => {
    const r = record('测试联机约定', { visibility: { type: 'global' }, kind: 'event' });
    append('group:24', '测试联机约定');
    let sent = 0;
    orch.sender = { sendTextBatch: async () => { sent++; return { sent: [], failed: [] }; } };
    responder = () => {
      memory.saveRecord({ id: r.id, visibility: { type: 'chats', chatKeys: ['private:123'] } }, { expectedVersion: r.version });
      return { tool_calls: [call('send_message', { messages: '不应发送' })] };
    };
    await orch.wake('group:24');
    assert.equal(lastSession().status, 'error');
    assert.equal(sent, 0);
    assert.equal(store.unreadCount('group:24'), 1);
  });

  await check('排队发送前再次检查权限', async () => {
    let sent = 0;
    const queue = new SendQueue({ onebot: { sendText: async () => { sent++; } }, store });
    await assert.rejects(queue.sendTextBatch('group:25', ['禁止'], { beforeSend: () => { throw new Error('权限变化'); } }), /权限变化/);
    assert.equal(sent, 0);
  });

  await check('私聊不向模型提供群成员查询工具', async () => {
    responder = () => ({ content: '' });
    append('private:123', '私聊工具检查');
    await orch.wake('private:123');
    assert.ok(!requests.at(-1).tools.some((t) => t.function.name === 'get_group_members'));
  });
} finally {
  orch.aborted = true;
  orch.memoryPipeline.stop();
  await new Promise((r) => server.close(r));
}
console.log(`\n${count} context checks passed`);
