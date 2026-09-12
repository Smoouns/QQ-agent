// Read-only context selection. Archive retention and model context are independent.
import { getConfig } from './config.js';
import { memoryVisible, memoryEvidenceIssue } from './memory.js';

export function blockedIds(chatKey) {
  const [kind, id] = chatKey.split(':');
  return new Set(kind === 'group' ? (getConfig().blocklist?.[id] || []).map(String) : []);
}
export function messageAllowed(m, chatKey) {
  const blocked = blockedIds(chatKey);
  return (m.self || !blocked.has(String(m.senderId))) && !blocked.has(String(m.reply?.senderId || ''));
}
export function recordAllowed(r, chatKey, { historical = false } = {}) {
  if (!r || !memoryVisible(r, chatKey) || r.status === 'deleted') return false;
  if (memoryEvidenceIssue(r)) return false;
  if (!historical && (['superseded', 'expired'].includes(r.status) || (r.expiresAt && r.expiresAt <= Date.now()))) return false;
  const blocked = blockedIds(chatKey);
  return !r.subjectIds.some((id) => blocked.has(id.replace(/^qq:/, ''))) &&
    !(r.sources || []).some((s) => blocked.has(String(s.senderId)));
}
export function historyCount(chatKey) {
  const c = getConfig().store || {};
  const n = Number(c.chatHistoryCounts?.[chatKey] ?? c.historyCount ?? 80);
  return Number.isFinite(n) ? Math.max(0, Math.min(500, Math.floor(n))) : 80;
}

export function selectWindow(store, chatKey, triggerEntries, { boundary = store.boundary(chatKey), limit = historyCount(chatKey) } = {}) {
  const trigger = structuredClone(triggerEntries.filter((m) => m.id <= boundary && messageAllowed(m, chatKey)));
  const before = trigger.length ? Math.min(...trigger.map((m) => m.id)) : boundary + 1;
  const history = store.before(chatKey, before, { limit, accept: (m) => messageAllowed(m, chatKey) });
  const triggerIds = new Set(trigger.map((m) => m.id));
  // The previous run may have spoken between arrivals in this unread batch.
  const interleaved = store.before(chatKey, boundary + 1, { limit: Infinity,
    accept: (m) => m.id >= before && !triggerIds.has(m.id) && messageAllowed(m, chatKey) });
  const seen = new Set([...history, ...trigger, ...interleaved].map((m) => m.id));
  const quotes = [];
  for (const m of [...history, ...trigger, ...interleaved]) {
    if (m.reply?.mid == null) continue;
    const ref = store.findByMid(chatKey, m.reply.mid);
    if (ref && ref.id <= boundary && !seen.has(ref.id) && messageAllowed(ref, chatKey)) {
      quotes.push(structuredClone(ref)); seen.add(ref.id);
    }
  }
  quotes.sort((a, b) => a.id - b.id);
  return { boundary, createdAt: Date.now(), limit, trigger, history, interleaved, quotes, blocklist: JSON.stringify([...blockedIds(chatKey)].sort()), beforeLocalId: history[0]?.id ?? before };
}

