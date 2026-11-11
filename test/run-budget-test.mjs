import './isolated-env.mjs';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { RunBudget, boundedToolText } from '../src/run-budget.js';
import { extractPageContent } from '../src/webpage-content.js';
import { extractWebpageImages } from '../src/webpage-images.js';
import { ChatStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { SessionRegistry } from '../src/sessions.js';
import { Orchestrator } from '../src/orchestrator.js';
import { inspectRequestContext } from '../src/request-context.js';

let checks = 0;
const check = async (name, fn) => { await fn(); console.log(`✓ ${++checks}. ${name}`); };
const call = (name, args = {}) => ({ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const originalFetch = globalThis.fetch;
let keyId = 800;
async function run({ modelCalls = 12, limits = {}, reply, tools = {}, beforeFinal, sendError, revokeBeforeSend = false, vision = true, userText = '请查资料并回复' }) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.allowAllWhenEmpty = true; cfg.memory.consolidateEnabled = false; cfg.sticker.enabled = false;
  cfg.providersImported = true; cfg.api.provider = ''; cfg.api.model = 'budget-mock'; cfg.api.baseUrl = 'https://model.example/v1';
  cfg.api.maxRounds = modelCalls; cfg.runLimits = { ...cfg.runLimits, ...limits };
  cfg.api.vision = vision;
  setRuntimeConfig(cfg);
  const key = `private:${++keyId}`, requests = [], effects = [], store = new ChatStore(), sessions = new SessionRegistry();
  const orch = new Orchestrator({ store, memory: new MemoryStore(), sessions, stickers: {},
    onebot: { selfId: '999', selfNickname: 'bot' }, sender: { async sendTextBatch(chatKey, text, options) {
      if (revokeBeforeSend) orch.setPaused(true);
      options.beforeSend(); effects.push({ chatKey, text }); if (sendError) throw new Error(sendError);
      return { sent: text.map(t => ({ text: t, at: '12:00', messageId: 1 })), failed: [] };
    } } });
  orch.scheduleWake = () => {};
  for (const [name, execute] of Object.entries(tools)) orch.toolDefs.find(d => d.name === name).execute = execute;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const final = body.messages.some(m => m.role === 'system' && m.content.includes('本轮已进入收尾阶段'));
    if (final && beforeFinal) await beforeFinal(orch, body);
    const next = reply ? await reply(body, requests.length, final) : { tool_calls: [call('get_recent_messages')] };
    if (next instanceof Error) throw next;
    return Response.json({ choices: [{ message: { role: 'assistant', ...(final ? { content: '根据已有资料找到线索，但尚未确认图片。' } : {}), ...next } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  };
  store.appendIncoming(key, { mid: 1, senderId: '123', text: userText });
  try {
    await orch.wake(key);
    return { requests, effects, session: sessions.get(sessions.index[0].id), store, key };
  } finally { await orch.abortAll(); globalThis.fetch = originalFetch; }
}

await check('模型额度用尽后读取最后工具结果，收尾只开放有限交付工具', async () => {
  const r = await run({ modelCalls: 1, tools: { web_search: async () => ({ content: JSON.stringify({ results: [{ url: 'https://example.org/evidence' }], summary: '刚刚查到的线索' }) }) },
    reply: (_b, _n, final) => final ? { content: '查到的来源是 https://example.org/evidence，尚未确认图片。' } : { tool_calls: [call('web_search', { query: 'school' })] } });
  assert.equal(r.requests.length, 2); assert.equal(r.effects.length, 1);
  assert.ok(r.requests[1].tools.some(t => t.function.name === 'inspect_image'));
  assert.ok(r.requests[1].tools.every(t => ['send_image', 'send_message', 'import_image', 'inspect_image', 'get_message_images'].includes(t.function.name)));
  assert.match(JSON.stringify(r.requests[1].messages), /刚刚查到的线索/);
  assert.ok(r.requests[1].messages.every(m => !('raw' in m)));
  assert.equal(r.session.terminationReason, 'model_budget'); assert.equal(r.session.status, 'done');
  assert.equal(r.session.usageByPhase.finalization.calls, 1);
  assert.equal(r.session.budget.toolCalls, 1); assert.equal(r.session.finalization.sent, true);
});

await check('一个模型回合的多个工具各自扣次，预算外不执行且补齐 tool 协议', async () => {
  let executed = 0;
  const r = await run({ limits: { maxToolCalls: 1 }, tools: { get_recent_messages: async () => { executed++; return { content: '已有资料' }; } },
    reply: (_b, _n, final) => final ? { content: '已有资料说明情况。' } : { tool_calls: [1, 2, 3].map(n => ({ ...call('get_recent_messages', { limit: n }), id: `c${n}` })) } });
  assert.equal(executed, 1); assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].messages.filter(m => m.role === 'tool').length, 3);
  assert.equal(r.session.budget.modelAttempts, 1); assert.equal(r.session.terminationReason, 'tool_budget');
  assert.equal(r.session.messages.filter(m => m.toolCall?.blocked).length, 2);
});

await check('已经发送回复后耗尽预算，不再额外请求或发送', async () => {
  const r = await run({ modelCalls: 1, reply: () => ({ tool_calls: [call('send_message', { messages: '已经回复' })] }) });
  assert.equal(r.requests.length, 1); assert.equal(r.effects.length, 1); assert.equal(r.session.finalization.attempted, false);
});

await check('自然沉默保持原语义，不把每次 finish 都变成强制回复', async () => {
  const r = await run({ reply: () => ({ tool_calls: [call('finish', { summary: '不打断群聊' })] }) });
  assert.equal(r.session.status, 'noreply'); assert.equal(r.session.terminationReason, 'model_finish');
  assert.equal(r.requests.length, 1); assert.equal(r.effects.length, 0);
});

await check('相同搜索不重新执行，连续无进展进入一次收尾', async () => {
  let searches = 0;
  const r = await run({ limits: { noProgressLimit: 2 }, tools: { web_search: async () => { searches++; return { content: JSON.stringify({ results: [{ url: 'https://example.org' }] }) }; } },
    reply: (_b, _n, final) => final ? { content: '目前只有这条线索。' } : { tool_calls: [call('web_search', { query: 'same' })] } });
  assert.equal(searches, 1); assert.equal(r.requests.length, 4); assert.equal(r.session.terminationReason, 'no_progress');
});

await check('换关键词但只得到相同来源也属于无进展', async () => {
  let searches = 0;
  const r = await run({ limits: { noProgressLimit: 2, maxSearchCalls: 10 }, tools: { web_search: async () => { searches++; return { content: JSON.stringify({ results: [{ url: 'https://example.org' }] }) }; } },
    reply: (_b, n, final) => final ? { content: '未找到更多证据。' } : { tool_calls: [call('web_search', { query: `variant${n}` })] } });
  assert.equal(searches, 3); assert.equal(r.requests.length, 4); assert.equal(r.session.terminationReason, 'no_progress');
});

await check('工具返回正文有硬字符上限，日志与实际输入保持一致', async () => {
  const r = await run({ modelCalls: 1, limits: { toolResultMaxChars: 1000 }, tools: { get_recent_messages: async () => ({ content: 'a'.repeat(9000) }) },
    reply: (_b, _n, final) => final ? { content: '已读取可见部分。' } : { tool_calls: [call('get_recent_messages')] } });
  const log = r.session.messages.find(m => m.toolCall?.name === 'get_recent_messages').toolCall;
  assert.equal(log.originalChars, 9000); assert.equal(log.truncated, true);
  assert.equal(r.requests[1].messages.find(m => m.role === 'tool').content, log.result);
  assert.ok(log.result.length <= 1000);
});

await check('收尾期间暂停或发送前撤销，不发送且不重试', async () => {
  for (const mode of ['beforeFinal', 'beforeSend']) {
    const r = await run({ modelCalls: 1, beforeFinal: mode === 'beforeFinal' ? o => o.setPaused(true) : undefined,
      revokeBeforeSend: mode === 'beforeSend', reply: (_b, _n, final) => final ? { content: '不要发送' } : { tool_calls: [call('get_recent_messages')] } });
    assert.equal(r.effects.length, 0); assert.equal(r.requests.length, 2); assert.equal(r.session.status, 'error');
  }
});

await check('收尾模型失败、空结果或投递不确定不会自动重放整轮', async () => {
  for (const mode of ['network', 'empty', 'send']) {
    const r = await run({ modelCalls: 1, sendError: mode === 'send' ? '投递结果未知' : undefined,
      reply: (_b, _n, final) => !final ? { tool_calls: [call('get_recent_messages')] } : mode === 'network' ? new TypeError('network failed') : { content: mode === 'empty' ? '' : '收尾回复' } });
    assert.equal(r.requests.length, 2); assert.equal(r.session.status, 'error'); assert.equal(r.session.finalization.attempted, true);
    assert.equal(r.effects.length, mode === 'send' ? 1 : 0);
  }
});

await check('分类工具预算、时间与累计输入预算分别生效', () => {
  let now = 0; const b = new RunBudget({ maxToolCalls: 10, maxSearchCalls: 1, maxRunMs: 10000, maxInputTokens: 1000 }, () => now);
  assert.equal(b.admit('web_search', '{"query":"a"}'), null);
  assert.match(b.admit('web_search', '{"query":"b"}'), /预算/);
  assert.equal(b.admit('web_fetch', '{"url":"https://example.org"}'), null);
  assert.equal(b.stopReason({ promptTokens: 1000 }), 'input_budget');
  now = 10000; assert.equal(b.stopReason({ promptTokens: 0 }), 'time_budget');
});

await check('累计输入达到阈值后转入收尾，不继续执行探索工具', async () => {
  const r = await run({ limits: { maxInputTokens: 1000, maxToolCalls: 100 },
    reply: (_b, _n, final) => final ? { content: '基于已有资料的结果。' } : { tool_calls: [call('get_recent_messages')] } });
  assert.equal(r.requests.length, 11); assert.equal(r.session.budget.toolCalls, 9);
  assert.equal(r.session.terminationReason, 'input_budget'); assert.equal(r.effects.length, 1);
});

await check('工具结果撑满单次容量时不发超限请求，裁减收尾上下文且保留日志', async () => {
  const baseline = await run({ reply: () => ({ tool_calls: [call('finish', { summary: '基线' })] }) });
  const initialSize = inspectRequestContext(baseline.requests[0].messages, baseline.requests[0].tools, {}).estimatedInputTokens;
  const limits = { maxContextTokens: initialSize + 4500, contextReserveTokens: 4096, maxInputTokens: 2000000, toolResultMaxChars: 20000 };
  const r = await run({ limits, tools: { get_recent_messages: async () => ({ content: '很长的证据'.repeat(3000) }) },
    reply: (_b, _n, final) => final ? { content: '只根据当前可见资料收尾。' } : { tool_calls: [call('get_recent_messages')] } });
  assert.equal(r.session.terminationReason, 'context_capacity');
  assert.equal(r.requests.length, 2); assert.equal(r.session.budget.modelAttempts, 1);
  assert.equal(r.session.budget.toolCalls, 1); assert.equal(r.effects.length, 1);
  assert.ok(r.requests.every(b => inspectRequestContext(b.messages, b.tools, limits).fits));
  assert.ok(r.session.finalization.contextChecks.some(c => c.removed.some(x => x.type === 'tool_result')));
  assert.ok(r.session.messages.find(m => m.toolCall?.name === 'get_recent_messages').toolCall.result.includes('很长的证据'));
  assert.match(r.requests[1].messages.find(m => m.role === 'tool').content, /已从当前请求移除/);
});

await check('初始聊天本身超限时正常请求与收尾都不发送，错误可诊断', async () => {
  const r = await run({ limits: { maxContextTokens: 4096, contextReserveTokens: 1024 }, userText: '内容'.repeat(5000) });
  assert.equal(r.requests.length, 0); assert.equal(r.effects.length, 0);
  assert.equal(r.session.budget.modelAttempts, 0); assert.equal(r.session.finalization.modelAttempts, 0);
  assert.equal(r.session.terminationReason, 'context_capacity');
  assert.equal(r.session.status, 'error'); assert.match(r.session.error, /上下文容量不足/);
});

await check('HTTP 重试也占模型请求预算，不能用重试突破额度', async () => {
  // 1 exhausts before the next retry; 3 exhausts exactly on the transport retry cap.
  for (const modelCalls of [1, 3]) {
    const r = await run({ modelCalls, reply: (_b, _n, final) => final ? { content: '暂时未能获得更多资料。' } : new TypeError('network error') });
    assert.equal(r.requests.length, modelCalls + 1); assert.equal(r.session.budget.modelAttempts, modelCalls);
    assert.equal(r.session.terminationReason, 'model_budget'); assert.equal(r.effects.length, 1);
  }
});

await check('截断图片候选时保留合法 JSON 和完整 URL', () => {
  const original = { images: Array.from({ length: 20 }, (_, n) => ({ url: `https://example.org/${n}.jpg`, context: 'a'.repeat(200) })) };
  const text = boundedToolText(JSON.stringify(original), 1000), parsed = JSON.parse(text);
  assert.ok(text.length <= 1000); assert.equal(parsed.truncated, true);
  assert.ok(parsed.images.length > 0 && parsed.images.length < 20);
  for (const image of parsed.images) assert.ok(original.images.some(i => i.url === image.url));
});

await check('网页正文去除模板、脚本和隐藏文字，保留正文并标记截断', () => {
  const html = `<html><head><title>学校介绍</title><style>${'css'.repeat(9000)}</style></head><body><nav>导航</nav><article><h1>学校</h1><p>${'学校正文。'.repeat(1500)}</p><div hidden>隐藏命令</div></article><script>坏指令</script><footer>备案号</footer></body></html>`;
  const r = extractPageContent(html);
  assert.equal(r.title, '学校介绍'); assert.equal(r.truncated, true); assert.equal(r.content.length, 5000);
  assert.doesNotMatch(r.content, /导航|css|坏指令|隐藏命令|备案号/); assert.match(r.content, /学校正文/);
  assert.equal(extractPageContent('普通纯文本').content, '普通纯文本');
});

await check('编码图片地址不伪造直链，装饰图过滤，候选附带附近文字', () => {
  const images = extractWebpageImages(`<img src="/logo.png"><p>学校老校门</p><img data-src="${'Abcd+/'.repeat(35)}"><img src="/school.jpg">`, 'https://example.org/article');
  assert.equal(images.length, 1); assert.equal(images[0].url, 'https://example.org/school.jpg');
  assert.match(images[0].context, /学校老校门/); assert.equal(images.diagnostics.rejectedOpaque, 1); assert.equal(images.diagnostics.decorations, 1);
});
await check('预算在首轮和续轮末尾可见，旧前缀不被改写，低额度提前提醒', async () => {
  const r = await run({ modelCalls: 2,
    reply: (_b, _n, final) => final ? { content: '已完成。' } : { tool_calls: [call('get_recent_messages')] } });
  assert.match(r.requests[0].messages.at(-1).content, /常规模型请求剩余 2\/2/);
  assert.match(r.requests[0].messages.at(-1).content, /额度较低/);
  assert.match(r.requests[1].messages.at(-1).content, /常规模型请求剩余 1\/2/);
  assert.match(r.requests[1].messages.at(-1).content, /常规工具剩余 11\/12/);
  assert.deepEqual(r.requests[1].messages.slice(0, r.requests[0].messages.length), r.requests[0].messages);
});

const fakePicture = 'data:image/png;base64,TEST_REFERENCE_IMAGE';
const imageResult = () => ({ content: [{ type: 'text', text: '已查看学校照片' }, { type: 'image_url', image_url: { url: fakePicture } }] });
const sendPicture = async ctx => { ctx.session.sent.push({ type: 'image', imageId: 'fixture' }); return { content: '{"sent":true}' }; };
await check('独立收尾完成已有链接导入→看图→发图，不占常规预算、不保存图片字节', async () => {
  const r = await run({ modelCalls: 1, tools: {
    import_image: async () => ({ content: '{"imageId":"fixture"}' }), inspect_image: imageResult, send_image: sendPicture
  }, reply: (body, n, final) => !final ? { tool_calls: [call('get_recent_messages')] }
    : n === 2 ? { tool_calls: [call('import_image', { url: 'https://example.org/school.png' })] }
    : n === 3 ? { tool_calls: [call('inspect_image', { imageId: 'fixture' })] }
    : { tool_calls: [call('send_image', { imageId: 'fixture' })] } });
  assert.equal(r.requests.length, 4); assert.equal(r.session.status, 'done');
  assert.equal(r.session.budget.toolCalls, 1); assert.equal(r.session.finalization.toolCalls, 3);
  assert.equal(r.session.usageByPhase.finalization.calls, 3);
  assert.ok(JSON.stringify(r.requests[3].messages).includes(fakePicture));
  assert.ok(!JSON.stringify(r.session).includes(fakePicture));
  assert.equal(r.effects.length, 0); assert.equal(r.session.sent[0].type, 'image');
});

await check('同一回合常规预算刚耗尽时，后续看图仍能使用预留额度', async () => {
  let inspected = 0;
  const r = await run({ limits: { maxToolCalls: 1 }, tools: {
    inspect_image: async () => { inspected++; return imageResult(); }, send_image: sendPicture
  }, reply: (_b, _n, final) => final ? { tool_calls: [call('send_image', { imageId: 'fixture' })] }
    : { tool_calls: [call('get_recent_messages'), call('inspect_image', { imageId: 'fixture' })] } });
  assert.equal(inspected, 1); assert.equal(r.requests.length, 2);
  assert.equal(r.session.finalization.toolCalls, 2); assert.equal(r.session.budget.toolCalls, 1);
  assert.ok(r.session.messages.some(m => m.toolCall?.name === 'inspect_image' && m.toolCall.reserved && !m.toolCall.blocked));
});

await check('收尾禁止搜索、生图等探索，最多三轮后进入一次纯文字保底', async () => {
  let forbidden = 0;
  const r = await run({ modelCalls: 1, tools: { web_search: async () => { forbidden++; return { content: '{}' }; }, generate_image: async () => { forbidden++; return { content: '{}' }; } },
    reply: (body, n, final) => !final ? { tool_calls: [call('get_recent_messages')] }
      : !body.tools ? { content: '已有资料不足以完成请求。' }
      : { tool_calls: [call(n === 2 ? 'generate_image' : 'web_search', { query: 'new search' })] } });
  assert.equal(forbidden, 0); assert.equal(r.requests.length, 5); assert.equal(r.effects.length, 1);
  assert.equal(r.session.finalization.textFallback, true); assert.equal(r.session.finalization.modelAttempts, 4);
  assert.equal(r.requests.at(-1).tools, undefined);
  for (const req of r.requests.slice(1, -1)) assert.ok(req.tools.every(t => !['web_search', 'generate_image'].includes(t.function.name)));
});

await check('收尾重复看图只执行一次，额外工具调用逐个配对并计入独立上限', async () => {
  let inspected = 0;
  const r = await run({ modelCalls: 1, tools: { inspect_image: async () => { inspected++; return imageResult(); } },
    reply: (body, _n, final) => !final ? { tool_calls: [call('get_recent_messages')] }
      : !body.tools ? { content: '图片已查看，但未确认适用。' }
      : { tool_calls: [1, 2].map(n => ({ ...call('inspect_image', { imageId: 'fixture' }), id: `image_${n}` })) } });
  assert.equal(inspected, 1); assert.equal(r.session.finalization.toolCalls, 1);
  assert.equal(r.requests.length, 5); assert.equal(r.requests.at(-1).messages.filter(m => m.role === 'tool').length, 7);
});

await check('图片投递结果未知不自动重发，改用一次文字说明；文字投递失败不再补发', async () => {
  for (const name of ['send_image', 'send_message']) {
    let attempts = 0;
    const r = await run({ modelCalls: 1, tools: { [name]: async () => { attempts++; return { content: '投递结果未知', isError: true }; } },
      reply: (body, _n, final) => !final ? { tool_calls: [call('get_recent_messages')] }
        : !body.tools ? { content: '图片发送未确认成功，暂不重发。' }
        : { tool_calls: [call(name, name === 'send_image' ? { imageId: 'fixture' } : { messages: '结果' })] } });
    assert.equal(attempts, 1);
    assert.equal(r.requests.length, name === 'send_image' ? 3 : 2);
    assert.equal(r.session.status, name === 'send_image' ? 'done' : 'error');
  }
});
await check('一轮返回多个收尾工具也严格限四次，第五次阻止后仍可纯文字保底', async () => {
  const executed = [];
  const names = ['import_image', 'get_message_images', 'inspect_image', 'send_image'];
  const tools = Object.fromEntries(names.map(name => [name, async () => {
    executed.push(name); return { content: name === 'send_image' ? '发送失败' : '已有结果', isError: name === 'send_image' };
  }]));
  const r = await run({ modelCalls: 1, tools, reply: (body, _n, final) => !final
    ? { tool_calls: [call('get_recent_messages')] }
    : !body.tools ? { content: '图片发送未确认。' }
    : { tool_calls: [...names, 'send_message'].map(name => call(name, name === 'send_message' ? { messages: '结果' } : {})) } });
  assert.deepEqual(executed, names); assert.equal(r.session.finalization.toolCalls, 4);
  assert.equal(r.effects.length, 1); assert.equal(r.requests.length, 3);
  assert.ok(r.session.messages.some(m => m.toolCall?.name === 'send_message' && m.toolCall.blocked));
  assert.equal(r.requests.at(-1).messages.filter(m => m.role === 'tool').length, 6);
});

await check('视觉关闭时收尾不开放看图，模型强行调用也不能执行', async () => {
  let inspections = 0;
  const r = await run({ vision: false, modelCalls: 1, tools: { inspect_image: async () => { inspections++; return imageResult(); } },
    reply: (_b, n, final) => !final ? { tool_calls: [call('get_recent_messages')] }
      : n === 2 ? { tool_calls: [call('inspect_image', { imageId: 'fixture' })] } : { content: '当前无法查看图片。' } });
  assert.equal(inspections, 0); assert.equal(r.session.status, 'done');
  assert.ok(!r.requests[1].tools.some(t => ['inspect_image', 'get_message_images'].includes(t.function.name)));
});

await check('同一回合额度耗尽后可直接发送已有图片，成功后不追加收尾模型请求', async () => {
  const r = await run({ limits: { maxToolCalls: 1 }, tools: { send_image: sendPicture },
    reply: () => ({ tool_calls: [call('get_recent_messages'), call('send_image', { imageId: 'fixture' })] }) });
  assert.equal(r.requests.length, 1); assert.equal(r.session.sent.length, 1);
  assert.equal(r.session.budget.toolCalls, 1); assert.equal(r.session.budget.completion.toolCalls, 1);
  assert.equal(r.session.finalization.attempted, false); assert.equal(r.session.status, 'done');
});
console.log(`\n${checks} run budget checks passed`);
