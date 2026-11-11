import './isolated-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { MemoryStore } from '../src/memory.js';
import { MemoryPipeline } from '../src/memory-pipeline.js';
import { sharedPersonalProfile } from '../src/memory-profile.js';
import { recallMemories, recordAllowed, assertContextAllowed } from '../src/context.js';
import { ChatStore } from '../src/store.js';
import { buildToolDefs, executeTool } from '../src/tools.js';

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.allowAllWhenEmpty = true;
cfg.memory.consolidateEnabled = false;
setRuntimeConfig(cfg);
let count = 0, seq = 0;
const defs = buildToolDefs();
const create = (name) => new MemoryStore(path.join(DATA_DIR, name));
const memory = create('profiles');
const ctx = (chatKey = 'group:2', m = memory) => ({ chatKey, memory: m, session: { contextSelection: { blocklist: '[]' } } });
const extract = (m, chatKey, patch = {}, message = {}) => {
  const id = ++seq;
  const msg = { id, mid: id, senderId: '123', senderName: '小明', text: '我喜欢策略游戏', ts: Date.now(), ...message };
  return m.commitExtraction(chatKey, [msg], [{ kind: 'preference', content: '123 喜欢策略游戏', subjectIds: ['123'],
    evidence: 'explicit', sourceMessageIds: [id], profileCategory: 'interest', ...patch }], { advance: false, knownIds: ['123', '456'] });
};
const run = async (name, args, context = ctx()) => {
  const result = await executeTool(defs, context, name, args);
  assert.ok(!result.isError, result.content);
  return JSON.parse(result.content);
};
async function check(label, fn) { await fn(); console.log(`✓ ${++count}. ${label}`); }

let shared;
await check('群聊稳定资料跨群及私聊查询、按人物自动召回，来源范围不变', async () => {
  shared = extract(memory, 'group:1').records[0];
  assert.equal(shared.profileCategory, 'interest');
  assert.deepEqual(shared.visibility, { type: 'chats', chatKeys: ['group:1'] });
  for (const key of ['group:2', 'private:123']) {
    assert.ok(memory.listRecords({ chatKey: key, personId: '123' }).some((r) => r.id === shared.id));
    assert.ok((await run('memory_person_query', { userId: '123' }, ctx(key))).memories.includes(shared.content));
    assert.ok(recallMemories(memory, key, { query: '你好', subjectIds: ['qq:123'] }).some((r) => r.record.id === shared.id));
    const detail = await run('memory_query', { recordId: shared.id, includeHistory: true }, ctx(key));
    assert.equal(detail.record.sources.length, 0);
  }
  assert.equal(recallMemories(memory, 'group:2', { query: '你好', subjectIds: ['qq:456'] }).length, 0);
  assert.equal((await run('memory_query', { recordId: shared.id }, ctx('group:1'))).record.sources.length, 1);
});

await check('称呼与交流习惯可共享，具体经历、私聊、敏感和临时内容不扩大范围', () => {
  for (const patch of [
    { kind: 'fact', content: '叫我小明', profileCategory: 'nickname' },
    { kind: 'interaction', content: '喜欢简短回答', profileCategory: 'communication' }
  ]) assert.ok(sharedPersonalProfile(extract(memory, 'group:1', patch, { text: patch.content }).records[0]));
  const cases = [
    ['private:123', { content: '123 喜欢咖啡' }],
    ['group:1', { content: '123 喜欢茶', profileCategory: '' }],
    ['group:1', { kind: 'event', content: '一起玩了策略游戏' }],
    ['group:1', { kind: 'relationship', content: '123 和 456 是朋友' }],
    ['group:1', { content: '今天喜欢策略游戏' }],
    ['group:1', { content: '123 的住址是测试地点' }],
    ['group:1', { content: '123 喜欢测试游戏', expiresAt: Date.now() + 60000 }],
    ['group:1', { content: '123 的游戏约定', title: '约定' }],
    ['group:1', { content: '123 不再玩游戏', status: 'superseded' }],
    ['group:1', { content: '123 和 456 喜欢游戏', subjectIds: ['123', '456'] }],
    ['group:1', { content: '推测喜欢游戏', evidence: 'inferred' }]
  ];
  for (const [key, patch] of cases) {
    const r = extract(memory, key, patch).records[0];
    assert.ok(r);
    assert.equal(r.profileCategory, '', r.content);
    assert.ok(!memory.listRecords({ chatKey: 'group:2' }).some((x) => x.id === r.id));
  }
  const reported = extract(memory, 'group:1', { content: '123 喜欢音乐' }, { senderId: '456' }).records[0];
  assert.equal(reported.evidence, 'reported');
  assert.equal(reported.profileCategory, '');
  const secret = extract(memory, 'group:1', { content: '123 喜欢围棋' }, { text: '不要告诉别的群，我喜欢围棋' }).records[0];
  assert.equal(secret.profileCategory, '');
});

