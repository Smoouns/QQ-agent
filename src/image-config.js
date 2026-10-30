export const DEFAULT_IMAGE_GENERATION = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:10100/v1',
  apiKey: '',
  model: '', // 留空由 OpenCodex 上游选择，不能填聊天模型 gpt-6-luna。
  size: '1024x1024',
  quality: 'low',
  timeoutMs: 300000,
  dailyLimit: 5,
  chatDailyLimits: {}
};

export function imageEndpoint(baseUrl, operation = 'generations') {
  if (!['generations', 'edits'].includes(operation)) throw new Error('图片操作无效');
  let url;
  try { url = new URL(String(baseUrl).trim()); } catch { throw new Error('生图接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('生图接口须为不含凭据、查询参数或片段的 HTTP(S) 地址');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = url.pathname.replace(/\/images\/(generations|edits)$/, '');
  url.pathname += `/images/${operation}`;
  return url.href;
}

export function assertImageChat(chatKey) {
  if (!/^(group|private):[1-9]\d{0,19}$/.test(chatKey)) throw new Error('图片工具的会话标识无效');
}

export function normalizeImageConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('生图设置必须是对象');
  const c = { ...DEFAULT_IMAGE_GENERATION, ...value };
  if (typeof c.enabled !== 'boolean') throw new Error('生图开关必须为布尔值');
  for (const key of ['baseUrl', 'apiKey', 'model']) {
    if (typeof c[key] !== 'string' || c[key].length > 4096) throw new Error(`生图 ${key} 无效`);
    c[key] = c[key].trim();
  }
  imageEndpoint(c.baseUrl);
  if (!['auto', '1024x1024', '1536x1024', '1024x1536'].includes(c.size)) throw new Error('生图尺寸无效');
  if (!['auto', 'low', 'medium', 'high'].includes(c.quality)) throw new Error('生图质量无效');
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 600000) throw new Error('生图超时须为 1000–600000 毫秒');
  const limit = (n) => Number.isInteger(n) && n >= 0 && n <= 1000;
  if (!limit(c.dailyLimit)) throw new Error('每日生图次数须为 0–1000 的整数');
  if (!c.chatDailyLimits || typeof c.chatDailyLimits !== 'object' || Array.isArray(c.chatDailyLimits)) throw new Error('会话生图预算必须是对象');
  const overrides = {};
  for (const [key, n] of Object.entries(c.chatDailyLimits)) {
    assertImageChat(key);
    if (!limit(n)) throw new Error('会话生图次数须为 0–1000 的整数');
    overrides[key] = n;
  }
  return Object.fromEntries(Object.keys(DEFAULT_IMAGE_GENERATION).map((key) => [key, key === 'chatDailyLimits' ? overrides : c[key]]));
}
