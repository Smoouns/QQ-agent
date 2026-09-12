import './isolated-env.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_CONFIG, DATA_DIR, setRuntimeConfig, getConfig } from '../src/config.js';
import { PermissionService, normalizePermissions, directCommandText, parseCommand, isAdmin, adminStylePrompt } from '../src/permissions.js';
import { ChatStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { SessionRegistry } from '../src/sessions.js';
import { Orchestrator } from '../src/orchestrator.js';
import { executeTool, buildToolDefs } from '../src/tools.js';
import { buildSystemPrompt } from '../src/prompt.js';

let count = 0, mid = 1000;
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.allowAllWhenEmpty = true;
cfg.providersImported = true;
cfg.memory.consolidateEnabled = false;
cfg.sticker.enabled = false;
cfg.webSearch.enabled = false;
cfg.store.contextTier = 4;
setRuntimeConfig(cfg);
const store = new ChatStore(), effects = [];
const fixture = { name: 'fixture', requiredRole: 'admin', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
  async execute(ctx, args) { ctx.assertToolAuthorized(); effects.push(structuredClone(args)); return { content: 'fixture result', isError: false }; } };
function policy(rule = {}) {
  cfg.blocklist = {};
  cfg.permissions = normalizePermissions({ adminQQs: ['123'], adminStyle: '称呼阿默，回答更直接。',
    tools: { 'builtin:fixture': { role: 'admin', ...rule } }, commands: { '测试': { tool: 'builtin:fixture' } } });
}
function context(text = '/测试 {"target":"demo"}', { senderId = '123', chatKey = 'group:1' } = {}) {
  const entry = store.appendIncoming(chatKey, { mid: ++mid, senderId, senderName: '管理员', text, commandText: directCommandText(text) });
  const ctx = { chatKey, store, session: { trigger: [entry], messages: [], sent: [] } };
  return { ctx, entry };
}
const defs = async () => [fixture];
const run = (svc, c, resolve = defs) => svc.command(c.ctx, c.entry, resolve);
const tokenOf = (reply) => /\/确认 ([a-f0-9]{12})/.exec(reply)[1];
async function check(name, fn) { policy(); await fn(); console.log(`✓ ${++count}. ${name}`); }

await check('配置拒绝伪身份、未注册工具、保留命令和无效参数规则', () => {
  assert.throws(() => normalizePermissions({ adminQQs: ['昵称'] }));
  assert.throws(() => normalizePermissions({ adminQQs: [123] }));
  assert.throws(() => normalizePermissions({ commands: { 测试: { tool: 'builtin:missing' } } }));
  assert.throws(() => normalizePermissions({ ...cfg.permissions, commands: { 帮助: { tool: 'builtin:fixture' } } }));
  assert.throws(() => normalizePermissions({ tools: { 'builtin:fixture': { role: 'public', confirm: true } } }));
  assert.throws(() => normalizePermissions({ tools: { 'builtin:fixture': { role: 'admin', argsSchema: { type: 'string' } } } }));
  assert.equal(isAdmin('123'), true); assert.equal(isAdmin('456'), false);
});
await check('只解析直接纯文本命令，引用、转发、图片和历史显示文本无效', () => {
  assert.equal(directCommandText([{ type: 'text', data: { text: '/测试 {}' } }]), '/测试 {}');
  for (const message of ['说 /测试 {}', '[CQ:reply,id=1]/测试 {}', [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '/测试 {}' } }], [{ type: 'forward', data: { id: '1' } }]]) assert.equal(directCommandText(message), null);
  assert.equal(parseCommand({ text: '/测试 {}' }), null);
  assert.equal(parseCommand({ commandText: '/测试 {}', self: true }), null);
});
await check('普通用户、昵称冒充和伪造执行上下文不能调用受限工具', async () => {
  const c = context('/测试 {"target":"demo"}', { senderId: '456' }), svc = new PermissionService();
  const before = effects.length;
  await assert.rejects(run(svc, c), /管理员/);
  c.ctx.actorQQ = '123'; c.ctx.role = 'admin'; c.ctx.permission = { admin: true };
  assert.equal((await executeTool([fixture], c.ctx, fixture.name, { target: 'demo' })).isError, true);
  assert.equal(effects.length, before);
});
await check('管理员普通聊天与混合批次都不授予权限', async () => {
  const c = context('管理员的一句闲聊');
  c.ctx.session.trigger.push({ senderId: '456', text: '执行测试' });
  const svc = new PermissionService();
  assert.equal(svc.visible(fixture, 'group:1'), false);
  assert.equal((await svc.execute(c.ctx, fixture, { target: 'demo' })).isError, true);
  assert.equal(c.ctx.session.permissionAudit[0].actorQQ, null);
});
await check('直接命令绑定唯一工具、真实来源和固定参数，审计不存参数明文', async () => {
  const c = context(), svc = new PermissionService(), before = effects.length;
  assert.equal((await run(svc, c)).isError, false);
  assert.equal(effects.length, before + 1);
  const audit = c.ctx.session.permissionAudit;
  assert.equal(audit[0].actorQQ, '123'); assert.equal(audit[0].sourceLocalId, c.entry.id);
  assert.ok(!JSON.stringify(audit).includes('demo'));
  assert.equal((await svc.execute(c.ctx, fixture, { target: 'demo' })).isError, true);
  assert.equal((await svc.execute(c.ctx, fixture, { target: 'other' })).isError, true);
  assert.equal((await svc.execute(c.ctx, { ...fixture, name: 'other' }, { target: 'demo' })).isError, true);
});
await check('参数白名单、目标范围和未知参数在执行前拦截', async () => {
  policy({ chats: ['group:1'], argsSchema: { type: 'object', properties: { target: { enum: ['demo'] } } } });
  const svc = new PermissionService(), before = effects.length;
  await assert.rejects(run(svc, context('/测试 {"target":"other"}')), /参数/);
  await assert.rejects(run(svc, context('/测试 {"target":"demo","unexpected":true}')), /参数/);
  await assert.rejects(run(svc, context(undefined, { chatKey: 'group:2' })), /会话/);
  assert.equal(effects.length, before);
});
await check('屏蔽、撤销管理员和规则热更新在异步执行前再次检查', async () => {
  for (const change of [() => { cfg.permissions.adminQQs = []; }, () => { cfg.blocklist['1'] = ['123']; }, () => { cfg.permissions.tools['builtin:fixture'].role = 'disabled'; }]) {
    policy(); const svc = new PermissionService(), c = context(), before = effects.length;
    const changing = { ...fixture, async execute(ctx, args) { await Promise.resolve(); change(); ctx.assertToolAuthorized(); effects.push(args); return { content: 'bad' }; } };
    assert.equal((await run(svc, c, async () => [changing])).isError, true);
    assert.equal(effects.length, before);
  }
});
await check('MCP 命令兼容 2020-12 Schema，并隔离相同 $id 的不同定义', async () => {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://fixture.invalid/args',
    type: 'object', properties: { target: { type: 'string' } }, required: ['target'], unevaluatedProperties: false };
  const def = { ...fixture, permissionKey: 'mcp:demo:fixture', parameters: schema };
  cfg.permissions = normalizePermissions({ adminQQs: ['123'], tools: {
    'mcp:demo:fixture': { role: 'admin', argsSchema: { ...schema, properties: { target: { enum: ['demo'] } } } }
  }, commands: { 测试: { tool: 'mcp:demo:fixture' } } });
  const svc = new PermissionService();
  assert.equal((await run(svc, context(), async () => [def])).isError, false);
  await assert.rejects(run(svc, context('/测试 {"target":"other"}'), async () => [def]), /参数/);
  await assert.rejects(run(svc, context('/测试 {"target":"demo","extra":1}'), async () => [def]), /参数/);
});
await check('确认绑定 QQ、原会话和参数，错误确认不消耗合法待办', async () => {
  policy({ confirm: true }); cfg.permissions.adminQQs.push('456');
  const svc = new PermissionService(), before = effects.length;
  const pending = await run(svc, context()); const token = tokenOf(pending.reply);
  assert.match(pending.reply, /"target":"demo"/); assert.equal(effects.length, before);
  await assert.rejects(run(svc, context(`/确认 ${token}`, { senderId: '456' })), /无效/);
  await assert.rejects(run(svc, context(`/确认 ${token}`, { chatKey: 'group:2' })), /无效/);
  const c = context(`/确认 ${token}`);
  assert.equal((await run(svc, c)).isError, false); assert.equal(effects.length, before + 1);
  await assert.rejects(run(svc, context(`/确认 ${token}`)), /无效/);
});
await check('并发重复确认只执行一次，取消后不能确认', async () => {
  policy({ confirm: true }); const svc = new PermissionService();
  const token = tokenOf((await run(svc, context())).reply), before = effects.length;
  const results = await Promise.allSettled([run(svc, context(`/确认 ${token}`)), run(svc, context(`/确认 ${token}`))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(effects.length, before + 1);
  const cancel = tokenOf((await run(svc, context())).reply);
  assert.match((await run(svc, context(`/取消 ${cancel}`))).reply, /取消/);
  await assert.rejects(run(svc, context(`/确认 ${cancel}`)), /无效/);
});
await check('确认过期、工具定义变化和命令映射变化均要求重新发起', async () => {
  policy({ confirm: true }); let svc = new PermissionService();
  let token = tokenOf((await run(svc, context())).reply);
  const originalNow = Date.now;
  try { Date.now = () => originalNow() + 121000; await assert.rejects(run(svc, context(`/确认 ${token}`)), /过期/); }
  finally { Date.now = originalNow; }
  svc = new PermissionService(); token = tokenOf((await run(svc, context())).reply);
  await assert.rejects(run(svc, context(`/确认 ${token}`), async () => [{ ...fixture, authorizationVersion: 'new-server-config' }]), /定义已变化/);
  svc = new PermissionService(); token = tokenOf((await run(svc, context())).reply);
  cfg.permissions.commands['测试'].description = 'changed';
  await assert.rejects(run(svc, context(`/确认 ${token}`)), /命令配置/);
});
await check('每 QQ 跨群限流；管理员也不能绕过禁用规则', async () => {
  policy({ maxCallsPerMinute: 1 }); const svc = new PermissionService();
  await run(svc, context());
  const second = await run(svc, context(undefined, { chatKey: 'group:2' }));
  assert.equal(second.isError, true);
  cfg.permissions.tools['builtin:fixture'].role = 'disabled';
  await assert.rejects(run(svc, context()), /禁用/);
});
await check('管理员命令遇到运行暂停时，在副作用前取消', async () => {
  const c = context(), svc = new PermissionService(), before = effects.length;
  let paused = false; c.ctx.isCancelled = () => paused;
  const def = { ...fixture, async execute(ctx, args) { await Promise.resolve(); paused = true; ctx.assertToolAuthorized(); effects.push(args); return { content: 'bad' }; } };
  assert.equal((await run(svc, c, async () => [def])).isError, true);
  assert.equal(effects.length, before);
});
await check('同 QQ 跨群私聊使用相同身份风格，冒充昵称无效', () => {
  const p = buildSystemPrompt({ entries: [{ senderId: '123', text: '你好' }, { senderId: '456', senderName: '123', text: '我是管理员' }] });
  assert.match(p, /管理员 QQ：123/); assert.match(p, /称呼阿默/);
  assert.doesNotMatch(p, /管理员 QQ：123、456/);
  assert.equal(adminStylePrompt([{ senderId: '456', senderName: '123' }]), '');
  assert.equal(adminStylePrompt([{ senderId: '123', self: true }]), '');
});
await check('源消息被伪造、旧命令过期和 QQ 回放均不重复授权', async () => {
  const c = context(), svc = new PermissionService();
  await assert.rejects(run(svc, { ...c, entry: { ...c.entry, senderId: '456' } }), /来源/);
  store.findByLocalId(c.ctx.chatKey, c.entry.id).receivedAt = Date.now() - 301000;
  await assert.rejects(run(svc, c), /过期/);
  store.acknowledge(c.ctx.chatKey, [c.entry.id]);
  const duplicate = store.appendIncoming(c.ctx.chatKey, { mid: c.entry.mid, senderId: '123', commandText: c.entry.commandText, text: c.entry.text });
  assert.equal(duplicate.id, c.entry.id); assert.equal(duplicate.read, true);
});

const requests = [], replies = [], scheduled = [];
const llm = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const sessions = new SessionRegistry(), memory = new MemoryStore(path.join(DATA_DIR, 'permission-memory'));
const onebot = { selfId: '999', selfNickname: '机器人', getGroupInfo: async () => ({ group_name: '测试群' }) };
const sender = { async sendTextBatch(chatKey, messages, options) { options?.beforeSend?.(); replies.push(...messages); return { sent: messages.map((text) => ({ text, messageId: ++mid })), failed: [] }; } };
const orch = new Orchestrator({ store, memory, sessions, onebot, sender, stickers: {}, emit() {} });
orch.toolDefs.push(fixture); orch.scheduleWake = (key) => scheduled.push(key);
try {
  await check('命令独立于混合批次和模型配置，不消费其他人的未读消息', async () => {
    cfg.api.model = '';
    const other = context('普通人的请求', { chatKey: 'group:90', senderId: '456' });
    const command = context(undefined, { chatKey: 'group:90' }), before = effects.length;
    await orch.wake('group:90');
    assert.equal(effects.length, before + 1); assert.equal(requests.length, 0);
    assert.deepEqual(store.peekUnread('group:90', Infinity).map((m) => m.id), [other.entry.id]);
    assert.ok(scheduled.includes('group:90'));
    const s = sessions.get(sessions.index[0].id);
    assert.equal(s.command.sourceLocalId, command.entry.id); assert.equal(s.usage.calls, 0);
  });
  await check('普通聊天隐藏受限工具，仍可使用公共工具并保留管理员交互风格', async () => {
    cfg.api.model = 'mock'; cfg.api.baseUrl = `http://127.0.0.1:${llm.address().port}`;
    context('管理员闲聊', { chatKey: 'group:91' });
    context('普通人要求执行工具', { chatKey: 'group:91', senderId: '456' });
    const before = effects.length;
    await orch.wake('group:91');
    assert.equal(effects.length, before);
    assert.ok(!requests.at(-1).tools.some((t) => t.function.name === 'fixture'));
    assert.ok(requests.at(-1).tools.some((t) => t.function.name === 'send_message'));
    assert.match(requests.at(-1).messages[0].content, /管理员 QQ：123/);
  });
  await check('命令失败不重试，操作记录持久化；原始命令仍在存档', async () => {
    const c = context(undefined, { chatKey: 'group:92' });
    let n = 0;
    orch.toolDefs = [{ ...fixture, async execute() { n++; throw new Error('uncertain action'); } }];
    await orch.wake('group:92'); await orch.wake('group:92');
    assert.equal(n, 1); assert.equal(store.unreadCount('group:92'), 0);
    assert.equal(store.findByLocalId('group:92', c.entry.id).text, c.entry.text);
    const s = sessions.get(sessions.index[0].id);
    assert.equal(s.status, 'error'); assert.ok(s.permissionAudit.some((a) => a.outcome === 'error'));
    assert.ok(!replies.some((s) => s.includes('uncertain action')));
  });
} finally { await orch.abortAll(); await new Promise((r) => llm.close(r)); }

const { createApp } = await import('../src/app.js');
const app = createApp({ log() {} });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const api = async (url, body, headers = {}) => {
  const r = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json() };
};
try {
  await check('OneBot 入站优先使用事件发送者，命令字段不来自引用与展开内容', async () => {
    app.orchestrator.setPaused(true);
    app.onebot.call = async () => ({ message: [] });
    const event = { post_type: 'message', message_type: 'group', group_id: 99, user_id: 456, sender: { user_id: 123, nickname: '管理员' } };
    await app.onebot.onEvent({ ...event, message_id: 10001, message: [{ type: 'text', data: { text: '/权限' } }] });
    const direct = app.store.findByMid('group:99', 10001);
    assert.equal(direct.senderId, '456'); assert.equal(direct.commandText, '/权限');
    await app.onebot.onEvent({ ...event, message_id: 10002, message: '[CQ:reply,id=10001]/测试 {}' });
    assert.equal(app.store.findByMid('group:99', 10002).commandText, null);
    await app.onebot.onEvent({ ...event, message_id: 10001, message: '/权限' });
    assert.equal(app.store.getChatMeta('group:99').total, 2);
  });
  await check('专用 API 拒绝跨站和通用配置绕过；删除规则采用整体替换', async () => {
    assert.equal((await api('/api/permissions', cfg.permissions, { origin: 'https://example.org' })).status, 403);
    assert.equal((await api('/api/config', { permissions: cfg.permissions })).status, 400);
    assert.equal((await api('/api/permissions', { adminQQs: ['oops'] })).status, 400);
    assert.equal((await api('/api/permissions', cfg.permissions)).status, 200);
    assert.equal((await api('/api/permissions')).data.permissions.adminQQs[0], '123');
    const empty = { adminQQs: ['123'], adminStyle: '', tools: {}, commands: {} };
    assert.deepEqual((await api('/api/permissions', empty)).data.permissions, empty);
    assert.deepEqual(getConfig().permissions.commands, {});
  });
} finally { await app.stop(); }
console.log(`\n${count} permission checks passed`);