await check('共享资料更新必须重新分类，管理员撤销后自动写入无法重新开启', async () => {
  const c = ctx();
  await run('memory_query', { recordId: shared.id }, c);
  const updated = extract(memory, 'group:1', { targetId: shared.id, targetVersion: shared.version,
    content: '123 暂时不想玩游戏', profileCategory: '' }).records[0];
  assert.equal(updated.profileCategory, '');
  assert.throws(() => assertContextAllowed(c.session, memory, c.chatKey), /记忆/);
  const valid = extract(memory, 'group:1', { content: '123 喜欢阅读' }, { text: '我喜欢阅读' }).records[0];
  const disabled = memory.saveRecord({ id: valid.id, profileCategory: '' }, { expectedVersion: valid.version });
  assert.ok(disabled.profileSharingDisabled);
  const again = extract(memory, 'group:1', { targetId: valid.id, targetVersion: disabled.version, content: valid.content }, { text: '我喜欢阅读' }).records[0];
  assert.equal(again.profileCategory, '');
  const confirmed = memory.saveRecord({ id: valid.id, profileCategory: 'interest' }, { expectedVersion: again.version });
  assert.ok(sharedPersonalProfile(confirmed));
  const edited = memory.saveRecord({ id: valid.id, content: '新的内容尚未分类' }, { expectedVersion: confirmed.version });
  assert.equal(edited.profileCategory, '');
});

await check('私聊来源不能通过改范围、人工分类或混入历史绕过限制', () => {
  const privateRecord = memory.listRecords({ chatKey: 'private:123' }).find((r) => r.content === '123 喜欢咖啡');
  assert.throws(() => memory.saveRecord({ id: privateRecord.id, profileCategory: 'interest',
    visibility: { type: 'chats', chatKeys: ['group:1'] } }, { expectedVersion: privateRecord.version }), /私聊|来源/);
  const moved = memory.saveRecord({ id: privateRecord.id, visibility: { type: 'chats', chatKeys: ['group:1'] } }, { expectedVersion: privateRecord.version });
  assert.throws(() => memory.saveRecord({ id: moved.id, profileCategory: 'interest' }, { expectedVersion: moved.version }), /私聊|来源/);
  assert.throws(() => memory.saveRecord({ kind: 'fact', content: '姓名资料', subjectIds: ['123'],
    visibility: { type: 'chats', chatKeys: ['private:123'] }, profileCategory: 'nickname' }), /群聊/);
});

await check('跨会话共享仍受屏蔽、删除及工具权限约束', async () => {
  const r = extract(memory, 'group:1', { content: '123 喜欢编程' }, { text: '我喜欢编程' }).records[0];
  cfg.blocklist = { '2': ['123'] };
  assert.equal(recordAllowed(r, 'group:2'), false);
  const blocked = ctx(); blocked.session.contextSelection.blocklist = '["123"]';
  assert.deepEqual((await run('memory_person_query', { userId: '123' }, blocked)).memories, []);
  cfg.blocklist = {};
  const c = ctx(); await run('memory_query', { recordId: r.id }, c);
  memory.deleteRecord(r.id, r.version);
  assert.throws(() => assertContextAllowed(c.session, memory, c.chatKey), /记忆/);
  cfg.permissions.tools['builtin:memory_person_query'] = { role: 'disabled' };
  assert.equal((await executeTool(defs, ctx(), 'memory_person_query', { userId: '123' })).isError, true);
  delete cfg.permissions.tools['builtin:memory_person_query'];
});

await check('旧管理清空和人物删除仍能删除共享资料，不影响跨群其他来源', () => {
  const m = create('bulk-profile');
  const a = extract(m, 'group:1', { kind: 'fact', content: '叫我小明', profileCategory: 'nickname' }, { text: '叫我小明' }).records[0];
  const b = extract(m, 'group:2', { kind: 'fact', content: '称呼我小明', profileCategory: 'nickname' }, { text: '称呼我小明' }).records[0];
  m.removeMember('group:1', '123');
  assert.equal(m.getRecord(a.id).status, 'deleted');
  assert.ok(sharedPersonalProfile(m.getRecord(b.id)));
  m.clear('group:2');
  assert.equal(m.getRecord(b.id).status, 'deleted');
});

await check('后台抽取传递分类并将其他群的共享资料作为只读参考', async () => {
  const store = new ChatStore(), m = create('pipeline-profile');
  const remote = extract(m, 'group:1', { content: '123 喜欢音乐' }, { text: '我喜欢音乐' }).records[0];
  const incoming = store.appendIncoming('group:2', { mid: 800, senderId: '123', senderName: '明', text: '叫我小明' });
  const pipeline = new MemoryPipeline({ store, memory: m, runModel: async (messages) => {
    const input = JSON.parse(messages[1].content);
    assert.ok(input.locked.some((r) => r.id === remote.id));
    assert.ok(!input.existing.some((r) => r.id === remote.id));
    assert.ok(!JSON.stringify(input.locked).includes('sources'));
    return { message: { content: JSON.stringify({ memories: [{ kind: 'fact', content: '叫我小明', subjectIds: ['123'],
      sourceMessageIds: [incoming.id], evidence: 'explicit', profileCategory: 'nickname' }] }) } };
  } });
  try {
    await pipeline.run('group:2');
    assert.ok(m.listRecords({ chatKey: 'group:3' }).some((r) => r.content === '叫我小明'));
    assert.throws(() => extract(m, 'group:2', { targetId: remote.id, targetVersion: remote.version }), /其他范围/);
  } finally { pipeline.stop(); store.close(); }
});

