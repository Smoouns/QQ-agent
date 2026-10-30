import './isolated-env.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { DEFAULT_CONFIG, CONFIG_FILE, getConfig, setRuntimeConfig } from '../src/config.js';
import { openCodexSearch, readSearchResponse, responsesUrl } from '../src/opencodex-search.js';
import { webSearch } from '../src/web-search.js';
import { buildToolDefs } from '../src/tools.js';
import { createApp } from '../src/app.js';

const citation = { type: 'url_citation', url: 'https://example.org/docs?utm_source=openai', title: '官方文档' };
const searchItem = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', sources: [{ url: 'https://example.org/docs' }, { url: 'https://example.org/other' }] } };
const messageItem = { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '单位是毫秒。', annotations: [citation] }] };
const completed = (output = []) => ({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 12, output_tokens: 4 } } });
const eventText = (events, newline = '\n') => events.map((e) => `data: ${JSON.stringify(e)}${newline}${newline}`).join('');
// The real 2.73.0 proxy emits a successful terminal without output[], with data in earlier events.
const proxyEvents = [
  { type: 'codex.rate_limits' },
  { type: 'response.web_search_call.completed', item_id: 'ws_1' },
  { type: 'response.output_item.done', item: searchItem, output_index: 0 },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: '单位是毫秒。' },
  { type: 'response.output_text.annotation.added', annotation: citation },
  { type: 'response.output_item.done', item: messageItem, output_index: 1 },
  completed()
];
function sse(events, chunkSize = 100, newline = '\n') {
  const bytes = new TextEncoder().encode(eventText(events, newline));
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(offset, offset + chunkSize)); offset = Math.min(bytes.length, offset + chunkSize);
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
let count = 0;
async function check(name, fn) { await fn(); console.log(`✓ ${++count}. ${name}`); }

