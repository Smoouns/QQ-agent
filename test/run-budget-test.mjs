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

let checks = 0;
const check = async (name, fn) => { await fn(); console.log(`✓ ${++checks}. ${name}`); };
const call = (name, args = {}) => ({ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const originalFetch = globalThis.fetch;
let keyId = 800;
async function run({ modelCalls = 12, limits = {}, reply, tools = {}, beforeFinal, sendError, sendResult,
  revokeBeforeSend = false, vision = true, chatKind = 'private', promptTokens = 100 }) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.allowAllWhenEmpty = true; cfg.memory.consolidateEnabled = false; cfg.sticker.enabled = false;
  cfg.providersImported = true; cfg.api.provider = ''; cfg.api.model = 'budget-mock'; cfg.api.baseUrl = 'https://model.example/v1';
  cfg.api.apiKey = 'budget-test-only'; cfg.responseRules.groupMode = 'all';
  cfg.api.maxRounds = modelCalls; cfg.runLimits = { ...cfg.runLimits, ...limits };
  cfg.api.vision = vision;
  setRuntimeConfig(cfg);
  const key = `${chatKind}:${++keyId}`, requests = [], effects = [], store = new ChatStore(), sessions = new SessionRegistry();
  const orch = new Orchestrator({ store, memory: new MemoryStore(), sessions, stickers: {},
    onebot: { selfId: '999', selfNickname: 'bot', async getGroupInfo() { return { group_name: 'budget-test' }; } },
    sender: { async sendTextBatch(chatKey, text, options) {
      if (revokeBeforeSend) orch.setPaused(true);
      // effects records simulated attempts, including uncertain ones; session.sent records confirmations.
      options.beforeSend(); effects.push({ chatKey, text }); if (sendError) throw new Error(sendError);
      return sendResult ?? { sent: text.map(t => ({ text: t, at: '12:00', messageId: 1 })), failed: [] };
    } } });
  orch.scheduleWake = () => {};
  for (const [name, execute] of Object.entries(tools)) orch.toolDefs.find(d => d.name === name).execute = execute;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://model.example/v1/chat/completions', 'only the mocked model endpoint is allowed');
    const body = JSON.parse(options.body); requests.push(body);
    const final = body.messages.some(m => m.role === 'system' && m.content.includes('本轮已进入收尾阶段'));
    if (final && beforeFinal) await beforeFinal(orch, body);
    const next = reply ? await reply(body, requests.length, final) : { tool_calls: [call('get_recent_messages')] };
    if (next instanceof Error) throw next;
    return Response.json({ choices: [{ message: { role: 'assistant', ...(final ? { content: '根据已有资料找到线索，但尚未确认图片。' } : {}), ...next } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } });
  };
  store.appendIncoming(key, { mid: 1, senderId: '123', text: '请查资料并回复' });
  try {
    await orch.wake(key);
    return { requests, effects, session: sessions.get(sessions.index[0].id), store, key };
  } finally { await orch.abortAll(); globalThis.fetch = originalFetch; }
}

function assertSilentEnd(r, reason, requests) {
  assert.equal(r.requests.length, requests);
  assert.equal(r.effects.length, 0);
  assert.equal(r.session.sent.length, 0);
  assert.equal(r.session.status, 'noreply');
  assert.equal(r.session.error, null);
  assert.equal(r.session.terminationReason, reason);
  assert.equal(r.session.budget.stopReason, null);
  assert.equal(r.session.finalization.attempted, false);
  assert.equal(r.session.usageByPhase.finalization, undefined);
  assert.equal(r.store.unreadCount(r.key), 0);
}

for (const chatKind of ['private', 'group']) {
  for (const modelCalls of [3, 1]) {
    await check(`${chatKind} 无工具文字正常结束（模型额度 ${modelCalls}），不强制回复`, async () => {
      const r = await run({ chatKind, modelCalls, reply: () => ({ content: '暂时不发言，等下一条消息。' }) });
      assertSilentEnd(r, 'model_stop', 1);
      assert.equal(r.session.budget.modelAttempts, 1);
      assert.equal(r.session.budget.toolCalls, 0);
    });
  }
}

await check('最后一次续轮请求无工具文字结束，保留先前工具结果但不追加收尾', async () => {
  const r = await run({ modelCalls: 2, reply: (_b, n) => n === 1
    ? { tool_calls: [call('get_recent_messages')] } : { content: '已经看完，决定不发言。' } });
  assertSilentEnd(r, 'model_stop', 2);
  assert.equal(r.session.budget.modelAttempts, 2);
  assert.equal(r.session.budget.toolCalls, 1);
});

await check('常规空输出或空工具列表在次数边界仍保留自然沉默语义', async () => {
  for (const content of ['', null]) {
    for (const modelCalls of [3, 1]) {
      const r = await run({ modelCalls, reply: () => ({ content, tool_calls: [] }) });
      assertSilentEnd(r, 'model_stop', 1);
    }
  }
});

await check('无工具响应恰好达到或超过输入预算，主动结束不变成预算收尾', async () => {
  for (const promptTokens of [1000, 1200]) {
    const r = await run({ promptTokens, limits: { maxInputTokens: 1000 }, reply: () => ({ content: '保持沉默。' }) });
    assertSilentEnd(r, 'model_stop', 1);
    assert.equal(r.session.usage.promptTokens, promptTokens);
  }
});

for (const [label, options] of [
  ['额度充足', {}],
  ['最后一次模型请求', { modelCalls: 1 }],
  ['最后一个工具名额', { limits: { maxToolCalls: 1 } }],
  ['模型和工具同时到达上限', { modelCalls: 1, limits: { maxToolCalls: 1 } }]
]) {
  await check(`成功 finish 在${label}时主动结束，不强制回复`, async () => {
    const r = await run({ ...options, reply: (_b, _n, final) => final
      ? { content: '不应触发的额外收尾回复。' } : { tool_calls: [call('finish', { summary: '不打断群聊' })] } });
    assertSilentEnd(r, 'model_finish', 1);
    assert.equal(r.session.finishReason, '不打断群聊');
    assert.equal(r.session.budget.toolCalls, 1);
    assert.equal(r.session.toolCounts.finish, 1);
  });
}

await check('文本内联 finish 在最后模型请求仍按成功工具结束', async () => {
  const r = await run({ modelCalls: 1, reply: (_b, _n, final) => ({ content: final
    ? '不应触发的额外收尾回复。' : '<tool_call>{"name":"finish","arguments":{"summary":"等待后续"}}</tool_call>' }) });
  assertSilentEnd(r, 'model_finish', 1);
  assert.equal(r.session.finishReason, '等待后续');
});

await check('finish 被预算阻止或执行失败不等于主动结束，仍保留预算收尾', async () => {
  for (const blocked of [true, false]) {
    const r = await run({ modelCalls: 1, limits: { maxToolCalls: 1 },
      tools: blocked ? {} : { finish: async () => ({ content: 'finish 执行失败', isError: true }) },
      reply: (_b, _n, final) => final ? { content: '根据已有结果收尾。' }
        : { tool_calls: [...(blocked ? [call('get_recent_messages')] : []), call('finish', { summary: '不能假定成功' })] } });
    assert.equal(r.session.terminationReason, 'tool_budget');
    assert.equal(r.session.finalization.attempted, true);
    assert.equal(r.requests.length, 2);
    assert.equal(r.effects.length, 1);
    assert.equal(r.session.sent.length, 1);
    const finish = r.session.messages.find(m => m.toolCall?.name === 'finish').toolCall;
    assert.equal(finish.blocked, blocked);
    assert.equal(finish.isError, true);
  }
});

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
  assert.equal(r.session.sent.length, 1); assert.equal(r.session.status, 'done');
  assert.equal(r.session.terminationReason, 'model_budget');
});

