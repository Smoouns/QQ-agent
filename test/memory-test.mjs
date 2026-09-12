import './isolated-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from '../src/memory.js';
import { MemoryPipeline, parseMemoryResult } from '../src/memory-pipeline.js';
import { ChatStore } from '../src/store.js';
import { DATA_DIR, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { buildToolDefs } from '../src/tools.js';

let count = 0;
async function check(name, fn) { await fn(); console.log(`✓ ${++count}. ${name}`); }
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.memory.consolidateEnabled = false;
cfg.allow = { groups: ['1', '2'], private: ['123'] };
cfg.providersImported = true;
setRuntimeConfig(cfg);
const directory = path.join(DATA_DIR, 'migration-fixture');
const write = (relative, data) => { const f = path.join(directory, relative); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); };
write('group_1/123.json', { userId: '123', name: '小明', impressions: [{ content: '喜欢合作游戏', createdAt: 10 }] });
write('group_2/123.json', { userId: '123', name: '老明', impressions: [{ content: '群二主持人', createdAt: 20 }] });
write('private_123/123.json', { userId: '123', name: '明', impressions: [{ content: '私聊内容', createdAt: 30 }] });
write('group_1/_n_a.json', { name: '同名', impressions: [{ content: '未知身份 A' }] });
write('group_1/_n_b.json', { name: '同名', impressions: [{ content: '未知身份 B' }] });
write('group_3.json', { memberImpression: [{ target: '999', content: '旧单文件' }] });
const original = fs.readFileSync(path.join(directory, 'group_1/123.json'), 'utf8');
let memory = new MemoryStore(directory);
await check('三会话同 QQ 归入一个人物，别名带来源，同名未知人物不误合并', () => {
  assert.equal(memory.getPerson('123').recordCount, 3);
  assert.equal(memory.getPerson('123').aliases.length, 3);
  assert.equal(memory.listPersons().filter((p) => p.name === '同名').length, 2);
  assert.equal(memory.getPerson('999').recordCount, 1);
});
await check('迁移保留原文件和备份，不伪造来源，重启不重复导入', () => {
  assert.equal(fs.readFileSync(path.join(directory, 'group_1/123.json'), 'utf8'), original);
  const data = JSON.parse(fs.readFileSync(memory.file, 'utf8'));
  assert.ok(data.migrations.every((m) => fs.existsSync(path.join(directory, m.backup))));
  assert.ok(memory.listRecords().every((r) => r.evidence === 'legacy' && r.sources.length === 0));
  memory = new MemoryStore(directory);
  assert.equal(memory.listRecords().length, 6);
});
await check('跨群人物聚合与聊天可见范围分离', () => {
  assert.equal(memory.listRecords({ chatKey: 'group:2', personId: '123' }).length, 1);
  assert.ok(!memory.formatForPrompt('group:1').includes('私聊内容'));
  assert.ok(!memory.formatForPrompt('group:2').includes('喜欢合作游戏'));
});
let globalRecord;
await check('人工确认全局偏好，原有会话选择方式可以使用', () => {
  globalRecord = memory.saveRecord({ kind: 'preference', content: '喜欢策略游戏', subjectIds: ['123'], visibility: { type: 'global' } });
  assert.ok(memory.formatForPrompt('group:2', { userIds: ['123'] }).includes('喜欢策略游戏'));
  assert.ok(!memory.formatForPrompt('group:2', { userIds: ['999'] }).includes('喜欢策略游戏'));
});
let event;
await check('多人事件保存一份，承诺状态和版本历史可追溯', () => {
  event = memory.saveRecord({ kind: 'commitment', title: '联机', content: '123 和 456 约好周六联机', subjectIds: ['123', '456'], visibility: { type: 'chats', chatKeys: ['group:1'] }, status: 'pending' });
  assert.equal(memory.listRecords({ personId: '456' })[0].id, event.id);
  event = memory.saveRecord({ id: event.id, status: 'cancelled', content: '联机取消，改日再约' }, { expectedVersion: 1 });
  assert.equal(event.version, 2);
  assert.equal(event.history[0].status, 'pending');
  assert.equal(event.history[0].content, '123 和 456 约好周六联机');
});
await check('旧版本修改被拒绝且不影响现有数据', () => {
  assert.throws(() => memory.saveRecord({ id: event.id, content: '过时结果' }, { expectedVersion: 1 }), /已变化/);
  assert.equal(memory.getRecord(event.id).version, 2);
});
await check('过期、删除和被替代条目退出有效视图，管理历史保留', () => {
  const expired = memory.saveRecord({ kind: 'fact', content: '已经过期', subjectIds: ['123'], expiresAt: 1, visibility: { type: 'global' } });
  assert.ok(!memory.listRecords().some((r) => r.id === expired.id));
  memory.deleteRecord(expired.id, expired.version);
  assert.equal(memory.getRecord(expired.id).status, 'deleted');
  assert.ok(memory.listRecords({ includeInactive: true }).some((r) => r.id === expired.id));
});
await check('管理端不能注入伪造来源或历史，基本画像按有效证据重建', () => {
  const r = memory.saveRecord({ kind: 'fact', content: '人工确认的事实', subjectIds: ['123'], visibility: { type: 'global' }, sources: [{ text: '伪造' }], history: ['伪造'], version: 99 });
  assert.equal(r.version, 1); assert.deepEqual(r.sources, []); assert.deepEqual(r.history, []);
  assert.ok(memory.getPerson('123').profile.some((x) => x.id === r.id));
  memory.deleteRecord(r.id, r.version);
  assert.ok(!memory.getPerson('123').profile.some((x) => x.id === r.id));
});
const msg = { id: 1, mid: 1001, senderId: '123', senderName: '小明', text: '我喜欢茶，456 喜欢咖啡', ts: 100, self: false };
const candidate = (patch = {}) => ({ kind: 'preference', content: '123 喜欢茶', subjectIds: ['123'], sourceMessageIds: [1], evidence: 'explicit', ...patch });
await check('说话人与主体分开：别人描述的偏好降为转述，来源保留', () => {
  const result = memory.commitExtraction('group:1', [msg], [candidate({ subjectIds: ['456'], content: '456 喜欢咖啡' })], { cursor: 0, knownIds: ['456'] });
  assert.equal(result.records[0].evidence, 'reported');
  assert.equal(result.records[0].sources[0].senderId, '123');
  assert.equal(result.records[0].sources[0].text, msg.text);
});
await check('候选整批事务：坏来源不写入任何条目、不推进游标', () => {
  const before = memory.listRecords().length;
  assert.throws(() => memory.commitExtraction('group:1', [{ ...msg, id: 2 }], [candidate({ sourceMessageIds: [2] }), candidate({ sourceMessageIds: [999] })], { cursor: 1 }), /批次外/);
  assert.equal(memory.listRecords().length, before); assert.equal(memory.job('group:1').cursor, 1);
});
await check('固定、全局和跨群记忆不能被模型更新', () => {
  const pinned = memory.saveRecord({ kind: 'fact', content: '固定事实', subjectIds: ['123'], visibility: { type: 'chats', chatKeys: ['group:1'] }, pinned: true });
  for (const r of [pinned, globalRecord, memory.listRecords({ chatKey: 'private:123' }).find((x) => x.evidence === 'legacy')]) {
    assert.throws(() => memory.commitExtraction('group:1', [msg], [candidate({ targetId: r.id, targetVersion: r.version })], { advance: false }), /不能修改/);
  }
});
await check('重复抽取与删除后的重跑不复活原记录', () => {
  const c = candidate({ content: '123 喜欢乌龙茶' });
  const r = memory.commitExtraction('group:1', [msg], [c], { advance: false }).records[0];
  assert.equal(memory.commitExtraction('group:1', [msg], [c], { advance: false }).changed, 0);
  memory.deleteRecord(r.id, r.version);
  assert.equal(memory.commitExtraction('group:1', [msg], [c], { advance: false }).changed, 0);
});
await check('模型不能扩大范围、伪造主体、删除条目', () => {
  const r = memory.commitExtraction('group:1', [msg], [candidate({ content: '来源范围验证', visibility: { type: 'global' } })], { advance: false }).records[0];
  assert.deepEqual(r.visibility, { type: 'chats', chatKeys: ['group:1'] });
  assert.throws(() => memory.commitExtraction('group:1', [msg], [candidate({ subjectIds: ['888'] })], { advance: false }), /无法确认/);
  assert.throws(() => memory.commitExtraction('group:1', [msg], [candidate({ status: 'deleted' })], { advance: false }), /不能删除/);
});
await check('损坏数据库或迁移文件阻断加载，原内容不被覆盖', () => {
  const bad = path.join(DATA_DIR, 'bad-memory'); fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'v2.json'), '{broken');
  assert.throws(() => new MemoryStore(bad).listPersons());
  assert.equal(fs.readFileSync(path.join(bad, 'v2.json'), 'utf8'), '{broken');
  const legacyBad = path.join(DATA_DIR, 'bad-legacy'); fs.mkdirSync(legacyBad);
  fs.writeFileSync(path.join(legacyBad, 'group_1.json'), '{broken');
  assert.throws(() => new MemoryStore(legacyBad).listPersons());
  assert.equal(fs.existsSync(path.join(legacyBad, 'v2.json')), false);
});
await check('抽取解析失败不能被当成空结果成功', () => {
  assert.throws(() => parseMemoryResult('{}'));
  assert.throws(() => parseMemoryResult('模型输出坏格式'));
  assert.deepEqual(parseMemoryResult('```json\n{"memories":[]}\n```'), []);
});

