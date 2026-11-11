import { normalizeRunLimits } from './run-budget.js';

// Provider-neutral approximation, not a tokenizer. Do not count base64 as text tokens.
function textTokens(value) {
  const text = String(value ?? '');
  let ascii = 0, other = 0;
  for (const ch of text) { if (ch.codePointAt(0) < 128) ascii++; else other += ch.codePointAt(0) > 0xffff ? 4 : 2; }
  return Math.ceil(ascii / 3) + other;
}

export function inspectRequestContext(messages, tools, limits) {
  const cfg = normalizeRunLimits(limits);
  let imageCount = 0;
  const sanitized = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((part) => {
    if (part.type !== 'image_url') return part;
    imageCount++;
    return { type: 'image_url', image_url: { detail: part.image_url?.detail || 'auto' } };
  }) : m.content }));
  const textEstimate = textTokens(JSON.stringify(sanitized)) + textTokens(JSON.stringify(tools || []));
  const estimatedInputTokens = textEstimate + imageCount * cfg.contextImageTokens + messages.length * 12 + 256;
  const inputLimit = Math.max(0, cfg.maxContextTokens - cfg.contextReserveTokens);
  return { estimatedInputTokens, imageCount, imageTokens: imageCount * cfg.contextImageTokens,
    maxContextTokens: cfg.maxContextTokens, outputReserveTokens: cfg.contextReserveTokens, inputLimit,
    fits: estimatedInputTokens <= inputLimit, approximate: true };
}

export function assertRequestContext(messages, tools, limits) {
  const check = inspectRequestContext(messages, tools, limits);
  if (!check.fits) throw Object.assign(new Error(`单次请求上下文容量不足：估算输入 ${check.estimatedInputTokens} token，可用输入 ${check.inputLimit} token（总容量 ${check.maxContextTokens}，预留输出 ${check.outputReserveTokens}）。请减少聊天窗口或调整单次容量设置。`),
    { code: 'CONTEXT_CAPACITY', runLimit: 'context_capacity', contextCheck: check });
  return check;
}

// Only a finalization request may evict old tool payloads. Keep call/result pairs,
// system rules and the initial user transcript intact; archive/log data is untouched.
export function fitFinalizationContext(messages, tools, limits) {
  const fitted = structuredClone(messages), removed = [];
  const check = () => inspectRequestContext(fitted.filter(Boolean), tools, limits);
  const before = check();
  const notice = '[容量限制：此工具的旧结果已从当前请求移除，请勿假设仍已知其内容。]';
  if (!before.fits) {
    // Budget snapshots are runtime notices, not behavior rules. Keep the latest one.
    const budgets = fitted.map((m, i) => m.role === 'system' && String(m.content).startsWith('[运行预算快照：') ? i : -1).filter(i => i >= 0);
    for (const i of budgets.slice(0, -1)) {
      if (check().fits) break;
      fitted[i] = null; removed.push({ index: i, type: 'budget_notice' });
    }
    // Nulls above must not enter the model request or token estimator.
    for (let i = fitted.length - 1; i >= 0; i--) if (fitted[i] === null) fitted.splice(i, 1);
    for (let i = 0; i < fitted.length && !check().fits; i++) {
      const m = fitted[i];
      if (m.role === 'tool' && typeof m.content === 'string' && textTokens(m.content) > textTokens(notice)) {
        fitted[i] = { ...m, content: notice };
        removed.push({ index: i, type: 'tool_result', tool: m.name, toolCallId: m.tool_call_id });
      }
      // These user messages are generated solely for tool image results.
      if (m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url') &&
        m.content.some(p => p.type === 'text' && /^\[(?:系统：以下是工具 |工具 )/.test(p.text || ''))) {
        fitted[i] = { role: 'user', content: '[容量限制：此前工具返回的图片已从当前请求移除，不能据此声称看到了图片。]' };
        removed.push({ index: i, type: 'tool_images' });
      }
    }
  }
  return { messages: fitted, before, after: check(), removed };
}