await check('显式写入工具可分类共享，异步抽取中撤销共享则拒绝提交并保留游标', async () => {
  const store = new ChatStore(), m = create('tool-profile');
  const entry = store.appendIncoming('group:4', { mid: 900, senderId: '123', senderName: '明', text: '我喜欢游泳' });
  const toolCtx = { ...ctx('group:4', m), store };
  const out = await run('memory_append', { kind: 'preference', content: '123 喜欢游泳', subjectIds: ['123'],
    sourceMessageIds: [entry.mid], evidence: 'explicit', profileCategory: 'interest' }, toolCtx);
  const r = out.records[0];
  assert.ok(sharedPersonalProfile(r));
  store.appendIncoming('group:5', { mid: 901, senderId: '123', text: '你好' });
  const p = new MemoryPipeline({ store, memory: m, runModel: async () => {
    m.saveRecord({ id: r.id, profileCategory: '' }, { expectedVersion: r.version });
    return { message: { content: '{"memories":[]}' } };
  } });
  try { await assert.rejects(p.run('group:5'), /记忆/); assert.equal(m.job('group:5').cursor, 0); }
  finally { p.stop(); store.close(); }
});

await check('旧库一次迁移有本人证据的简单稳定条目，备份原样并保留范围、版本与游标', async () => {
  const original = create('old-profile');
  const good = extract(original, 'group:1', { profileCategory: '' }).records[0];
  const privateR = extract(original, 'private:123', { profileCategory: '' }).records[0];
  const inferred = extract(original, 'group:1', { profileCategory: '', evidence: 'inferred', content: '123 喜欢阅读' }).records[0];
  const mixed = extract(original, 'group:1', { profileCategory: '', content: '123 喜欢策略游戏，昨天输了' }).records[0];
  const pinned = extract(original, 'group:1', { profileCategory: '', content: '123 喜欢茶' }, { text: '我喜欢茶' }).records[0];
  original.saveRecord({ id: pinned.id, pinned: true }, { expectedVersion: pinned.version });
  const noSource = original.saveRecord({ kind: 'preference', content: '喜欢咖啡', subjectIds: ['123'], visibility: { type: 'chats', chatKeys: ['group:1'] } });
  const db = JSON.parse(fs.readFileSync(original.file, 'utf8'));
  delete db.profileSharingVersion;
  for (const r of Object.values(db.records)) { delete r.profileCategory; delete r.profileSharingDisabled; }
  db.jobs['group:1'] = { cursor: 123, usage: { calls: 7 } };
  const before = JSON.stringify(db);
  fs.writeFileSync(original.file, before);
  const migrated = new MemoryStore(original.directory);
  const result = migrated.getRecord(good.id), report = migrated.profileMigration();
  assert.deepEqual(report.recordIds, [good.id]);
  assert.equal(fs.readFileSync(path.join(original.directory, report.backup), 'utf8'), before);
  assert.equal(result.version, good.version + 1);
  assert.deepEqual(result.visibility, good.visibility);
  assert.equal(result.history.at(-1).changedBy, 'profile-migration');
  assert.equal(migrated.job('group:1').cursor, 123);
  assert.equal(migrated.job('group:1').usage.calls, 7);
  for (const r of [privateR, inferred, mixed, pinned, noSource]) assert.ok(!sharedPersonalProfile(migrated.getRecord(r.id)));
  const detail = await run('memory_query', { recordId: good.id, includeHistory: true }, ctx('group:2', migrated));
  assert.equal(detail.record.history.length, 0);
  assert.equal(detail.record.sources.length, 0);
  const after = fs.readFileSync(original.file, 'utf8');
  new MemoryStore(original.directory).listRecords();
  assert.equal(fs.readFileSync(original.file, 'utf8'), after);
  migrated.saveRecord({ id: good.id, profileCategory: '' }, { expectedVersion: result.version });
  assert.equal(new MemoryStore(original.directory).getRecord(good.id).profileCategory, '');
});

await check('迁移备份失败阻断写入，旧库不被覆盖', () => {
  const m = create('backup-failure'); m.listRecords();
  const db = JSON.parse(fs.readFileSync(m.file, 'utf8')); delete db.profileSharingVersion;
  const raw = JSON.stringify(db); fs.writeFileSync(m.file, raw);
  fs.writeFileSync(path.join(m.directory, 'backups'), 'not a directory');
  assert.throws(() => new MemoryStore(m.directory).listRecords());
  assert.equal(fs.readFileSync(m.file, 'utf8'), raw);
});

console.log(`\n共享个人资料：${count} 项通过。`);