const store = new ChatStore();
const pipelineMemory = new MemoryStore(path.join(DATA_DIR, 'pipeline-memory'));
const entry = store.appendIncoming('group:1', { mid: 91, senderId: '123', senderName: '明', text: '我喜欢茶' });
let calls = 0, fail = true;
const pipeline = new MemoryPipeline({ store, memory: pipelineMemory, runModel: async () => {
  calls++; if (fail) throw Error('fixture model failure');
  return { message: { content: JSON.stringify({ memories: [candidate({ sourceMessageIds: [entry.id] })] }) } };
} });
await check('模型失败保留游标，恢复后写入，重启不重抽', async () => {
  await assert.rejects(pipeline.run('group:1'), /fixture/);
  assert.equal(pipelineMemory.job('group:1').cursor, 0);
  assert.equal(pipelineMemory.job('group:1').failures, 1);
  fail = false; await pipeline.run('group:1');
  assert.equal(pipelineMemory.job('group:1').cursor, entry.id);
  assert.equal(store.findByLocalId('group:1', entry.id).read, false);
  assert.equal(pipelineMemory.job('group:1').usage.calls, 1);
  const restarted = new MemoryPipeline({ store, memory: new MemoryStore(pipelineMemory.directory), runModel: () => { throw Error('should not call'); } });
  assert.equal((await restarted.run('group:1')).changed, 0);
  restarted.stop();
});
await check('模型返回坏 JSON 时用量仍留存，后续成功不会清空累计用量', async () => {
  const m = new MemoryStore(path.join(DATA_DIR, 'usage-fixture'));
  const p = new MemoryPipeline({ store, memory: m, runModel: async () => ({ usage: { prompt_tokens: 10, completion_tokens: 5 }, message: { content: '{}' } }) });
  await assert.rejects(p.run('group:1'));
  assert.equal(m.job('group:1').cursor, 0);
  assert.equal(m.job('group:1').usage.totalTokens, 15);
  p.runModel = async () => ({ usage: { prompt_tokens: 8, completion_tokens: 2 }, message: { content: '{"memories":[]}' } });
  await p.run('group:1');
  assert.equal(m.job('group:1').usage.calls, 2); assert.equal(m.job('group:1').usage.totalTokens, 25);
  p.stop();
});
await check('批处理中新增消息不会被提前标记处理，同会话并发只调用一次模型', async () => {
  const e2 = store.appendIncoming('group:1', { mid: 92, senderId: '123', text: '第二条' });
  let resolve;
  pipeline.runModel = () => { calls++; return new Promise((r) => { resolve = r; }); };
  const a = pipeline.run('group:1'), b = pipeline.run('group:1');
  assert.equal(a, b);
  const e3 = store.appendIncoming('group:1', { mid: 93, senderId: '123', text: '第三条' });
  resolve({ message: { content: '{"memories":[]}' } }); await a;
  assert.equal(pipelineMemory.job('group:1').cursor, e2.id);
  assert.equal(store.after('group:1', e2.id)[0].id, e3.id);
});
await check('管理员修改与异步抽取冲突时，整个批次保持待重试', async () => {
  const old = pipelineMemory.listRecords()[0];
  pipeline.runModel = async () => {
    pipelineMemory.saveRecord({ id: old.id, content: '管理员修正' }, { expectedVersion: old.version });
    return { message: { content: JSON.stringify({ memories: [candidate({ targetId: old.id, targetVersion: old.version, sourceMessageIds: [3] })] }) } };
  };
  await assert.rejects(pipeline.run('group:1'), /已变化/);
  assert.equal(pipelineMemory.getRecord(old.id).content, '管理员修正');
  assert.equal(pipelineMemory.job('group:1').cursor, 2);
});
await check('暂停或撤销白名单后，已发出的模型结果不能落盘', async () => {
  let running = true;
  pipeline.enabled = () => running;
  pipeline.runModel = async () => { running = false; return { message: { content: '{"memories":[]}' } }; };
  await assert.rejects(pipeline.run('group:1'), /停止/);
  assert.equal(pipelineMemory.job('group:1').cursor, 2);
  running = true;
  await assert.rejects(pipeline.run('group:999'), /未启用/);
  pipeline.stop();
});
await check('旧式模型删除不能跨范围或删除固定事实', () => {
  assert.equal(memory.remove('group:1', 'memberImpression', { userId: '123', content: globalRecord.content }), false);
  assert.equal(memory.remove('group:1', 'memberImpression', { userId: '123', content: '固定事实' }), false);
});
await check('模型运行期间新增屏蔽成员，其来源不能进入记忆', async () => {
  const m = new MemoryStore(path.join(DATA_DIR, 'block-fixture'));
  const p = new MemoryPipeline({ store, memory: m, runModel: async () => {
    const changed = structuredClone(cfg); changed.blocklist = { '1': ['123'] }; setRuntimeConfig(changed);
    return { message: { content: JSON.stringify({ memories: [candidate()] }) } };
  } });
  try { await assert.rejects(p.run('group:1'), /屏蔽/); assert.equal(m.job('group:1').cursor, 0); assert.equal(m.listRecords().length, 0); }
  finally { p.stop(); setRuntimeConfig(cfg); }
});
await check('自动抽取无需聊天回复，停止后不遗留计时器', async () => {
  const liveCfg = structuredClone(cfg); liveCfg.memory.consolidateEnabled = true;
  setRuntimeConfig(liveCfg);
  const m = new MemoryStore(path.join(DATA_DIR, 'automatic-fixture'));
  let called = 0;
  const p = new MemoryPipeline({ store, memory: m, runModel: async () => { called++; return { message: { content: '{"memories":[]}' } }; } });
  p.schedule('group:1', 1);
  const deadline = Date.now() + 3000;
  while (!m.job('group:1').cursor && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(called, 1); assert.equal(m.job('group:1').cursor, 3);
  p.stop(); assert.equal(p.timers.size, 0);
  setRuntimeConfig(cfg);
});
await check('带 QQ 消息来源的工具写入与后台抽取共用校验', async () => {
  const tool = buildToolDefs().find((t) => t.name === 'memory_append');
  const result = await tool.execute({ memory: pipelineMemory, store, chatKey: 'group:1', emit() {} }, { kind: 'event', content: '一起喝茶', subjectIds: ['123'], sourceMessageIds: [91], evidence: 'explicit' });
  assert.ok(!result.isError);
  assert.equal(pipelineMemory.listRecords({ kind: 'event' })[0].sources[0].mid, 91);
});

const { createApp } = await import('../src/app.js');
const app = createApp({ log() {} });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const api = async (url, method = 'GET', body, headers = {}) => {
  const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
};
try {
  await check('管理 API 新增、全局人物读取、修改冲突、固定与删除历史', async () => {
    let r = await api('/api/memory/records', 'POST', { kind: 'event', title: '活动', content: '共同活动', subjectIds: ['123', '456'], visibility: { type: 'chats', chatKeys: ['group:1'] } });
    assert.equal(r.status, 200); const id = r.data.record.id;
    assert.equal((await api('/api/memory/persons')).data.persons.length, 2);
    assert.equal((await api('/api/memory/records?personId=123')).data.records[0].id, id);
    r = await api(`/api/memory/records/${id}`, 'PUT', { expectedVersion: 1, pinned: true });
    assert.equal(r.data.record.version, 2);
    assert.equal((await api(`/api/memory/records/${id}`, 'PUT', { expectedVersion: 1, content: 'stale' })).status, 409);
    assert.equal((await api(`/api/memory/records/${id}`, 'DELETE', { expectedVersion: 2 })).status, 200);
    assert.equal((await api('/api/memory/records')).data.records.length, 0);
    assert.equal((await api('/api/memory/records?includeInactive=true')).data.records[0].history.length, 2);
  });
  await check('记忆管理 API 拒绝跨站访问和伪造新 ID', async () => {
    assert.equal((await api('/api/memory/persons', 'GET', null, { origin: 'https://example.org' })).status, 403);
    assert.equal((await api('/api/memory/records', 'POST', { id: 'fake' })).status, 400);
    assert.equal((await api('/api/memory-files/consolidate', 'POST', { chatKey: 'group:1', userIds: ['123'] })).status, 400);
    assert.equal((await api('/api/memory-files/consolidate', 'POST', { chatKey: 'group:999' })).status, 400);
  });
} finally { await app.stop(); }
console.log(`\n${count} memory checks passed`);