await check('已经成功发送后在最后模型请求主动结束，保留结束原因且不重复回复', async () => {
  for (const explicit of [false, true]) {
    const r = await run({ modelCalls: 2, reply: (_b, n) => n === 1
      ? { tool_calls: [call('send_message', { messages: '已经回复' })] }
      : explicit ? { tool_calls: [call('finish', { summary: '回复完成' })] } : { content: '回复完成。' } });
    assert.equal(r.requests.length, 2); assert.equal(r.effects.length, 1); assert.equal(r.session.sent.length, 1);
    assert.equal(r.session.status, 'done'); assert.equal(r.session.finalization.attempted, false);
    assert.equal(r.session.terminationReason, explicit ? 'model_finish' : 'model_stop');
    assert.equal(r.session.budget.stopReason, null);
  }
});

await check('文字批次部分确认成功、部分结果未知时，不追加预算收尾或重发整个批次', async () => {
  const r = await run({ modelCalls: 1, sendResult: {
    sent: [{ text: '第一条', messageId: 1, at: '12:00' }],
    failed: [{ index: 1, text: '第二条', error: '投递结果未知' }]
  }, reply: () => ({ tool_calls: [call('send_message', { messages: ['第一条', '第二条'] })] }) });
  assert.equal(r.requests.length, 1); assert.equal(r.effects.length, 1);
  assert.deepEqual(r.effects[0].text, ['第一条', '第二条']);
  assert.equal(r.session.sent.length, 1); assert.equal(r.session.sent[0].text, '第一条');
  assert.equal(r.session.finalization.attempted, false); assert.equal(r.session.status, 'done');
  assert.match(r.session.messages.find(m => m.toolCall?.name === 'send_message').toolCall.result, /投递结果未知/);
});