await check('真实代理事件形状：空最终 output 不丢答案、引用和调用证据', async () => {
  const result = await readSearchResponse(sse(proxyEvents, 1, '\r\n'), '测试');
  assert.equal(result.summary, '单位是毫秒。'); assert.equal(result.searchCalls, 1);
  assert.equal(result.searched, true); assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.results.length, 2); assert.equal(result.results[0].title, '官方文档');
  assert.equal(result.results[0].url, 'https://example.org/docs');
});
await check('JSON 响应保留总结与来源，过滤无效 URL 并限制数量', async () => {
  const message = structuredClone(messageItem);
  message.content[0].annotations.unshift({ type: 'url_citation', url: 'javascript:alert(1)' }, { type: 'url_citation', url: 'https://secret:pass@example.org/' });
  const result = await readSearchResponse(Response.json(completed([searchItem, message]).response), '测试', 1);
  assert.equal(result.results.length, 1); assert.equal(result.results[0].url, 'https://example.org/docs');
  assert.equal(result.summary, '单位是毫秒。');
});
await check('仅流式正文和引用也可恢复；done 替换 delta 而不重复拼接', async () => {
  const events = [proxyEvents[1], proxyEvents[3], { type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, text: '最终答案' }, proxyEvents[4], completed()];
  const result = await readSearchResponse(sse(events), '测试');
  assert.equal(result.summary, '最终答案'); assert.equal(result.results.length, 1);
});
await check('完整最终快照优先于流式草稿，来源去重且检索次数不翻倍', async () => {
  const result = await readSearchResponse(sse([...proxyEvents.slice(0, -1), completed([searchItem, { ...messageItem, content: [{ type: 'output_text', text: '修订答案', annotations: [citation] }] }])]), '测试');
  assert.equal(result.summary, '修订答案'); assert.equal(result.searchCalls, 1);
  assert.equal(result.results.length, 2);
});
await check('完成事件后即结束读取，不等待代理关闭 SSE', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(eventText(proxyEvents))); }, cancel() { cancelled = true; } });
  const result = await readSearchResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), '测试');
  assert.equal(result.searched, true); assert.equal(cancelled, true);
});
await check('只有答案、伪造同名函数或未完成的搜索均不算联网成功', async () => {
  for (const item of [null, { type: 'function_call', name: 'web_search', status: 'completed' }, { ...searchItem, status: 'in_progress' }]) {
    await assert.rejects(readSearchResponse(Response.json(completed([messageItem, ...(item ? [item] : [])]).response), '测试'), /未返回已完成/);
  }
});
await check('搜索无结构化来源时不把正文中的链接冒充检索证据', async () => {
  const events = [proxyEvents[1], { ...proxyEvents[3], delta: 'Sources: https://example.org/made-up' }, completed()];
  await assert.rejects(readSearchResponse(sse(events), '测试'), /未返回有效来源/);
});
await check('截断、失败、不完整及坏 JSON 不返回部分成功', async () => {
  await assert.rejects(readSearchResponse(sse(proxyEvents.slice(0, -1)), '测试'), /提前结束/);
  for (const type of ['error', 'response.failed', 'response.incomplete']) {
    await assert.rejects(readSearchResponse(sse([...proxyEvents.slice(0, -1), { type }]), '测试'), /失败或结果不完整/);
  }
  await assert.rejects(readSearchResponse(new Response('data: {bad}\n\n', { headers: { 'content-type': 'text/event-stream' } }), '测试'), /JSON/);
  await assert.rejects(readSearchResponse(Response.json({ status: 'incomplete', output: [searchItem, messageItem] }), '测试'), /未正常完成/);
});
await check('响应读取与返回给聊天模型的总结都有上限', async () => {
  const message = structuredClone(messageItem); message.content[0].text = '长'.repeat(7000);
  const result = await readSearchResponse(Response.json(completed([searchItem, message]).response), '测试');
  assert.equal(result.summary.length, 6000); assert.equal(result.summaryTruncated, true);
  await assert.rejects(readSearchResponse(new Response(' '.repeat(2 * 1024 * 1024 + 1)), '测试'), /响应过大/);
});
await check('接口地址支持 v1 基址与完整 responses，拒绝夹带凭据的 URL', async () => {
  assert.equal(responsesUrl('http://localhost:10100/v1/'), 'http://localhost:10100/v1/responses');
  assert.equal(responsesUrl('http://localhost:10100/v1/responses/'), 'http://localhost:10100/v1/responses');
  for (const url of ['file:///secret', 'https://secret:pass@example.org/v1', 'https://example.org/v1?key=secret', 'invalid']) assert.throws(() => responsesUrl(url));
});

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.api.model = 'chat-model-unchanged'; cfg.api.apiKey = 'chat-key-must-not-leak';
cfg.snowluma.autoLaunch = false; cfg.memory.consolidateEnabled = false;
cfg.webSearch.provider = 'opencodex'; cfg.webSearch.opencodex.apiKey = 'proxy-key';
setRuntimeConfig(cfg);
const requests = [];
let handle = (_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(eventText(proxyEvents)); };
const proxy = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw || '{}') });
  handle(req, res);
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
cfg.webSearch.opencodex.baseUrl = `http://127.0.0.1:${proxy.address().port}/v1`;
const normalHandle = handle;
let app;
try {
  await check('统一搜索入口使用独立模型/Key，只发送查询，要求执行搜索', async () => {
    const result = await webSearch('测试 [CQ:at,qq=123] 搜索');
    assert.equal(result.searched, true);
    const req = requests.at(-1);
    assert.equal(req.path, '/v1/responses'); assert.equal(req.authorization, 'Bearer proxy-key');
    assert.equal(req.body.model, 'gpt-6-luna'); assert.equal(req.body.store, false); assert.equal(req.body.stream, true);
    assert.equal(req.body.tool_choice, 'required'); assert.deepEqual(req.body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(req.body.include, ['web_search_call.action.sources']);
    assert.equal(req.body.input[0].content[0].text, '测试 搜索');
    assert.equal(getConfig().api.model, 'chat-model-unchanged');
    assert.ok(!JSON.stringify(req).includes('chat-key-must-not-leak'));
  });
  await check('本地免 Key 模式不继承聊天 Key；Agent 工具实际返回总结和来源', async () => {
    cfg.webSearch.opencodex.apiKey = '';
    const def = buildToolDefs().find((t) => t.name === 'web_search');
    const result = await def.execute({}, { query: '测试搜索' });
    assert.equal(requests.at(-1).authorization, undefined);
    assert.ok(!result.isError); assert.match(result.content, /单位是毫秒/); assert.match(result.content, /example.org/);
    cfg.webSearch.opencodex.apiKey = 'proxy-key';
  });
  await check('HTTP 错误不泄露上游回显的 Key，也不自动重试或回退 Bing', async () => {
    const before = requests.length;
    handle = (_req, res) => { res.writeHead(401); res.end('proxy-key chat-key-must-not-leak'); };
    await assert.rejects(webSearch('测试'), (e) => /HTTP 401/.test(e.message) && !/proxy-key|chat-key/.test(e.message));
    assert.equal(requests.length, before + 1);
    handle = normalHandle;
  });
  await check('不跟随搜索服务重定向，防止 Key 发往其他地址', async () => {
    const before = requests.length;
    handle = (_req, res) => { res.writeHead(307, { location: cfg.webSearch.opencodex.baseUrl + '/elsewhere' }); res.end(); };
    await assert.rejects(webSearch('测试'), /连接失败/); assert.equal(requests.length, before + 1);
    handle = normalHandle;
  });
  await check('超时覆盖响应体读取；主动取消不会继续等待或重试', async () => {
    handle = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); };
    await assert.rejects(openCodexSearch('超时', { ...cfg.webSearch.opencodex, timeoutMs: 1000 }), /搜索超时/);
    const abort = new AbortController(); const pending = webSearch('取消', { signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(pending, /已取消/);
    handle = normalHandle;
  });

  app = createApp({ log() {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const testSearch = (query = '测试查询', headers = {}) => fetch(base + '/api/test/search', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ query }) });
  await check('控制台搜索测试使用已存配置，返回证据与耗时，不启动 QQ 或聊天运行', async () => {
    const response = await testSearch(); const r = await response.json();
    assert.equal(response.status, 200); assert.equal(r.ok, true); assert.equal(r.provider, 'opencodex');
    assert.equal(r.result.searched, true); assert.ok(r.latencyMs >= 0);
    assert.equal(app.orchestrator.runningChats.size, 0); assert.equal(app.store.listChats().length, 0);
  });
  await check('跨站测试和无效查询被拦截，不消耗搜索额度', async () => {
    const before = requests.length;
    assert.equal((await testSearch('测试', { origin: 'https://outside.invalid' })).status, 403);
    assert.equal((await testSearch('')).status, 400); assert.equal((await testSearch('x'.repeat(121))).status, 400);
    assert.equal(requests.length, before);
  });
  await check('并发测试只执行一次；失败后可重试', async () => {
    let release, entered;
    const started = new Promise((r) => { entered = r; });
    handle = (_req, res) => { release = () => { res.writeHead(500); res.end('proxy-key'); }; entered(); };
    const first = testSearch(); await started;
    assert.equal((await testSearch()).status, 409); release();
    const r = await (await first).json(); assert.equal(r.ok, false); assert.match(r.error, /HTTP 500/); assert.ok(!r.error.includes('proxy-key'));
    handle = normalHandle; assert.equal((await (await testSearch()).json()).ok, true);
  });
  await check('搜索 Key 的 GET/POST 配置均脱敏，正常保存保留 Key，可显式清除', async () => {
    const c = await (await fetch(base + '/api/config')).json();
    assert.equal(c.webSearch.opencodex.apiKey, undefined); assert.equal(c.webSearch.opencodex.hasApiKey, true);
    const save = async (patch) => (await fetch(base + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).json();
    const r = await save({ webSearch: { opencodex: { ...c.webSearch.opencodex, timeoutMs: 45000 } } });
    assert.equal(getConfig().webSearch.opencodex.apiKey, 'proxy-key');
    assert.equal(r.config.webSearch.opencodex.apiKey, undefined); assert.ok(!JSON.stringify(r).includes('proxy-key'));
    const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    assert.equal(disk.webSearch.opencodex.timeoutMs, 45000);
    assert.equal((await fetch(base + '/api/search-key?field=opencodex', { headers: { origin: 'https://outside.invalid' } })).status, 403);
    await save({ webSearch: { opencodex: { apiKey: '' } } });
    assert.equal(getConfig().webSearch.opencodex.apiKey, '');
  });
} finally {
  await app?.stop(); app?.server.closeAllConnections();
  proxy.closeAllConnections(); await new Promise((r) => proxy.close(r));
}
console.log(`\n${count} search checks passed`);
