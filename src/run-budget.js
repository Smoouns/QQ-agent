// Per-run limits. A model request and each tool execution are distinct units.
export const DEFAULT_RUN_LIMITS = {
  maxToolCalls: 12, maxSearchCalls: 3, maxPageReads: 4, maxImagePages: 4,
  maxInputTokens: 120000, maxRunMs: 180000, noProgressLimit: 3, toolResultMaxChars: 6000
};
export const RUN_LIMIT_RANGES = {
  maxToolCalls: [1, 100], maxSearchCalls: [0, 20], maxPageReads: [0, 20], maxImagePages: [0, 20],
  maxInputTokens: [1000, 2000000], maxRunMs: [10000, 1800000], noProgressLimit: [2, 10], toolResultMaxChars: [1000, 20000]
};
export function normalizeRunLimits(value = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_RUN_LIMITS).map(([k, fallback]) => {
    const n = value?.[k]; const [min, max] = RUN_LIMIT_RANGES[k];
    return [k, n != null && Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Math.floor(Number(n)))) : fallback];
  }));
}
const limitsByTool = { web_search: 'maxSearchCalls', web_fetch: 'maxPageReads', get_webpage_images: 'maxImagePages' };
export const COMPLETION_LIMITS = Object.freeze({ modelCalls: 3, toolCalls: 4 });
export const COMPLETION_TOOLS = new Set(['import_image', 'inspect_image', 'get_message_images', 'send_image', 'send_message']);
// Reserved work is deliberately narrow: finish using evidence already obtained.
export class CompletionBudget {
  constructor() { this.tools = 0; this.counts = {}; }
  admit(name) {
    if (!COMPLETION_TOOLS.has(name)) return '收尾阶段禁止继续探索或生图，请使用已有结果。';
    if (this.tools >= COMPLETION_LIMITS.toolCalls) return '收尾工具额度已用完，请直接输出最终文字。';
    if (this.counts[name]) return '本次收尾已经尝试过该工具，不再重复执行，请使用已有结果。';
    this.tools++; this.counts[name] = 1;
    return null;
  }
  snapshot() { return { toolCalls: this.tools, toolCounts: { ...this.counts }, maxToolCalls: COMPLETION_LIMITS.toolCalls }; }
}

export function budgetNotice(budget, modelAttempts, maxModelCalls, usage, completion) {
  const remaining = Math.max(0, maxModelCalls - modelAttempts);
  const tools = Math.max(0, budget.limits.maxToolCalls - budget.tools);
  const sub = Object.entries(limitsByTool).map(([name, key]) => `${name}=${Math.max(0, budget.limits[key] - (budget.counts[name] || 0))}`).join('，');
  return `[运行预算快照：提交当前请求前] 常规模型请求剩余 ${remaining}/${maxModelCalls} 次（包含当前请求，网络重试也扣次）；常规工具剩余 ${tools}/${budget.limits.maxToolCalls} 次；${sub}。累计已报告输入 ${usage?.promptTokens || 0}/${budget.limits.maxInputTokens} token；剩余时间约 ${Math.max(0, Math.ceil((budget.limits.maxRunMs - (budget.now() - budget.startedAt)) / 1000))} 秒；连续无进展 ${budget.noProgress}/${budget.limits.noProgressLimit}。${remaining <= 2 || tools <= 2 ? '额度较低，请停止扩展检索，优先确认并交付已有结果。' : '请预留看图和发送所需步骤，结果足够时立即回复。'} ${modelAttempts === 0 ? `任一总上限触发即停止探索；已有图片可用独立收尾额度导入、查看和发送（最多 ${COMPLETION_LIMITS.modelCalls} 次模型请求、剩余 ${COMPLETION_LIMITS.toolCalls - completion.tools} 次工具，各工具最多一次），仍未回复再保留一次纯文字请求。收尾不开放搜索、网页读取、生图或 MCP。不要把预算信息发给群友。` : ""}`;
}
function fingerprint(name, raw) {
  try {
    const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (name === 'web_search') return name + ':' + String(args.query || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const url = new URL(args.url); url.hash = '';
    return name + ':' + url.href;
  } catch { return name + ':' + String(raw); }
}
export class RunBudget {
  constructor(limits, now = Date.now) {
    this.limits = normalizeRunLimits(limits); this.now = now; this.startedAt = now();
    this.tools = 0; this.counts = {}; this.seenRequests = new Set(); this.seenResults = new Set(); this.noProgress = 0;
  }
  stopReason(usage) {
    if (this.tools >= this.limits.maxToolCalls) return 'tool_budget';
    if ((usage?.promptTokens || 0) >= this.limits.maxInputTokens) return 'input_budget';
    if (this.now() - this.startedAt >= this.limits.maxRunMs) return 'time_budget';
    if (this.noProgress >= this.limits.noProgressLimit) return 'no_progress';
    return null;
  }
  admit(name, raw) {
    if (this.tools >= this.limits.maxToolCalls) return '工具总预算已用完，请根据已有结果结束并回复。';
    const key = limitsByTool[name];
    if (key && (this.counts[name] || 0) >= this.limits[key]) { this.noProgress++; return `${name} 的预算已用完，请利用已有结果或其他仍可用的工具，不要重复请求。`; }
    if (key) {
      const fp = fingerprint(name, raw);
      if (this.seenRequests.has(fp)) { this.noProgress++; return '本轮已请求过相同检索或网页，之前结果仍在上下文中；请使用已有结果，不要重复调用。'; }
      this.seenRequests.add(fp);
    }
    this.tools++; this.counts[name] = (this.counts[name] || 0) + 1;
    return null;
  }
  observe(name, result, text) {
    if (!limitsByTool[name]) { this.noProgress = result.isError ? this.noProgress + 1 : 0; return; }
    let keys = [];
    try {
      const data = JSON.parse(text);
      if (name === 'web_search') keys = (data.results || []).map(r => 'url:' + r.url);
      else if (name === 'get_webpage_images') keys = (data.images || []).map(r => 'image:' + r.url);
      else if (data.content?.trim()) keys = ['body:' + data.content];
    } catch { /* Invalid/error results do not count as progress. */ }
    const progress = !result.isError && keys.some(k => !this.seenResults.has(k));
    keys.forEach(k => this.seenResults.add(k));
    this.noProgress = progress ? 0 : this.noProgress + 1;
  }
  snapshot() { return { limits: this.limits, toolCalls: this.tools, toolCounts: { ...this.counts }, noProgress: this.noProgress }; }
}

export function boundedToolText(text, max) {
  if (text.length <= max) return text;
  try {
    const data = JSON.parse(text);
    if (data && !Array.isArray(data) && typeof data === 'object') {
      data.truncated = true;
      // Remove whole candidates instead of turning half a URL into a fake link.
      for (const key of ['images', 'results']) if (Array.isArray(data[key])) {
        while (data[key].length && JSON.stringify(data).length > max) data[key].pop();
      }
      for (const key of ['content', 'summary', 'note']) if (typeof data[key] === 'string' && JSON.stringify(data).length > max) {
        const excess = JSON.stringify(data).length - max;
        data[key] = data[key].slice(0, Math.max(0, data[key].length - excess - 30));
      }
      const compact = JSON.stringify(data);
      if (compact.length <= max) return compact;
    }
  } catch { /* Generic tools may return plain text. */ }
  const notice = '\n[工具结果已截断；仅有以上内容可供本轮使用]';
  return text.slice(0, Math.max(0, max - notice.length)) + notice.slice(0, max);
}
