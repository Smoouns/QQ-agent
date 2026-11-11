import './isolated-env.mjs';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { normalizeRunLimits, RunBudget } from '../src/run-budget.js';
import { inspectRequestContext, assertRequestContext, fitFinalizationContext } from '../src/request-context.js';
import { chatCompletionWithRetry, isRetryableError } from '../src/llm.js';

let count = 0;
async function check(label, fn) { await fn(); console.log(`✓ ${++count}. ${label}`); }
const limits = { maxContextTokens: 6000, contextReserveTokens: 1000, contextImageTokens: 1000 };
const initial = [{ role: 'system', content: '固定规则不能删除' }, { role: 'user', content: '历史和本轮问题不能删除' }];

await check('单次上下文与累计用量独立，容量预留归一化后有效', () => {
  const normalized = normalizeRunLimits({ maxContextTokens: 4096, contextReserveTokens: 128000 });
  assert.equal(normalized.contextReserveTokens, 3072);
  assert.equal(normalized.maxInputTokens, 120000);
  const budget = new RunBudget({ ...limits, maxInputTokens: 1000 });
  assert.equal(budget.stopReason({ promptTokens: 1000 }), 'input_budget');
  assert.ok(inspectRequestContext(initial, [], limits).fits);
  assert.equal(budget.stopReason({ promptTokens: 0 }), null);
  assert.throws(() => assertRequestContext([{ role: 'user', content: '中'.repeat(4000) }], [], limits), e => e.runLimit === 'context_capacity');
});

await check('估算包含中文、工具定义、调用参数和图片，图片字节不当文本重复计费', () => {
  const base = inspectRequestContext(initial, [], limits);
  const tool = [{ type: 'function', function: { name: 'fixture', description: '说明'.repeat(100), parameters: { type: 'object' } } }];
  assert.ok(inspectRequestContext(initial, tool, limits).estimatedInputTokens > base.estimatedInputTokens);
  const calls = [...initial, { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'fixture', arguments: '参'.repeat(1000) } }] }];
  assert.ok(inspectRequestContext(calls, tool, limits).estimatedInputTokens > base.estimatedInputTokens + 2000);
  const images = (url) => [...initial, { role: 'user', content: [{ type: 'image_url', image_url: { url } }] }];
  const short = inspectRequestContext(images('https://example.org/a.png'), [], limits);
  const large = inspectRequestContext(images('data:image/png;base64,' + 'A'.repeat(100000)), [], limits);
  assert.equal(short.estimatedInputTokens, large.estimatedInputTokens);
  assert.equal(large.imageTokens, 1000);
  assert.equal(large.imageCount, 1);
});

await check('本地超限不发送 HTTP、不重试，恰好等于可用输入允许通过', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.runLimits = { ...cfg.runLimits, ...limits }; setRuntimeConfig(cfg);
  let requests = 0, attempts = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('不应联网'); };
  try {
    await assert.rejects(chatCompletionWithRetry({ messages: [{ role: 'user', content: '中'.repeat(4000) }], beforeRequest: () => attempts++ }), e => {
      assert.equal(isRetryableError(e), false);
      assert.equal(e.code, 'CONTEXT_CAPACITY'); return true;
    });
    assert.equal(requests, 0); assert.equal(attempts, 1);
  } finally { globalThis.fetch = fetch; }
  const messages = [{ role: 'user', content: 'a'.repeat(10000) }];
  const n = inspectRequestContext(messages, [], limits).estimatedInputTokens;
  assert.doesNotThrow(() => assertRequestContext(messages, [], { ...limits, maxContextTokens: n + 1000 }));
  assert.throws(() => assertRequestContext(messages, [], { ...limits, maxContextTokens: n + 999 }));
});

await check('收尾仅在超限时移除较早工具结果，保留调用配对、新结果和原始输入', () => {
  const call = id => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'fixture', arguments: '{}' } }] });
  const messages = [...initial, call('old'), { role: 'tool', tool_call_id: 'old', name: 'fixture', content: '旧'.repeat(4000) },
    call('new'), { role: 'tool', tool_call_id: 'new', name: 'fixture', content: '最新完整证据' },
    { role: 'system', content: '收尾规则不能删除' }];
  const copy = structuredClone(messages);
  const result = fitFinalizationContext(messages, [], limits);
  assert.equal(result.before.fits, false); assert.equal(result.after.fits, true);
  assert.deepEqual(messages, copy);
  assert.deepEqual(result.messages.slice(0, 2), initial);
  assert.equal(result.messages.find(m => m.tool_call_id === 'new').content, '最新完整证据');
  assert.match(result.messages.find(m => m.tool_call_id === 'old').content, /已从当前请求移除/);
  assert.deepEqual(result.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['old', 'new']);
  assert.equal(result.removed.length, 1);
  const fits = fitFinalizationContext(messages, [], { ...limits, maxContextTokens: 20000 });
  assert.deepEqual(fits.messages, messages); assert.equal(fits.removed.length, 0);
});

await check('旧预算提示及工具图片可以移除，初始用户图片与聊天过大时失败关闭', () => {
  const messages = [...initial,
    { role: 'system', content: '[运行预算快照：旧] ' + '旧'.repeat(2000) },
    { role: 'system', content: '[运行预算快照：最新] 剩余预算' },
    { role: 'user', content: [{ type: 'text', text: '[系统：以下是工具 inspect_image 返回的 1 张图片，请直接看图回应]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  const fitted = fitFinalizationContext(messages, [], { ...limits, contextImageTokens: 6000 });
  assert.ok(fitted.after.fits);
  assert.ok(fitted.removed.some(r => r.type === 'budget_notice'));
  assert.ok(fitted.removed.some(r => r.type === 'tool_images'));
  assert.ok(fitted.messages.some(m => String(m.content).includes('最新')));
  const oversized = [{ role: 'user', content: '原文'.repeat(4000) }];
  const denied = fitFinalizationContext(oversized, [], limits);
  assert.equal(denied.after.fits, false);
  assert.deepEqual(denied.messages, oversized);
  const userImage = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.org' } }] }];
  const preserved = fitFinalizationContext(userImage, [], { ...limits, contextImageTokens: 6000 });
  assert.equal(preserved.after.fits, false);
  assert.deepEqual(preserved.messages, userImage);
});

console.log(`\n${count} request context checks passed`);
