// Timing and message counts only. No text classification or model calls.
export const DEFAULT_RESPONSE_RULES = {
  groupMode: 'rules', hotEnabled: true, silenceEnabled: true,
  windowMs: 60000, minMessages: 6, minSenders: 2, singleMessages: 5, fallbackMessages: 20,
  quietMs: 2000, maxWaitMs: 15000, silenceMs: 120000,
  cooldownMs: 20000, maxPerMinute: 2, chats: {}
};
export const RULE_LIMITS = {
  windowMs: [1000, 300000], minMessages: [2, 100], minSenders: [2, 30], singleMessages: [0, 100],
  fallbackMessages: [0, 500],
  quietMs: [0, 30000], maxWaitMs: [1000, 60000], silenceMs: [10000, 1800000],
  cooldownMs: [0, 300000], maxPerMinute: [1, 20]
};
const modes = ['rules', 'direct', 'all', 'legacy'];
function fields(value = {}, partial = false) {
  const result = partial ? {} : { ...DEFAULT_RESPONSE_RULES };
  for (const key of ['hotEnabled', 'silenceEnabled']) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const [key, [min, max]] of Object.entries(RULE_LIMITS)) {
    if (value[key] !== undefined && value[key] !== null && Number.isFinite(Number(value[key]))) {
      result[key] = Math.min(max, Math.max(min, Math.round(Number(value[key]))));
    }
  }
  return result;
}
export function normalizeResponseRules(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const result = fields(value);
  result.groupMode = modes.includes(value.groupMode) ? value.groupMode : 'rules';
  result.chats = {};
  for (const [key, entry] of Object.entries(value.chats || {})) {
    if (!/^(group|private):[1-9]\d{0,14}$/.test(key) || !entry || typeof entry !== 'object') continue;
    const c = fields(entry, true);
    if (modes.includes(entry.mode)) c.mode = entry.mode;
    // Timing-based automatic participation is always group-only.
    if (key.startsWith('private:') && c.mode === 'rules') c.mode = 'legacy';
    if (entry.sliderPos != null && Number.isFinite(Number(entry.sliderPos))) c.sliderPos = Math.max(0, Math.min(100, Number(entry.sliderPos)));
    result.chats[key] = c;
  }
  return result;
}
export function responseSettings(config, chatKey) {
  const rules = normalizeResponseRules(config.responseRules);
  const c = rules.chats[chatKey] || {};
  const { chats, ...defaults } = rules;
  return { ...defaults, ...c, mode: c.mode || (chatKey.startsWith('group:') ? rules.groupMode : 'legacy') };
}

export class ResponseActivity {
  constructor({ now = Date.now } = {}) { this.now = now; this.states = new Map(); }
  state(key) {
    if (!this.states.has(key)) this.states.set(key, { seen: 0, messages: [], unanswered: [], last: null, hotAt: null, fallbackAt: null, handled: 0, calls: [], lastCall: null, signature: null });
    return this.states.get(key);
  }
  observe(key, entries, settings) {
    const s = this.state(key), now = this.now();
    for (const m of entries) {
      if (m.id <= s.seen) continue;
      s.seen = m.id;
      if (m.self) { s.messages = []; s.unanswered = []; s.last = null; s.hotAt = null; s.fallbackAt = null; s.handled = m.id; continue; }
      if (m.command || !m.allowed) continue;
      const at = Number(m.receivedAt || m.ts);
      // Old replayed messages must not restart a silence timer.
      if (!Number.isFinite(at) || now - at > settings.silenceMs || (m.ts && now - m.ts > settings.silenceMs)) continue;
      const item = { id: m.id, senderId: m.senderId, at };
      s.messages.push(item); s.last = item;
      if (m.id > s.handled) s.unanswered.push(item);
    }
    s.messages = s.messages.filter((m) => now - m.at <= settings.windowMs && m.id > s.handled).slice(-1000);
    const senders = new Map();
    for (const m of s.messages) senders.set(m.senderId, (senders.get(m.senderId) || 0) + 1);
    const hot = settings.hotEnabled && ((s.messages.length >= settings.minMessages && senders.size >= settings.minSenders)
      || (settings.singleMessages > 0 && [...senders.values()].some((n) => n >= settings.singleMessages)));
    if (!hot) s.hotAt = null;
    else if (s.hotAt === null) s.hotAt = now;
    // Independent of the hot window and chat read cursor. Keep metadata only, bounded above the maximum threshold.
    s.unanswered = s.unanswered.slice(-1000);
    const fallback = settings.fallbackMessages > 0 && s.unanswered.length >= settings.fallbackMessages && s.last?.id > s.handled;
    if (!fallback) s.fallbackAt = null;
    else if (s.fallbackAt === null) s.fallbackAt = now;
    return s;
  }
  evaluate(key, settings) {
    const s = this.state(key), now = this.now();
    const no = (reason) => ({ shouldRespond: false, tier: 0, reason });
    if (settings.mode !== 'rules' || !key.startsWith('group:')) return no('未启用群聊规则');
    if (!s.last || s.last.id <= s.handled) return no('等待新消息');
    let reason;
    if (s.hotAt !== null && (now - s.last.at >= settings.quietMs || now - s.hotAt >= settings.maxWaitMs)) reason = '热聊参与';
    else if (s.fallbackAt !== null && (now - s.last.at >= settings.quietMs || now - s.fallbackAt >= settings.maxWaitMs)) reason = '保底参与';
    else if (settings.silenceEnabled && now - s.last.at >= settings.silenceMs) reason = '冷场接话';
    else return no(s.hotAt !== null ? '热聊聚批等待' : s.fallbackAt !== null ? '保底聚批等待' : '等待热聊或冷场');
    s.calls = s.calls.filter((at) => now - at < 60000);
    if (s.calls.length >= settings.maxPerMinute) return { ...no('自动参与额度已用完'), drop: true };
    if (s.lastCall !== null && now - s.lastCall < settings.cooldownMs) return { ...no('自动参与冷却中'), drop: true };
    return { shouldRespond: true, tier: 0, reason, automatic: true, sourceId: s.last.id,
      detail: `${s.messages.length} 条近期消息，${new Set(s.messages.map((m) => m.senderId)).size} 人；累计 ${s.unanswered.length} 条未触发消息` };
  }
  consume(key, boundary, charge = false, { preserveFallback = false } = {}) {
    const s = this.state(key);
    s.handled = Math.max(s.handled, boundary);
    s.messages = s.messages.filter((m) => m.id > boundary);
    if (!preserveFallback) s.unanswered = s.unanswered.filter((m) => m.id > boundary);
    s.hotAt = null;
    s.fallbackAt = null;
    if (charge) { s.lastCall = this.now(); s.calls.push(s.lastCall); }
  }
}