await check('文字投递未知后主动结束：一次发送尝试不等于沉默或确认送达，也不触发重放', async () => {
  for (const modelCalls of [3, 2]) {
    for (const explicit of [false, true]) {
      const r = await run({ modelCalls, sendError: '投递结果未知', reply: (_b, n) => n === 1
        ? { tool_calls: [call('send_message', { messages: '结果' })] }
        : explicit ? { tool_calls: [call('finish', { summary: '不要重试投递' })] } : { content: '停止，避免重复投递。' } });
      assert.equal(r.requests.length, 2); assert.equal(r.effects.length, 1);
      assert.equal(r.session.sent.length, 0); assert.equal(r.session.sideEffectAttempted, true);
      // noreply means no confirmed sends; the failed attempt remains visible in the tool log.
      assert.equal(r.session.status, 'noreply'); assert.equal(r.session.finalization.attempted, false);
      assert.equal(r.session.terminationReason, explicit ? 'model_finish' : 'model_stop');
      assert.equal(r.session.budget.stopReason, null);
      const delivery = r.session.messages.find(m => m.toolCall?.name === 'send_message').toolCall;
      assert.equal(delivery.isError, true); assert.equal(delivery.blocked, false);
      assert.match(delivery.result, /投递结果未知/);
      assert.equal(r.store.unreadCount(r.key), 0);
    }
  }
});

await check('常规文字投递未知后预算强制结束，收尾不再尝试文字发送', async () => {
  const r = await run({ modelCalls: 1, sendError: '投递结果未知', reply: (_b, _n, final) => final
    ? { content: '这条不应再次投递。' } : { tool_calls: [call('send_message', { messages: '结果' })] } });
  assert.equal(r.requests.length, 2); assert.equal(r.effects.length, 1); assert.equal(r.session.sent.length, 0);
  assert.equal(r.session.terminationReason, 'model_budget'); assert.equal(r.session.finalization.attempted, true);
  assert.equal(r.session.status, 'error'); assert.match(r.session.error, /未确认成功.*不自动重发/);
  assert.equal(r.session.sideEffectAttempted, true); assert.equal(r.store.unreadCount(r.key), 0);
});

await check('同一响应中已尝试的未知文字投递不能借预留额度重复执行', async () => {
  const r = await run({ limits: { maxToolCalls: 1 }, sendError: '投递结果未知', reply: (_b, _n, final) => final
    ? { content: '这条也不应再次投递。' }
    : { tool_calls: ['first', 'second'].map(id => ({ ...call('send_message', { messages: '结果' }), id })) } });
  assert.equal(r.requests.length, 2); assert.equal(r.effects.length, 1); assert.equal(r.session.sent.length, 0);
  assert.equal(r.session.terminationReason, 'tool_budget'); assert.equal(r.session.status, 'error');
  const deliveries = r.session.messages.filter(m => m.toolCall?.name === 'send_message');
  assert.equal(deliveries.length, 2); assert.equal(deliveries[0].toolCall.blocked, false);
  assert.equal(deliveries[1].toolCall.blocked, true); assert.equal(deliveries[1].toolCall.reserved, true);
  assert.equal(r.store.unreadCount(r.key), 0);
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
    assert.equal(r.session.sent.length, 0);
    if (mode === 'send') {
      assert.equal(r.session.sideEffectAttempted, true); assert.equal(r.store.unreadCount(r.key), 0);
      assert.match(r.session.error, /投递结果未知/);
    }
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
await check('最后一次常规模型请求已成功发送图片，不追加收尾请求或文字', async () => {
  let attempts = 0;
  const r = await run({ modelCalls: 1, tools: { send_image: async ctx => { attempts++; return sendPicture(ctx); } },
    reply: () => ({ tool_calls: [call('send_image', { imageId: 'fixture' })] }) });
  assert.equal(attempts, 1); assert.equal(r.requests.length, 1); assert.equal(r.effects.length, 0);
  assert.equal(r.session.sent.length, 1); assert.equal(r.session.sent[0].type, 'image');
  assert.equal(r.session.terminationReason, 'model_budget'); assert.equal(r.session.status, 'done');
  assert.equal(r.session.finalization.attempted, false);
});

await check('常规图片投递未知不在收尾重发，保留一次文字说明且其失败也不重放', async () => {
  for (const textUnknown of [false, true]) {
    let imageAttempts = 0;
    const explanation = '图片投递结果未知，请核对聊天记录，暂不重发。';
    const r = await run({ modelCalls: 1, sendError: textUnknown ? '文字投递结果未知' : undefined,
      tools: { send_image: async () => { imageAttempts++; return { content: '图片投递结果未知', isError: true }; } },
      reply: body => body.tools ? { tool_calls: [call('send_image', { imageId: 'fixture' })] } : { content: explanation } });
    assert.equal(imageAttempts, 1); assert.equal(r.requests.length, 3); assert.equal(r.effects.length, 1);
    assert.deepEqual(r.effects[0].text, [explanation]);
    assert.equal(r.session.sent.length, textUnknown ? 0 : 1);
    assert.ok(r.session.sent.every(s => s.type === 'text'));
    assert.equal(r.session.terminationReason, 'model_budget');
    assert.equal(r.session.status, textUnknown ? 'error' : 'done');
    const images = r.session.messages.filter(m => m.toolCall?.name === 'send_image');
    assert.equal(images.length, 2); assert.equal(images[0].toolCall.blocked, false);
    assert.equal(images[1].toolCall.blocked, true); assert.equal(images[1].toolCall.finalization, true);
    assert.equal(r.session.sideEffectAttempted, true); assert.equal(r.store.unreadCount(r.key), 0);
  }
});

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
