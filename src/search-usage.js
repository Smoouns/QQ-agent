import { addUsage, emptyUsage, CACHE_COUNTERS } from './llm.js';

// New records have a dedicated ledger, including terminal responses rejected for
// missing citations. Legacy previews may be truncated: never invent missing usage.
export function searchUsageCalls(session) {
  if (Array.isArray(session.searchUsageCalls)) return session.searchUsageCalls;
  const rows = [];
  for (const m of session.messages || []) {
    if (m.toolCall?.name !== 'web_search' || m.toolCall.blocked) continue;
    try {
      const result = JSON.parse(m.toolCall.result);
      if (!result.usage) continue;
      const usage = addUsage(emptyUsage(), result.usage); usage.calls = 1;
      rows.push({ at: session.startedAt, model: '(旧记录未保存搜索模型)', provider: result.provider || '(未知)', usage, usageReported: true, legacy: true });
    } catch { /* Preview omitted/truncated; coverage is exposed separately. */ }
  }
  return rows;
}
export function sumSearchUsage(rows) {
  const out = { ...emptyUsage(), unreportedCalls: 0 };
  for (const row of rows) {
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'calls', ...CACHE_COUNTERS]) out[key] += Number(row.usage?.[key]) || 0;
    if (!row.usageReported) out.unreportedCalls++;
  }
  return out;
}
