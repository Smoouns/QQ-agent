import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { fixtureServer } from './fixtures/mcp-server.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-mcp-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_MCP_MUST_NOT_INHERIT = 'parent-secret';
const { McpManager, normalizeMcpServer, mcpToolName } = await import('../src/mcp.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); };
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`OK ${name}`); };
let config = { mcp: { servers: [] }, allowAllWhenEmpty: true };
const manager = new McpManager({ config: () => config, save: (p) => { config = { ...config, ...p }; } });
const calls = [];
let initializations = 0;
const remote = http.createServer(async (req, res) => {
  if (req.url === '/redirect') { res.writeHead(307, { location: '/mcp' }); res.end(); return; }
  if (req.headers.authorization !== 'Bearer fixture-secret') { res.writeHead(401); res.end('no'); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const body = await readBody(req);
  if (body.method === 'initialize') initializations++;
  const fixture = fixtureServer((p) => calls.push(p));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await fixture.connect(transport);
  res.on('close', () => { transport.close(); fixture.close(); });
  await transport.handleRequest(req, res, body);
});
const remoteUrl = await listen(remote);
let app, llm;
try {
  await check('配置校验、默认关闭、名称隔离', () => {
    const s = normalizeMcpServer({ name: 'local', command: 'node' });
    assert.equal(s.enabled, false);
    assert.deepEqual(s.enabledTools, []);
    assert.throws(() => normalizeMcpServer({ name: 'bad', transport: 'http', url: 'file:///a' }));
    assert.throws(() => normalizeMcpServer({ name: 'bad', command: 'node', args: 'server.js' }));
    assert.notEqual(mcpToolName('a', 'find.item'), mcpToolName('a', 'find-item'));
    assert.notEqual(mcpToolName('a', 'find.item'), mcpToolName('b', 'find.item'));
    assert.ok(mcpToolName('a'.repeat(24), '工具'.repeat(100)).length <= 64);
  });

  const local = await manager.upsert({ name: '本地测试', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--stdio'], env: { QQ_MCP_FIXTURE_VALUE: 'explicit-secret' } });
  let childPid;
  await check('stdio 握手、分页发现、凭据脱敏', async () => {
    await manager.ensure(local.id);
    const view = manager.list()[0];
    assert.equal(view.tools.length, 6);
    assert.ok(view.tools.find((t) => t.name === 'broken').unavailableReason);
    assert.ok(!JSON.stringify(view).includes('explicit-secret'));
    assert.deepEqual(view.envKeys, ['QQ_MCP_FIXTURE_VALUE']);
    assert.equal((await manager.toolDefsForChat('group:1')).defs.length, 0);
  });
  await manager.upsert({ id: local.id, enabled: true, enabledTools: ['find.item'], scope: { mode: 'selected', chatKeys: ['group:1'] } });
  await check('stdio 实际调用、环境变量隔离、按聊天和工具授权', async () => {
    assert.equal((await manager.toolDefsForChat('group:2')).defs.length, 0);
    assert.equal((await manager.toolDefsForChat('group:1')).defs.length, 1);
    assert.equal((await manager.call(local.id, 'find.item', { text: 'denied' }, 'private:1')).isError, true);
    assert.equal((await manager.call(local.id, 'large', {}, 'group:1')).isError, true);
    const result = await manager.call(local.id, 'find.item', { text: 'stdio' }, 'group:1');
    assert.equal(result.isError, false);
    assert.match(result.content, /echo:stdio/);
    assert.match(result.content, /"explicitEnv":"explicit-secret"/);
    assert.match(result.content, /"inheritedSecret":""/);
    childPid = JSON.parse(result.content.split('\n')[1]).pid;
  });
  await check('删除服务关闭子进程', async () => {
    await manager.remove(local.id);
    assert.throws(() => process.kill(childPid, 0));
  });

  const service = await manager.upsert({ name: 'HTTP 测试', transport: 'http', url: `${remoteUrl}/mcp`, headers: { Authorization: 'Bearer fixture-secret' }, enabled: true, enabledTools: ['find.item', 'slow', 'large', 'error', 'broken'], timeoutMs: 1000, maxResultChars: 512 });
  await check('HTTP 并发连接复用、分页、不可用 Schema 隔离', async () => {
    await Promise.all([manager.ensure(service.id), manager.ensure(service.id)]);
    assert.equal(initializations, 1);
    const result = await manager.toolDefsForChat('group:1');
    assert.equal(result.defs.length, 4);
    assert.equal(result.warnings.length, 1);
    assert.ok(!JSON.stringify(manager.list()).includes('fixture-secret'));
  });
  await check('参数校验在请求发送前生效', async () => {
    const before = calls.length;
    assert.equal((await manager.call(service.id, 'find.item', { text: 123 }, 'group:1')).isError, true);
    assert.equal(calls.length, before);
    const result = await manager.call(service.id, 'find.item', { text: 'HTTP' }, 'group:1');
    assert.equal(result.isError, false);
    assert.match(result.content, /echo:HTTP/);
  });
  await check('MCP 真正发送前执行权限复查，旧服务配置不能借新连接执行', async () => {
    const before = calls.length;
    const denied = await manager.call(service.id, 'find.item', { text: 'denied' }, 'group:1', () => { throw new Error('管理员权限已撤销'); });
    assert.equal(denied.isError, true); assert.match(denied.content, /管理员权限已撤销/);
    assert.equal((await manager.call(service.id, 'find.item', { text: 'stale' }, 'group:1', null, 'old-version')).isError, true);
    assert.equal(calls.length, before);
  });
  await check('工具错误与结果字符上限', async () => {
    assert.equal((await manager.call(service.id, 'error', {}, 'group:1')).isError, true);
    const result = await manager.call(service.id, 'large', {}, 'group:1');
    assert.ok(result.content.length <= 512);
    assert.match(result.content, /已截断/);
  });
  await check('超时不重放工具调用', async () => {
    const result = await manager.call(service.id, 'slow', {}, 'group:1');
    assert.equal(result.isError, true);
    assert.equal(calls.filter((c) => c.name === 'slow').length, 1);
  });
  await check('热修改权限使旧工具定义失效，空凭据字段保留旧值', async () => {
    const old = (await manager.toolDefsForChat('group:1')).defs.find((d) => d.name === mcpToolName(service.id, 'find.item'));
    await manager.upsert({ id: service.id, enabledTools: [] });
    assert.equal(manager.get(service.id).headers.Authorization, 'Bearer fixture-secret');
    const before = calls.length;
    const result = await old.execute({ chatKey: 'group:1', session: {}, mcp: manager }, { text: 'no' });
    assert.equal(result.isError, true);
    assert.equal(calls.length, before);
  });
  await check('HTTP 重定向失败可诊断，故障服务不阻断聊天', async () => {
    const bad = await manager.upsert({ name: '不可达', transport: 'http', url: `${remoteUrl}/redirect`, enabled: true, enabledTools: ['find.item'], timeoutMs: 1000 });
    const result = await manager.toolDefsForChat('group:1');
    assert.equal(result.defs.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(manager.list().find((s) => s.id === bad.id).status, 'error');
  });

  // 实际 API 和编排器集成；HTTP 模型由本机桩替代，不连接真实 QQ。
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.consolidateEnabled = false;
  cfg.sticker.enabled = false;
  cfg.webSearch.enabled = false;
  cfg.allow = { groups: ['1'], private: [] };
  cfg.providersImported = true;
  const requests = [];
  let failAfterTool = false;
  let attempts = 0;
  llm = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push(body);
    const toolResult = body.messages.find((m) => m.role === 'tool');
    if (toolResult && failAfterTool) { attempts++; res.writeHead(503); res.end('temporary test error'); return; }
    const mcpTool = body.tools.find((t) => t.function.name.startsWith('mcp_'));
    const message = toolResult
      ? { role: 'assistant', content: '完成' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call_test', type: 'function', function: { name: mcpTool.function.name, arguments: JSON.stringify({ text: '聊天集成' }) } }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  cfg.api = { ...cfg.api, model: 'local-test', baseUrl: await listen(llm), apiKey: 'test', maxRounds: 3 };
  setRuntimeConfig(cfg);
  const { createApp } = await import('../src/app.js');
  app = createApp({ log: () => {} });
  app.onebot.call = async () => ({ group_name: '测试群' });
  const appUrl = await listen(app.server);
  const api = async (url, body, method = body ? 'POST' : 'GET', headers = {}) => {
    const res = await fetch(`${appUrl}${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  let saved;
  await check('管理 API 保存、发现、凭据不回显、拒绝跨站与通用配置绕过', async () => {
    const result = await api('/api/mcp/servers', { name: '集成服务', transport: 'http', url: `${remoteUrl}/mcp`, headers: { Authorization: 'Bearer fixture-secret' }, enabled: true, enabledTools: ['find.item'] });
    assert.equal(result.status, 200);
    saved = result.data.server;
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    assert.equal((await api(`/api/mcp/servers/${saved.id}/discover`, {})).data.server.tools.length, 6);
    assert.ok(!JSON.stringify((await api('/api/config')).data).includes('fixture-secret'));
    assert.ok(!JSON.stringify((await api('/api/config', { ui: { theme: 'dark' } })).data).includes('fixture-secret'));
    assert.equal((await api('/api/config', { mcp: { servers: [] } })).status, 400);
    assert.equal((await api('/api/mcp/servers', { name: 'evil', command: 'node' }, 'POST', { origin: 'https://example.invalid' })).status, 403);
    assert.equal((await api(`/api/mcp/servers/${saved.id}/call`, { name: 'find.item', arguments: { text: 'no' }, chatKey: 'group:2' })).status, 403);
    assert.equal((await api(`/api/mcp/servers/${saved.id}/call`, { name: 'find.item', arguments: { text: 'manual' }, chatKey: 'group:1' })).data.isError, false);
  });
  await check('聊天模型发现工具→执行 MCP→下一轮收到结果→保存调用记录', async () => {
    app.store.appendIncoming('group:1', { mid: 101, senderId: '9', senderName: '测试人', text: '调用测试工具' });
    await app.orchestrator.wake('group:1');
    assert.equal(requests.length, 2);
    assert.ok(requests[0].tools.some((t) => t.function.name === 'send_message'));
    assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /echo:聊天集成/);
    const session = app.sessions.get(app.sessions.listSummaries(1)[0].id);
    assert.ok(session.messages.some((m) => m.toolCall?.name.startsWith('mcp_')));
    assert.equal(session.externalToolAttempted, true);
  });
  await check('MCP 执行后的模型故障不会导致整轮重放外部动作', async () => {
    failAfterTool = true;
    const before = calls.filter((c) => c.arguments?.text === '聊天集成').length;
    app.store.appendIncoming('group:1', { mid: 102, senderId: '9', senderName: '测试人', text: '故障重试验证' });
    await app.orchestrator.wake('group:1');
    assert.equal(calls.filter((c) => c.arguments?.text === '聊天集成').length - before, 1);
    assert.equal(attempts, 3); // 只重试失败的模型请求，没有重跑整个会话
    assert.equal(app.sessions.listSummaries(1)[0].status, 'error');
  });
  console.log(`\n${passed} MCP checks passed`);
} finally {
  delete process.env.QQ_MCP_MUST_NOT_INHERIT;
  await manager.close();
  if (app) await app.stop();
  if (llm) { llm.closeAllConnections(); await new Promise((resolve) => llm.close(resolve)); }
  remote.closeAllConnections();
  await new Promise((resolve) => remote.close(resolve));
  // 唯一目标是本测试刚创建的临时目录。
  assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith('qq-agent-mcp-test-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
