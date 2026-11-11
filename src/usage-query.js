import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { addUsage, emptyUsage, cacheCoverage } from './llm.js';
import { searchUsageCalls } from './search-usage.js';
import { modelLabel, resolveModelPrice, priceAt } from './model-prices.js';

const DAY = 86400000;
const number = (v) => Math.max(0, Number(v) || 0);

// Explicit offsets for timestamps; bare dates mean calendar days in China.
function parseTime(value, end) {
  if (typeof value !== 'string') throw new Error('时间须为 YYYY-MM-DD 或带时区的 ISO 时间');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('时间须为 YYYY-MM-DD 或带时区的 ISO 时间，例如 2026-11-06T12:00:00+08:00');
  }
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) throw new Error('日期不存在');
  if (!dateOnly && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59)) throw new Error('时间无效');
  const at = Date.parse(dateOnly ? `${value}T00:00:00+08:00` : value);
  if (!Number.isFinite(at)) throw new Error('时间无效');
  return at + (dateOnly && end ? DAY - 1 : 0);
}

export function usageRange(args = {}, now = Date.now()) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !['start', 'end'].includes(key))) {
    throw new Error('只支持 start 和 end 时间参数；统计范围固定为所有会话');
  }
  const end = args.end === undefined ? now : parseTime(args.end, true);
  const start = args.start === undefined ? end - 7 * DAY : parseTime(args.start, false);
  if (start > end) throw new Error('开始时间不能晚于结束时间');
  return { start, end };
}

/** Shared with the usage dashboard: expand responses, never also sum session totals. */
export function sessionUsageRows(session) {
  const started = number(session.startedAt);
  const common = { vendor: String(session.vendor || ''), sessionId: session.id, chatKey: session.chatKey };
  const chat = [];
  for (const m of session.messages || []) {
    const raw = m?.raw;
    if (m.role !== 'assistant' || !raw || typeof raw !== 'object') continue;
    const usage = addUsage(emptyUsage(), raw.usage); usage.calls = 1;
    chat.push({ ...common, ...usage, model: String(raw.model || session.model || '(未知)'),
      at: number(raw.created) * 1000 || started, timeEstimated: !number(raw.created),
      phase: m.requestPhase === 'finalization' ? 'finalization' : chat.length ? 'continuation' : 'first',
      usageReported: !!raw.usage, exact: true });
  }
  if (!chat.length && (session.usage?.calls || session.usage?.promptTokens || session.usage?.completionTokens)) {
    const u = session.usage;
    chat.push({ ...common, ...u, ...cacheCoverage(u), calls: Math.max(1, number(u.calls)),
      cacheUnreportedCalls: u.cacheUnreportedCalls ?? (u.cacheReportedCalls == null ? Math.max(1, number(u.calls)) : 0),
      totalTokens: number(u.totalTokens) || number(u.promptTokens) + number(u.completionTokens),
      model: String(session.model || '(未知)'), at: started, timeEstimated: true,
      phase: 'unknown', usageReported: true, exact: false });
  }
  const search = searchUsageCalls(session).map((c) => ({ ...common, ...c.usage, calls: 1,
    at: c.at || started, timeEstimated: !!c.legacy || !c.at, model: c.model || '(未知)',
    vendor: c.provider || '(未知)', usageReported: c.usageReported, exact: true }));
  return { chat, search };
}

export function usagePrice(model, vendor, cfg = getConfig()) {
  if (vendor) {
    const price = resolveModelPrice(modelLabel(vendor, model), cfg);
    if (price.source === 'custom') return price;
  }
  return resolveModelPrice(model, cfg);
}

function summarize(rows, cfg) {
  const out = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
    estimatedCostCny: 0, unreportedUsageCalls: 0, unpricedCalls: 0, cacheUnreportedCalls: 0, timeEstimatedCalls: 0 };
  for (const row of rows) {
    const calls = Math.max(1, number(row.calls));
    const input = number(row.promptTokens), output = number(row.completionTokens), cached = Math.min(input, number(row.cachedTokens));
    out.calls += calls; out.inputTokens += input; out.outputTokens += output; out.cachedInputTokens += cached;
    out.totalTokens += number(row.totalTokens) || input + output;
    out.cacheUnreportedCalls += number(row.cacheUnreportedCalls);
    if (row.timeEstimated) out.timeEstimatedCalls += calls;
    if (!row.usageReported) { out.unreportedUsageCalls += calls; continue; }
    const price = usagePrice(row.model, row.vendor, cfg);
    if (['none', 'unmatched'].includes(price.source)) { out.unpricedCalls += calls; continue; }
    const tier = price.peak ? priceAt(price, row.at) : price;
    out.estimatedCostCny += ((input - cached) * tier.in + cached * tier.cached + output * tier.out) / 1e6;
  }
  out.estimatedCostCny = Math.round(out.estimatedCostCny * 1e8) / 1e8;
  return out;
}

