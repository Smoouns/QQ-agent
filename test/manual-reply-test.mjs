import './isolated-env.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.allowAllWhenEmpty = true; cfg.memory.consolidateEnabled = false; cfg.sticker.enabled = false;
cfg.api.model = 'manual-test'; cfg.api.vision = false; cfg.webSearch.enabled = false;
cfg.responseRules.groupMode = 'direct'; cfg.store.historyCount = 0;
cfg.permissions.adminQQs = ['123'];
setRuntimeConfig(cfg);
const requests = [], sent = [];
const toolCall = (name, args = {}) => ({ id: 'test-call', type: 'function', function: { name, arguments: JSON.stringify(args) } });
let respond = (body) => body.messages.at(-1).role === 'tool' ? { content: '' }
  : { tool_calls: [toolCall('send_message', { messages: ['手动测试回复'] })] };
const normalResponse = respond;
const llm = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const message = await respond(body);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
cfg.api.baseUrl = `http://127.0.0.1:${llm.address().port}`;
const app = createApp({ log() {} });
app.onebot.getGroupInfo = async () => ({ group_name: '测试群' });
app.onebot.sendText = async (kind, id, text) => { sent.push({ kind, id, text }); return { message_id: sent.length }; };
app.orchestrator.scheduleWake = () => {}; // Only the explicit console request drives these tests.
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const request = async (key, headers = {}) => {
  const response = await fetch(`${base}/api/chats/${key.replace(':', '_')}/agent-reply`, { method: 'POST', headers, body: '{}' });
  return { status: response.status, data: await response.json() };
};
const append = (key, text = '这条消息不满足自动回应条件', extra = {}) => app.store.appendIncoming(key, {
  senderId: '123', text, mid: app.store.boundary(key) + 1, ...extra
});
const finished = async (id) => {
  for (let i = 0; i < 200; i++) {
    const s = app.sessions.get(id);
    if (s && !['running', 'waiting'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('manual run did not complete');
};
let count = 0;
async function check(name, fn) { await fn(); console.log(`✓ ${++count}. ${name}`); }
try {
  await check('实际 HTTP 按钮接口跳过响应门槛，模型调用发送工具，回复只进入当前群', async () => {
    append('group:1'); const result = await request('group:1');
    assert.equal(result.status, 200); assert.ok(result.data.sessionId);
    const s = await finished(result.data.sessionId);
    assert.equal(s.status, 'done'); assert.equal(s.responseDecision.manualReply, true);
    assert.match(s.systemPrompt, /控制台手动测试/);
    assert.deepEqual(sent.at(-1), { kind: 'group', id: '1', text: '手动测试回复' });
    assert.equal(app.store.unreadCount('group:1'), 0);
    assert.ok(!requests[0].tools.some((t) => t.function.name === 'get_computer_status'));
  });
  await check('全部已读且历史窗口为零时，仍选择最近用户消息；私聊也可测试', async () => {
    const m = append('private:123', '已读消息'); app.store.markAllRead('private:123');
    const result = await request('private:123'); const s = await finished(result.data.sessionId);
    assert.equal(s.status, 'done'); assert.deepEqual(s.contextSelection.triggerIds, [m.id]);
    assert.equal(sent.at(-1).kind, 'private'); assert.equal(sent.at(-1).id, '123');
    assert.equal(app.store.findByLocalId('private:123', m.id).text, '已读消息');
  });
  await check('历史管理员命令不被重新执行或消费，模型也不会获得管理员工具授权', async () => {
    append('group:2', '普通上下文'); app.store.markAllRead('group:2');
    const command = append('group:2', '/电脑状态', { commandText: '/电脑状态' });
    let statusReads = 0;
    const def = app.orchestrator.toolDefs.find((d) => d.name === 'get_computer_status'), old = def.execute;
    def.execute = async () => { statusReads++; return { content: 'sensitive' }; };
    respond = (body) => body.messages.at(-1).role === 'tool' ? { content: '' } : { tool_calls: [toolCall('get_computer_status')] };
    try {
      const result = await request('group:2'); const s = await finished(result.data.sessionId);
      assert.equal(statusReads, 0); assert.equal(s.status, 'noreply');
      assert.deepEqual(s.contextSelection.triggerIds, [1]);
      assert.equal(app.store.findByLocalId('group:2', command.id).read, false);
    } finally { def.execute = old; respond = normalResponse; }
  });
  await check('不占自动参与额度，也不受自动参与冷却限制；实际模型处理清除先前累计', async () => {
    append('group:3'); const a = app.orchestrator.responseActivity.state('group:3');
    a.calls = [Date.now(), Date.now()]; a.lastCall = Date.now();
    a.unanswered = [{ id: 1, senderId: '123' }];
    const result = await request('group:3'); const s = await finished(result.data.sessionId);
    assert.equal(s.status, 'done'); assert.equal(a.calls.length, 2); assert.equal(a.unanswered.length, 0);
    assert.ok(!s.autoParticipationCharged);
  });
  await check('跨站请求、暂停、未配置模型、非白名单和无可见用户消息均明确拒绝', async () => {
    const before = requests.length;
    assert.equal((await request('group:1', { origin: 'https://example.invalid' })).status, 403);
    app.orchestrator.setPaused(true); assert.equal((await request('group:1')).status, 409); app.orchestrator.setPaused(false);
    cfg.api.model = ''; assert.equal((await request('group:1')).status, 400); cfg.api.model = 'manual-test';
    cfg.deny.groups = ['1']; assert.equal((await request('group:1')).status, 403); cfg.deny.groups = [];
    assert.equal((await request('group:999')).status, 400);
    append('group:4'); cfg.blocklist = { '4': ['123'] };
    assert.equal((await request('group:4')).status, 400); cfg.blocklist = {};
    assert.equal(requests.length, before);
  });
  await check('连续点击不产生并行回复，全局并发满时拒绝而不排队', async () => {
    append('group:5'); let release;
    const held = new Promise((r) => { release = r; });
    respond = async (body) => { await held; return normalResponse(body); };
    const first = await request('group:5');
    try {
      assert.equal((await request('group:5')).status, 409);
      app.orchestrator.runningChats.add('group:busy');
      assert.equal((await request('group:1')).status, 409);
    } finally { app.orchestrator.runningChats.delete('group:busy'); release(); respond = normalResponse; }
    assert.equal((await finished(first.data.sessionId)).status, 'done');
  });
  await check('取消已有等待定时器，避免按钮触发后同一批再次自动运行', async () => {
    append('group:6');
    const waiting = app.sessions.create({ chatKey: 'group:6', trigger: [], status: 'waiting' });
    const timer = setTimeout(() => assert.fail('stale timer fired'), 1000);
    app.orchestrator.wakeTimers.set('group:6', timer); app.orchestrator.pendingWake.add('group:6');
    app.orchestrator.pendingSessions.set('group:6', waiting.id);
    const result = await request('group:6'); await finished(result.data.sessionId);
    assert.ok(!app.orchestrator.pendingWake.has('group:6')); assert.ok(!app.orchestrator.wakeTimers.has('group:6'));
    assert.equal(app.sessions.get(waiting.id), null);
  });
  await check('请求准备及发送队列执行前再次校验暂停和会话范围', async () => {
    append('group:7'); const before = requests.length, sentBefore = sent.length;
    const oldInfo = app.onebot.getGroupInfo;
    app.onebot.getGroupInfo = async () => { cfg.deny.groups = ['7']; return {}; };
    const first = await request('group:7'); await finished(first.data.sessionId);
    assert.equal(requests.length, before); cfg.deny.groups = []; app.onebot.getGroupInfo = oldInfo;
    append('group:8'); const oldSend = app.sender.sendTextBatch.bind(app.sender);
    app.sender.sendTextBatch = async (...args) => { app.orchestrator.setPaused(true); return oldSend(...args); };
    try { const result = await request('group:8'); await finished(result.data.sessionId); }
    finally { app.sender.sendTextBatch = oldSend; app.orchestrator.setPaused(false); }
    assert.equal(sent.length, sentBefore);
  });
} finally {
  await app.stop(); await new Promise((r) => llm.close(r));
}
console.log(`\n${count} manual reply checks passed`);