const stop = new Set(['什么', '怎么', '这个', '那个', '我们', '你们', '他们', '一下', '一下子', '可以', '是不是', '有没有', '记得', '之前', '以前', '原来', '当时', '后来']);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function terms(text) {
  const segments = [...segmenter.segment(String(text).toLowerCase())];
  const words = segments.filter((s) => s.isWordLike).map((s) => s.segment);
  // ICU sometimes splits QQ vocabulary such as 联机 into two single characters.
  for (let i = 1; i < segments.length; i++) {
    if (/^\p{Script=Han}$/u.test(segments[i - 1].segment) && /^\p{Script=Han}$/u.test(segments[i].segment)) {
      words.push(segments[i - 1].segment + segments[i].segment);
    }
  }
  return [...new Set(words.filter((s) => s.length > 1 && !stop.has(s) && !/^\d+$/.test(s)))];
}
function relevance(r, queryTerms) {
  const text = `${r.title} ${r.content}`.toLowerCase();
  return queryTerms.filter((t) => text.includes(t)).length;
}
export function primarySubjects(messages, store, chatKey) {
  const ids = new Set();
  for (const m of messages) {
    if (!m.self && /^\d+$/.test(m.senderId)) ids.add(`qq:${m.senderId}`);
    for (const id of m.mentions || []) if (/^\d+$/.test(id)) ids.add(`qq:${id}`);
    for (const match of String(m.text).matchAll(/(?:\[CQ:at,qq=|@)(\d+)/g)) ids.add(`qq:${match[1]}`);
    const quoted = m.reply?.mid == null ? null : store?.findByMid(chatKey, m.reply.mid);
    const id = m.reply?.senderId || quoted?.senderId;
    if (/^\d+$/.test(id)) ids.add(`qq:${id}`);
  }
  return [...ids];
}

/** Two small routes, no model calls. Never fill a quota with unrelated records. */
export function recallMemories(memory, chatKey, { query = '', secondary = '', subjectIds = [], limit = 8, personLimit = 3, topicLimit = 5 } = {}) {
  const primary = terms(query), background = terms(secondary);
  const subjects = new Set(subjectIds);
  const candidates = memory.listRecords({ chatKey }).filter((r) => recordAllowed(r, chatKey)).map((record) => {
    const direct = relevance(record, primary), recent = relevance(record, background);
    const person = record.subjectIds.some((id) => subjects.has(id));
    const topic = direct > 0 || (recent > 0 && (person || primary.length === 0));
    const profile = person && ['fact', 'preference', 'interaction', 'relationship'].includes(record.kind) &&
      (topic || record.kind === 'interaction' || /称呼|叫我|名字|昵称/.test(record.content));
    const score = direct * 100 + Math.min(recent, 4) * 10 + (person ? 5 : 0) +
      (topic && ['pending', 'in_progress'].includes(record.status) ? 2 : 0) + (record.pinned ? 1 : 0);
    return { record, profile, topic, score, reason: [direct ? '新消息词项' : '', recent ? '近期话题' : '', person ? '当前人物' : '', profile && !topic ? '称呼或相处习惯' : ''].filter(Boolean).join('、') };
  }).sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt || a.record.id.localeCompare(b.record.id));
  const picked = [], seen = new Set(), contents = new Set();
  const add = (rows, cap) => {
    let n = 0;
    for (const row of rows) {
      const key = `${[...row.record.subjectIds].sort().join(',')}|${row.record.content.trim()}`;
      if (seen.has(row.record.id) || contents.has(key)) continue;
      if (n >= cap || picked.length >= limit) break;
      picked.push(row); seen.add(row.record.id); contents.add(key); n++;
    }
  };
  add(candidates.filter((c) => c.profile), personLimit);
  add(candidates.filter((c) => c.topic), topicLimit);
  return picked;
}

export function memoryText(selected) {
  const labels = { explicit: '本人明确表达', reported: '他人转述', inferred: '推测，待核实', legacy: '旧印象，缺少原始证据', admin: '管理员确认' };
  return selected.map(({ record: r }) => `- [${r.id} v${r.version} | ${r.kind} | ${r.status} | ${labels[r.evidence]}] 主体=${r.subjectIds.join(',')}；${r.title ? `${r.title}：` : ''}${r.content}`).join('\n');
}

export function rememberAccess(session, records) {
  session.memoryAccess ||= [];
  for (const r of records) if (!session.memoryAccess.some((x) => x.id === r.id && x.version === r.version)) {
    session.memoryAccess.push({ id: r.id, version: r.version });
  }
}
export function assertContextAllowed(session, memory, chatKey) {
  if (!session.contextSelection) return;
  const fingerprint = JSON.stringify([...blockedIds(chatKey)].sort());
  if (fingerprint !== session.contextSelection.blocklist) throw new Error('上下文可见范围已改变，本次运行停止，请重新唤醒');
  for (const ref of session.memoryAccess || []) {
    const current = memory.getRecord(ref.id);
    if (!recordAllowed(current, chatKey)) throw new Error('已使用的记忆被删除、失效或收紧范围，本次运行停止');
    const used = current.version === ref.version ? current : current.history.find((r) => r.version === ref.version);
    if (!recordAllowed(used, chatKey, { historical: true })) throw new Error('已使用的历史记忆不再可见，本次运行停止');
  }
}
