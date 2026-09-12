// One QQ identity; scoped, versioned records. A snapshot and its extraction
// cursor commit together via atomic rename, using the existing Node runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig, updateConfig } from './config.js';

export const MEMORY_KINDS = ['fact', 'preference', 'interaction', 'relationship', 'event', 'commitment'];
export const MEMORY_STATUSES = ['active', 'pending', 'in_progress', 'completed', 'cancelled', 'superseded', 'expired', 'deleted'];
const CHAT = /^(group|private):\d+$/;
const clone = (v) => structuredClone(v);
const unique = (a) => [...new Set(a)];
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 24);
const subject = (v) => {
  const s = String(v ?? '').trim();
  if (s === 'bot' || /^legacy:[a-f0-9]+$/.test(s)) return s;
  if (/^(qq:)?\d{1,15}$/.test(s)) return s.startsWith('qq:') ? s : `qq:${s}`;
  throw new Error('人物必须使用数字 QQ 号');
};
function contentText(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000) throw new Error('内容须为 1–2000 字的文本');
  return v.trim();
}
function visibility(v) {
  if (v?.type === 'global') return { type: 'global', chatKeys: [] };
  if (v?.type !== 'chats' || !Array.isArray(v.chatKeys) || !v.chatKeys.length || v.chatKeys.length > 50 || v.chatKeys.some((k) => !CHAT.test(k))) throw new Error('可见范围必须是全局或指定会话');
  return { type: 'chats', chatKeys: unique(v.chatKeys).sort() };
}
export const memoryVisible = (r, chatKey) => r.visibility.type === 'global' || r.visibility.chatKeys.includes(chatKey);
const effective = (r) => !['deleted', 'superseded', 'expired'].includes(r.status) && (!r.expiresAt || r.expiresAt > Date.now());
const sameSubjects = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const localTo = (r, k) => r.visibility.type === 'chats' && r.visibility.chatKeys.length === 1 && r.visibility.chatKeys[0] === k;