export function queryUsage(ctx, args = {}, { now = Date.now(), directory = path.join(DATA_DIR, 'sessions'), cfg = getConfig() } = {}) {
  const range = usageRange(args, now);
  const inside = (at) => at >= range.start && at <= range.end;
  const rows = { chat: [], search: [], memory: [] };
  const notes = ['费用按当前配置单价估算（人民币），不是订阅账单或实际扣费；不含生图接口和非 token 服务费用。',
    '仅统计仍保留的本地记录及已返回的用量，不含本次查询之后的回复和进行中的请求。'];
  let unreadableArchives = 0, legacySearchSessions = 0;
  const active = new Map(ctx.sessions?.current || []);
  if (ctx.session?.id) active.set(ctx.session.id, ctx.session);
  const add = (s) => {
    if (!s || typeof s !== 'object' || !Number.isFinite(s.startedAt) || (s.messages !== undefined && !Array.isArray(s.messages))) { unreadableArchives++; return; }
    const expanded = sessionUsageRows(s);
    for (const kind of ['chat', 'search']) rows[kind].push(...expanded[kind].filter((r) => inside(r.at)));
    if (inside(s.startedAt) && !Array.isArray(s.searchUsageCalls) && s.webSearchCount > 0) legacySearchSessions++;
  };
  let files;
  try { files = fs.readdirSync(directory).filter((f) => f.endsWith('.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取用量存档'); files = []; }
  // Active snapshots override stale disk copies; each archive is read just once.
  for (const file of files) {
    if (active.has(file.slice(0, -5))) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')); }
    catch { unreadableArchives++; continue; }
    if (!active.has(s?.id)) add(s);
  }
  for (const s of active.values()) add(s);
  const ledger = ctx.memory?.usageLedger?.();
  if (ledger) rows.memory = ledger.calls.filter((c) => inside(c.at)).map((c) => ({ ...c.usage, ...c, calls: 1 }));
  else notes.push('记忆用量账本不可用，记忆消耗未计入。');
  if (ledger?.untrackedCalls) notes.push(`另有 ${ledger.untrackedCalls} 次旧记忆调用（${ledger.untrackedTokens} token）没有时间记录，无法归入所选时段，未计入。`);
  if (legacySearchSessions) notes.push(`${legacySearchSessions} 个旧运行缺少完整搜索用量账本，仅计入可恢复的数据。`);
  if (unreadableArchives) notes.push(`${unreadableArchives} 个存档无法读取，未计入。`);
  const all = Object.values(rows).flat();
  const total = summarize(all, cfg);
  if (total.unreportedUsageCalls) notes.push('部分调用未返回 usage，token 和费用仅为已知部分，不能视为零消耗。');
  if (total.unpricedCalls) notes.push('部分调用缺少单价，estimatedCostCny 仅为可计价部分，不能视为全部费用。');
  if (total.cacheUnreportedCalls) notes.push('部分调用未报告缓存命中，费用按未缓存输入估算。');
  if (total.timeEstimatedCalls) notes.push('部分旧调用缺少独立时间，按所在运行的开始时间归入时段。');
  return { scope: 'all_chats', start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString(),
    total, breakdown: Object.fromEntries(Object.entries(rows).map(([kind, list]) => [kind, summarize(list, cfg)])), notes };
}

export function createUsageQueryTool() {
  return {
    name: 'usage_query',
    description: '查询机器人所有群聊和私聊合计的 token 消耗与人民币估算费用，分别列出聊天、搜索、记忆整理。默认最近 7 天，可指定 start/end。日期按北京时间，结束日期含当天；时间戳须带时区。仅返回汇总，不含其他会话内容。缺失用量/价格请如实说明；估算费用不是订阅实际扣费。',
    parameters: { type: 'object', properties: {
      start: { type: 'string', description: '开始日期 YYYY-MM-DD 或带时区的 ISO 时间；省略则从 end 往前 7 天' },
      end: { type: 'string', description: '结束日期 YYYY-MM-DD（含当天）或带时区的 ISO 时间；省略则为当前时间' }
    }, additionalProperties: false },
    async execute(ctx, args) { return { content: JSON.stringify(queryUsage(ctx, args)) }; }
  };
}