export class MemoryStore {
  constructor(directory = path.join(DATA_DIR, 'memory')) {
    this.directory = directory;
    this.file = path.join(directory, 'v2.json');
    this.state = null;
  }
  #load() {
    if (this.state) return;
    if (fs.existsSync(this.file)) {
      // Corruption must not silently reset memories or extraction progress.
      const db = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      if (db.schemaVersion !== 2 || !db.records || !db.persons || !db.jobs) throw new Error('记忆数据库格式错误，请从备份恢复');
      this.state = db;
      return;
    }
    const db = { schemaVersion: 2, revision: 0, persons: {}, records: {}, jobs: {}, migrations: [] };
    this.#importLegacy(db);
    this.#save(db);
  }
  #save(db) {
    fs.mkdirSync(this.directory, { recursive: true });
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, this.file);
    this.state = db;
  }
  #transaction(fn) {
    this.#load();
    const db = clone(this.state);
    const result = fn(db);
    db.revision++;
    this.#save(db);
    return clone(result);
  }
  #person(db, id, name = '', chatKey = '') {
    const now = Date.now();
    const p = db.persons[id] ||= { id, userId: id.startsWith('qq:') ? id.slice(3) : '', name: '', aliases: [], createdAt: now, updatedAt: now };
    if (name && !p.aliases.some((a) => a.name === name && a.chatKey === chatKey)) {
      p.aliases.push({ name: String(name).slice(0, 60), chatKey, observedAt: now });
      p.name ||= String(name).slice(0, 60);
      p.updatedAt = now;
    }
    return p;
  }
  #importLegacy(db) {
    if (!fs.existsSync(this.directory)) return;
    const files = [];
    for (const e of fs.readdirSync(this.directory, { withFileTypes: true })) {
      const m = /^(group|private)_(\d+)(\.json)?$/.exec(e.name);
      if (!m) continue;
      const chatKey = `${m[1]}:${m[2]}`;
      if (e.isFile() && m[3]) files.push({ relative: e.name, chatKey, flat: true });
      if (e.isDirectory() && !m[3]) for (const f of fs.readdirSync(path.join(this.directory, e.name))) {
        if (f.endsWith('.json')) files.push({ relative: path.join(e.name, f), chatKey, flat: false });
      }
    }
    // Read/validate all sources first. Preserve originals and a separate backup.
    const sources = files.map((f) => ({ ...f, raw: JSON.parse(fs.readFileSync(path.join(this.directory, f.relative), 'utf8').replace(/^\uFEFF/, '')) }));
    const backup = path.join(this.directory, 'backups', `before-v2-${Date.now()}-${crypto.randomUUID()}`);
    for (const f of sources) {
      const dest = path.join(backup, f.relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(this.directory, f.relative), dest);
      const entries = f.flat ? (f.raw.memberImpression || []) : (f.raw.impressions || []);
      if (!Array.isArray(entries)) throw new Error(`旧记忆格式错误：${f.relative}`);
      for (const [index, e] of entries.entries()) {
        if (!e?.content) continue;
        const uid = String(f.flat ? (e.userId || (/^\d+$/.test(e.target) ? e.target : '')) : (f.raw.userId || ''));
        const name = String(f.flat ? e.target || uid : f.raw.name || uid);
        const sid = /^\d{1,15}$/.test(uid) ? subject(uid) : `legacy:${hash(`${f.chatKey}/${f.relative}/${name}`)}`;
        this.#person(db, sid, name, f.chatKey);
        const id = `m_${hash(`${f.relative}/${index}`)}`;
        db.records[id] = {
          id, kind: 'fact', content: String(e.content), subjectIds: [sid], title: '', eventId: null,
          visibility: { type: 'chats', chatKeys: [f.chatKey] }, evidence: 'legacy', sources: [],
          legacySource: { file: f.relative, index, name, chatKey: f.chatKey }, status: 'active', pinned: false,
          createdAt: Number(e.createdAt) || Date.now(), updatedAt: Number(f.raw.updatedAt) || Number(e.createdAt) || Date.now(),
          expiresAt: null, version: 1, history: []
        };
      }
      db.migrations.push({ file: f.relative, backup: path.relative(this.directory, dest), at: Date.now() });
    }
  }
  listRecords({ chatKey = '', personId = '', kind = '', includeInactive = false } = {}) {
    this.#load();
    const sid = personId ? subject(personId) : '';
    return clone(Object.values(this.state.records).filter((r) =>
      (!chatKey || memoryVisible(r, chatKey)) && (!sid || r.subjectIds.includes(sid)) && (!kind || r.kind === kind) &&
      (includeInactive || effective(r))).sort((a, b) => b.updatedAt - a.updatedAt));
  }
  getRecord(id) { this.#load(); return clone(this.state.records[id] || null); }
  listPersons() {
    this.#load();
    return clone(Object.values(this.state.persons).map((p) => ({ ...p,
      recordCount: Object.values(this.state.records).filter((r) => effective(r) && r.subjectIds.includes(p.id)).length
    })).sort((a, b) => b.updatedAt - a.updatedAt));
  }
  getPerson(id) {
    const sid = subject(id), p = this.listPersons().find((x) => x.id === sid);
    if (!p) return null;
    // Admin-only profile view. Prompt selection remains in formatForPrompt.
    return { ...p, profile: this.listRecords({ personId: sid }).filter((r) => ['fact', 'preference', 'interaction'].includes(r.kind) && ['explicit', 'admin'].includes(r.evidence)) };
  }
  listChats() {
    this.#load();
    return unique([...Object.keys(this.state.jobs), ...Object.values(this.state.persons).flatMap((p) => p.aliases.map((a) => a.chatKey)),
      ...Object.values(this.state.records).flatMap((r) => [...r.visibility.chatKeys, ...r.sources.map((s) => s.chatKey), r.legacySource?.chatKey])].filter((k) => CHAT.test(k)));
  }
  #put(db, input, { actor = 'admin', expectedVersion } = {}) {
    const old = input.id ? db.records[input.id] : null;
    if (input.id && !old) throw new Error('记忆不存在');
    if (old && expectedVersion !== old.version) throw new Error('记忆已变化，请刷新后重试');
    if (old?.pinned && actor !== 'admin') throw new Error('固定记忆只能由管理员修改');
    if (old?.status === 'deleted') throw new Error('已删除记忆不能更新');
    const r = { ...old, ...input };
    if (!MEMORY_KINDS.includes(r.kind)) throw new Error('未知记忆类型');
    r.content = contentText(r.content);
    if (!Array.isArray(r.subjectIds) || !r.subjectIds.length || r.subjectIds.length > 30) throw new Error('须指定 1–30 个主体');
    r.subjectIds = unique(r.subjectIds.map(subject));
    if (r.subjectIds.some((id) => id.startsWith('legacy:') && !db.persons[id])) throw new Error('未知历史人物');
    r.visibility = visibility(r.visibility);
    r.status ||= 'active';
    if (!MEMORY_STATUSES.includes(r.status)) throw new Error('未知记忆状态');
    r.evidence ||= actor === 'admin' ? 'admin' : 'inferred';
    if (!['explicit', 'reported', 'inferred', 'admin', 'legacy'].includes(r.evidence)) throw new Error('未知证据类型');
    r.title = String(r.title || '').slice(0, 120);
    r.eventId ||= null;
    if (r.eventId && r.eventId !== old?.eventId && (!db.records[r.eventId] || r.eventId === r.id || !['event', 'commitment'].includes(db.records[r.eventId].kind) || !effective(db.records[r.eventId]))) throw new Error('关联事件不存在或已失效');
    r.expiresAt = r.expiresAt == null || r.expiresAt === '' ? null : Number(r.expiresAt);
    if (r.expiresAt !== null && (!Number.isFinite(r.expiresAt) || r.expiresAt <= 0)) throw new Error('过期时间格式错误');
    r.pinned = actor === 'admin' ? !!r.pinned : !!old?.pinned;
    r.sources = old?.sources || [];
    if (input._sources) r.sources = [...r.sources, ...input._sources.filter((s) => !r.sources.some((o) => o.chatKey === s.chatKey && o.messageId === s.messageId))];
    delete r._sources;
    r.id = old?.id || `m_${crypto.randomUUID()}`;
    r.createdAt = old?.createdAt || Date.now(); r.updatedAt = Date.now(); r.version = (old?.version || 0) + 1;
    r.history = old ? [...old.history, { ...old, history: undefined, changedBy: actor, changedAt: r.updatedAt }] : [];
    for (const sid of r.subjectIds) this.#person(db, sid);
    db.records[r.id] = r;
    return r;
  }
  saveRecord(input, { expectedVersion, actor = 'admin' } = {}) {
    const fields = ['id', 'kind', 'content', 'subjectIds', 'visibility', 'status', 'title', 'eventId', 'expiresAt', 'pinned'];
    const value = Object.fromEntries(fields.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
    if (actor === 'admin') value.evidence = 'admin';
    return this.#transaction((db) => this.#put(db, value, { expectedVersion, actor }));
  }
  deleteRecord(id, expectedVersion) { return this.saveRecord({ id, status: 'deleted' }, { expectedVersion }); }
  job(chatKey) { this.#load(); return clone(this.state.jobs[chatKey] || { cursor: 0, lastSuccessAt: 0, lastError: '', failures: 0 }); }
  recordFailure(chatKey, error) {
    return this.#transaction((db) => db.jobs[chatKey] = { ...this.job(chatKey), lastError: String(error).slice(0, 500), failures: (db.jobs[chatKey]?.failures || 0) + 1 });
  }
  recordUsage(chatKey, usage) {
    return this.#transaction((db) => {
      const job = this.job(chatKey), previous = job.usage || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const number = (v) => Math.max(0, Number(v) || 0);
      const prompt = number(usage?.prompt_tokens), completion = number(usage?.completion_tokens);
      job.usage = { calls: previous.calls + 1, promptTokens: previous.promptTokens + prompt,
        completionTokens: previous.completionTokens + completion, totalTokens: previous.totalTokens + number(usage?.total_tokens || prompt + completion) };
      db.jobs[chatKey] = job; return job.usage;
    });
  }
  commitExtraction(chatKey, messages, candidates, { cursor, advance = true, knownIds = [] } = {}) {
    if (!CHAT.test(chatKey) || !Array.isArray(candidates) || candidates.length > 40) throw new Error('抽取结果格式错误');
    return this.#transaction((db) => {
      const prior = this.job(chatKey);
      if (advance && prior.cursor !== cursor) throw new Error('抽取游标已变化，请重试');
      const messageMap = new Map(messages.map((m) => [Number(m.id), m]));
      const allowed = new Set([...knownIds.map(subject), ...messages.filter((m) => /^\d{1,15}$/.test(m.senderId)).map((m) => subject(m.senderId)), 'bot']);
      for (const m of messages) if (!m.self && /^\d{1,15}$/.test(m.senderId)) this.#person(db, subject(m.senderId), m.senderName, chatKey);
      const changed = [];
      for (const c of candidates) {
        if (c.status === 'deleted') throw new Error('抽取不能删除记忆，请使用被替代或过期状态');
        if (!Array.isArray(c.sourceMessageIds) || !c.sourceMessageIds.length || c.sourceMessageIds.some((id) => !messageMap.has(Number(id)))) throw new Error('记忆引用了批次外的消息');
        const refs = unique(c.sourceMessageIds.map(Number)).map((id) => messageMap.get(id));
        const ids = (c.subjectIds || []).map(subject);
        if (ids.some((id) => !allowed.has(id))) throw new Error('记忆包含无法确认的 QQ 身份');
        if (!['explicit', 'reported', 'inferred'].includes(c.evidence)) throw new Error('抽取结果须注明证据类型');
        let evidence = c.evidence;
        const speakers = new Set(refs.map((m) => m.self ? 'bot' : subject(m.senderId)));
        if (evidence === 'explicit' && ids.some((id) => !speakers.has(id))) evidence = 'reported';
        const old = c.targetId ? db.records[c.targetId] : null;
        if (c.targetId && (!old || !localTo(old, chatKey) || !effective(old) || old.pinned || !sameSubjects(ids, old.subjectIds))) throw new Error('抽取不能修改其他范围、其他人物或固定记忆');
        const content = contentText(c.content);
        const sources = refs.map((m) => ({ chatKey, messageId: m.id, mid: m.mid ?? null, senderId: m.self ? 'bot' : String(m.senderId), ts: m.ts, text: String(m.text || '').slice(0, 4000) }));
        // Include tombstones in duplicate checks to avoid resurrecting deletions.
        if (!old && Object.values(db.records).some((r) => r.content === content && r.kind === c.kind && sameSubjects(r.subjectIds, ids) && localTo(r, chatKey))) continue;
        changed.push(this.#put(db, { id: c.targetId, kind: c.kind, content, subjectIds: ids, title: c.title || old?.title || '', eventId: c.eventId || old?.eventId || null,
          visibility: old?.visibility || { type: 'chats', chatKeys: [chatKey] }, evidence, _sources: sources,
          status: c.status || old?.status || 'active', expiresAt: c.expiresAt ?? old?.expiresAt ?? null }, { actor: 'extractor', expectedVersion: c.targetVersion }));
      }
      if (advance) db.jobs[chatKey] = { ...prior, cursor: Math.max(cursor, ...messages.map((m) => m.id)), lastSuccessAt: Date.now(), lastError: '', failures: 0 };
      return { changed: changed.length, records: changed, cursor: db.jobs[chatKey]?.cursor || 0 };
    });
  }
  // Compatibility projection: current participant + last three facts, no new recall.
  members(chatKey) {
    const records = this.listRecords({ chatKey }).filter((r) => !['event', 'commitment'].includes(r.kind) && r.status === 'active');
    const persons = this.listPersons();
    return unique(records.flatMap((r) => r.subjectIds)).map((id) => {
      const p = persons.find((x) => x.id === id);
      const rs = records.filter((r) => r.subjectIds.includes(id)).sort((a, b) => a.updatedAt - b.updatedAt);
      return { userId: p?.userId || '', personId: id, name: p?.aliases.findLast((a) => a.chatKey === chatKey)?.name || p?.name || id,
        impressions: rs.map((r) => ({ id: r.id, content: r.content, evidence: r.evidence, createdAt: r.createdAt })), updatedAt: Math.max(...rs.map((r) => r.updatedAt)), lastConsolidatedAt: this.job(chatKey).lastSuccessAt };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    return { memberImpression: this.members(chatKey).flatMap((m) => m.impressions.map((e) => ({ ...e, userId: m.userId, target: m.name }))).sort((a, b) => b.createdAt - a.createdAt) };
  }
  getMember(chatKey, userId) { return this.members(chatKey).find((m) => m.userId === String(userId)) || { userId: String(userId), name: '', impressions: [], updatedAt: 0 }; }
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    if (!CHAT.test(chatKey)) throw new Error('会话格式错误');
    const sid = subject(extra.userId);
    return this.#transaction((db) => {
      this.#person(db, sid, extra.target, chatKey);
      return Object.values(db.records).find((r) => effective(r) && r.content === content && sameSubjects(r.subjectIds, [sid]) && localTo(r, chatKey)) ||
        this.#put(db, { kind: 'fact', content, subjectIds: [sid], visibility: { type: 'chats', chatKeys: [chatKey] }, evidence: 'inferred' }, { actor: 'tool' });
    });
  }
  remove(chatKey, category, { userId = '', content = '' } = {}) {
    if (category !== 'memberImpression' || !userId || !content) return false;
    return this.#transaction((db) => {
      let removed = false;
      for (const r of Object.values(db.records)) if (effective(r) && r.kind === 'fact' && !r.pinned && sameSubjects(r.subjectIds, [subject(userId)]) && r.content === content && localTo(r, chatKey)) {
        this.#put(db, { ...r, status: 'superseded' }, { actor: 'tool', expectedVersion: r.version }); removed = true;
      }
      return removed;
    });
  }
  editMemberImpression(chatKey, { userId, name = '', note, impressions = [] }) {
    this.replaceMember(chatKey, userId, name, impressions);
    if (note != null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      if (String(note).trim()) notes[String(userId)] = String(note).trim(); else delete notes[String(userId)];
      updateConfig({ memberNotes: { __replace__: notes } });
    }
    return this.getMember(chatKey, userId);
  }
  // Old management bulk edits affect only local single-person facts.
  replaceMember(chatKey, userId, name, contents) {
    if (!CHAT.test(chatKey) || !Array.isArray(contents) || contents.length > 100) throw new Error('编辑格式错误');
    const sid = subject(userId);
    this.#transaction((db) => {
      this.#person(db, sid, name, chatKey);
      const old = Object.values(db.records).filter((r) => effective(r) && r.kind === 'fact' && sameSubjects(r.subjectIds, [sid]) && localTo(r, chatKey));
      const wanted = unique(contents.map(contentText));
      for (const r of old) if (!wanted.includes(r.content)) this.#put(db, { ...r, status: 'deleted' }, { expectedVersion: r.version });
      for (const content of wanted) if (!old.some((r) => r.content === content)) this.#put(db, { kind: 'fact', content, subjectIds: [sid], visibility: { type: 'chats', chatKeys: [chatKey] }, evidence: 'admin' });
    });
    return this.getMember(chatKey, userId);
  }
  removeMember(chatKey, userId) { this.replaceMember(chatKey, userId, '', []); return true; }
  clear(chatKey) {
    this.#transaction((db) => { for (const r of Object.values(db.records)) if (effective(r) && localTo(r, chatKey)) this.#put(db, { ...r, status: 'deleted' }, { expectedVersion: r.version }); });
  }
  consolidationState(chatKey) {
    const ms = this.members(chatKey);
    return { lastConsolidatedAt: this.job(chatKey).lastSuccessAt, counts: { memberImpression: ms.reduce((n, m) => n + m.impressions.length, 0) }, members: ms.map((m) => ({ ...m, count: m.impressions.length })) };
  }
  formatForPrompt(chatKey, { userIds = null } = {}) {
    const notes = getConfig().memberNotes || {};
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const ms = this.members(chatKey).filter((m) => !filter || !m.userId || filter.has(m.userId)).slice(0, filter ? undefined : 15);
    const label = { reported: '（他人转述）', inferred: '（待核实）', legacy: '（历史印象，缺少原始证据）' };
    return ms.length ? ['【对群友的印象】', ...ms.flatMap((m) => m.impressions.slice(-3).map((e) => `- ${notes[m.userId] || m.name}：${e.content}${label[e.evidence] || ''}`))].join('\n') : '';
  }
}
