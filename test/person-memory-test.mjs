import './isolated-env.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DATA_DIR, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { MemoryStore, MEMORY_KINDS } from '../src/memory.js';
import { buildToolDefs, executeTool, toOpenAiTools } from '../src/tools.js';
import { assertContextAllowed, recallMemories, rememberAccess } from '../src/context.js';
import { boundedToolText } from '../src/run-budget.js';

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.allowAllWhenEmpty = true;
setRuntimeConfig(cfg);
const memory = new MemoryStore(path.join(DATA_DIR, 'person-query'));
const defs = buildToolDefs(), name = 'memory_person_query';
const context = (chatKey = 'group:1') => ({ chatKey, memory, session: { contextSelection: { blocklist: '[]' } } });
const call = (args, ctx = context()) => executeTool(defs, ctx, name, args);
const read = async (args, ctx) => {
  const result = await call({ detail: true, limit: 50, ...args }, ctx);
  assert.ok(!result.isError, result.content);
  return JSON.parse(result.content);
};
const save = (content, extra = {}) => memory.saveRecord({ kind: 'fact', subjectIds: ['123'], content,
  visibility: { type: 'chats', chatKeys: ['group:1'] }, ...extra });
let count = 0;
async function check(label, fn) { await fn(); console.log(`✓ ${++count}. ${label}`); }

await check('工具公开必要 QQ 参数且拒绝昵称、缺失身份及非法分页', async () => {
  const schema = toOpenAiTools(defs).find((d) => d.function.name === name).function.parameters;
  assert.deepEqual(schema.required, ['userId']);
  for (const userId of [undefined, null, '', '小明', 'qq:123', 'bot', 0, -123, 1.2, '0123', '1234567890123456', ['123']]) {
    assert.equal((await call({ userId })).isError, true);
  }
  for (const args of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '20' }, { offset: -1 }, { offset: 0.5 }, { offset: Infinity }, { detail: 'true' }, { detail: 1 }, { detail: null }]) {
    assert.equal((await call({ userId: '123', ...args })).isError, true);
  }
});

const local = MEMORY_KINDS.map((kind) => save(`个人${kind}`, { kind,
  ...(kind === 'relationship' ? { subjectIds: ['123', '456'] } : {}),
  ...(kind === 'commitment' ? { status: 'pending' } : {}) }));
const shared = save('共享偏好', { kind: 'preference', visibility: { type: 'global' } });
save('私聊秘密', { visibility: { type: 'chats', chatKeys: ['private:123'] } });
save('其他群秘密', { visibility: { type: 'chats', chatKeys: ['group:2'] } });
save('不同人物', { subjectIds: ['999'] });
save('仅其他范围存在的人物', { subjectIds: ['888'], visibility: { type: 'chats', chatKeys: ['private:888'] } });

await check('查询覆盖六种类型和所有群聊私聊，但只返回指定人物记录', async () => {
  const result = await read({ userId: 123 });
  assert.deepEqual(Object.keys(result).sort(), ['nextOffset', 'records']);
  assert.equal(result.records.length, 9);
  assert.deepEqual(new Set(result.records.map((r) => r.kind)), new Set(MEMORY_KINDS));
  assert.ok(result.records.every((r) => r.evidence === 'admin' && r.version === 1));
  assert.equal(result.records.find((r) => r.kind === 'commitment').status, 'pending');
  assert.ok(result.records.some((r) => r.content === '私聊秘密'));
  assert.ok(result.records.some((r) => r.content === '其他群秘密'));
  assert.ok(!JSON.stringify(result).match(/不同人物|aliases|sources|history|visibility/));
  assert.deepEqual((await read({ userId: '123' }, context('group:3'))).records, result.records);
  const hidden = await read({ userId: '888' });
  const unknown = await read({ userId: '777' });
  assert.equal(hidden.records.length, 1);
  assert.equal(unknown.records.length, 0);
});

await check('分页稳定覆盖全部记录，详情可通过已有工具展开', async () => {
  const ctx = context(), ids = [];
  let offset = 0;
  do {
    const page = await read({ userId: '123', offset, limit: 2 }, ctx);
    ids.push(...page.records.map((r) => r.id));
    assert.ok(page.records.length <= 2);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, 9);
  assert.equal(ctx.session.memoryAccess.length, 9);
  assert.ok(ctx.session.memoryAccess.every((r) => r.personId === 'qq:123'));
  assert.doesNotThrow(() => assertContextAllowed(ctx.session, memory, ctx.chatKey));
  assert.deepEqual(ids, (await read({ userId: '123' })).records.map((r) => r.id));
  assert.equal((await read({ userId: '123', offset: 100 })).records.length, 0);
  const detail = await executeTool(defs, ctx, 'memory_query', { recordId: shared.id });
  assert.equal(JSON.parse(detail.content).record.id, shared.id);
  const privateRecord = memory.listRecords({ personId: '123' }).find((r) => r.content === '私聊秘密');
  assert.equal((await executeTool(defs, ctx, 'memory_query', { recordId: privateRecord.id })).isError, true);
});

await check('失效记录被排除，完成与取消事件保留原状态', async () => {
  for (const status of ['deleted', 'superseded', 'expired']) save(`失效${status}`, { status });
  save('过期时间', { expiresAt: 1 });
  save('完成的往事', { kind: 'event', status: 'completed' });
  save('取消的约定', { kind: 'commitment', status: 'cancelled' });
  const result = await read({ userId: '123' });
  assert.equal(result.records.length, 11);
  assert.ok(result.records.some((r) => r.status === 'completed'));
  assert.ok(result.records.some((r) => r.status === 'cancelled'));
  assert.ok(!result.records.some((r) => /失效|过期时间/.test(r.content)));
});

await check('屏蔽主体、共同主体和证据说话人均不可返回，转述保留证据标签', async () => {
  const msg = { id: 1, mid: 100, senderId: '456', senderName: '测试', text: '123 喜欢茶', ts: 100 };
  const extracted = memory.commitExtraction('group:1', [msg], [{ kind: 'preference', content: msg.text,
    subjectIds: ['123'], sourceMessageIds: [1], evidence: 'explicit' }], { advance: false, knownIds: ['123'] }).records[0];
  assert.equal((await read({ userId: '123' })).records.find((r) => r.id === extracted.id).evidence, 'reported');
  cfg.blocklist = { '1': ['456'] };
  const ctx = context(); ctx.session.contextSelection.blocklist = '["456"]';
  const result = await read({ userId: '123' }, ctx);
  assert.ok(!result.records.some((r) => r.id === extracted.id || r.kind === 'relationship'));
  cfg.blocklist = { '1': ['123'] };
  ctx.session = { contextSelection: { blocklist: '["123"]' } };
  assert.equal((await read({ userId: '123' }, ctx)).records.length, 0);
  cfg.blocklist = {};
});

await check('跨会话查询不因来源范围改变中断，但删除或禁用仍生效', async () => {
  const ctx = context();
  await read({ userId: '123', detail: false }, ctx);
  memory.saveRecord({ id: local[0].id, visibility: { type: 'chats', chatKeys: ['private:123'] } }, { expectedVersion: local[0].version });
  assert.doesNotThrow(() => assertContextAllowed(ctx.session, memory, ctx.chatKey));
  memory.deleteRecord(local[0].id, local[0].version + 1);
  assert.throws(() => assertContextAllowed(ctx.session, memory, ctx.chatKey), /记忆/);
  assert.equal((await call({ userId: '123' }, ctx)).isError, true);
  cfg.permissions.tools = { 'builtin:memory_person_query': { role: 'disabled' } };
  assert.equal((await call({ userId: '123' })).isError, true);
});

await check('跨会话例外绑定指定人物，普通召回与既有可见范围检查保持独立', async () => {
  cfg.permissions.tools = {};
  const r = save('跨会话独立验证', { subjectIds: ['777'], visibility: { type: 'chats', chatKeys: ['private:777'] } });
  assert.equal(recallMemories(memory, 'group:1', { query: '跨会话独立验证', subjectIds: ['qq:777'] }).length, 0);
  const c = context();
  assert.equal((await read({ userId: '777' }, c)).records[0].id, r.id);
  assert.doesNotThrow(() => assertContextAllowed(c.session, memory, c.chatKey));
  memory.saveRecord({ id: r.id, subjectIds: ['456'] }, { expectedVersion: r.version });
  assert.throws(() => assertContextAllowed(c.session, memory, c.chatKey), /记忆/);
  const normal = save('普通读取仍按范围判断');
  const mixed = context();
  rememberAccess(mixed.session, [normal]);
  await read({ userId: '123' }, mixed);
  memory.saveRecord({ id: normal.id, visibility: { type: 'chats', chatKeys: ['private:123'] } }, { expectedVersion: normal.version });
  assert.throws(() => assertContextAllowed(mixed.session, memory, mixed.chatKey), /记忆/);
});

await check('默认仅返回正文与游标，每页十条，去重后分页无漏项且详情保留重复记录', async () => {
  for (let i = 0; i < 12; i++) save(`分页条目${i}`, { subjectIds: ['555'] });
  for (let i = 0; i < 2; i++) save(`分页条目${i}`, { subjectIds: ['555'], visibility: { type: 'chats', chatKeys: ['private:555'] } });
  const compactCtx = context();
  const first = JSON.parse((await call({ userId: '555' }, compactCtx)).content);
  assert.deepEqual(Object.keys(first).sort(), ['memories', 'nextOffset']);
  assert.equal(first.memories.length, 10);
  assert.equal(first.nextOffset, 10);
  const second = JSON.parse((await call({ userId: '555', offset: first.nextOffset }, compactCtx)).content);
  assert.equal(second.nextOffset, null);
  assert.equal(second.memories.length, 2);
  assert.equal(new Set([...first.memories, ...second.memories]).size, 12);
  assert.equal(compactCtx.session.memoryAccess.length, 12);
  assert.doesNotThrow(() => assertContextAllowed(compactCtx.session, memory, compactCtx.chatKey));
  assert.deepEqual(JSON.parse((await call({ userId: '555', offset: 99 })).content), { memories: [], nextOffset: null });
  const detailed = await read({ userId: '555' });
  assert.equal(detailed.records.length, 14);
  assert.ok(detailed.records.every((r) => r.id && r.kind && r.evidence && r.version));
  assert.ok(!JSON.stringify(detailed).match(/updatedAt|profileCategory|userId|personId|scope|note|total|count/));
});

await check('正文不截断、保留必要证据和进度标记，冲突及不同事件不被合并', async () => {
  const base = save('测试原文', { subjectIds: ['666'] });
  const long = '并不喜欢甜食，只有运动后才偶尔吃一点。'.repeat(80);
  const rows = [
    { content: long, evidence: 'explicit' },
    { content: '喜欢茶', evidence: 'admin' },
    { content: '喜欢茶', evidence: 'reported' },
    { content: '喜欢茶', evidence: 'inferred' },
    { content: '喜欢茶', evidence: 'legacy' },
    { content: '一起测试', kind: 'commitment', status: 'pending', title: '新功能' },
    { content: '一起测试', kind: 'commitment', status: 'in_progress' },
    { content: '一起测试', kind: 'commitment', status: 'completed' },
    { content: '一起测试', kind: 'commitment', status: 'cancelled' },
    { content: '一起测试', kind: 'commitment', status: 'pending', title: '另一个功能' },
    { content: '不喜欢茶', evidence: 'explicit' }
  ].map((r, i) => ({ ...base, ...r, id: `fixture_${i}` }));
  const fixture = { ...context(), memory: { listRecords: () => rows, getRecord: (id) => rows.find((r) => r.id === id) } };
  const result = await read({ userId: '666', detail: false }, fixture);
  assert.equal(result.memories.length, rows.length);
  for (const text of [long, '喜欢茶', '[他人转述] 喜欢茶', '[推测，待核实] 喜欢茶', '[旧记忆，缺少原始证据] 喜欢茶',
    '[待完成] 新功能：一起测试', '[进行中] 一起测试', '[已完成] 一起测试', '[已取消] 一起测试', '[待完成] 另一个功能：一起测试', '不喜欢茶']) {
    assert.ok(result.memories.includes(text), text.slice(0, 60));
  }
  assert.equal(result.nextOffset, null);
  assert.doesNotThrow(() => assertContextAllowed(fixture.session, fixture.memory, fixture.chatKey));
  const detailed = await read({ userId: '666', detail: true }, fixture);
  assert.ok(detailed.records.some((r) => r.title === '新功能' && r.content === '一起测试'));
});

await check('按实际 JSON 字符数整条分页，转义与详细模式均不丢正文或游标', async () => {
  const m = new MemoryStore(path.join(DATA_DIR, 'char-pages'));
  const contents = Array.from({ length: 4 }, (_, i) => `${i}:` + '"\\\n'.repeat(90) + '完整正文'.repeat(20));
  for (const content of contents) m.saveRecord({ kind: 'preference', content, subjectIds: ['123'], visibility: { type: 'global' } });
  for (const detail of [false, true]) {
    const c = { ...context(), memory: m, toolResultMaxChars: 1000 };
    let offset = 0; const seen = [];
    do {
      const result = await call({ userId: '123', limit: 50, offset, detail }, c);
      assert.ok(!result.isError, result.content);
      assert.ok(result.content.length <= 1000);
      assert.equal(boundedToolText(result.content, 1000), result.content);
      const page = JSON.parse(result.content);
      const values = detail ? page.records.map(r => r.content) : page.memories;
      assert.ok(values.length > 0 && values.length < 4);
      seen.push(...values);
      assert.ok(page.nextOffset === null || page.nextOffset > offset);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual([...seen].sort(), [...contents].sort());
    assert.equal(c.session.memoryAccess.length, 4);
  }
});

await check('单条过大返回结构化错误不跳过，调高上限后可从原偏移继续', async () => {
  const m = new MemoryStore(path.join(DATA_DIR, 'large-row'));
  const content = '长'.repeat(1800);
  const r = m.saveRecord({ kind: 'preference', content, subjectIds: ['123'], visibility: { type: 'global' } });
  const c = { ...context(), memory: m, toolResultMaxChars: 1000 };
  const result = await call({ userId: '123' }, c);
  assert.equal(result.isError, true);
  const error = JSON.parse(result.content);
  assert.equal(error.blockedOffset, 0);
  assert.ok(error.requiredMaxChars > 1000);
  assert.equal(error.maxChars, 1000);
  assert.ok(!('nextOffset' in error));
  assert.equal(c.session.memoryAccess.length, 0);
  const page = await read({ userId: '123', detail: false, offset: error.blockedOffset }, { ...c, toolResultMaxChars: 3000 });
  assert.deepEqual(page.memories, [content]);
  assert.equal(page.nextOffset, null);
  const details = await executeTool(defs, { ...context(), memory: m, toolResultMaxChars: 1000 }, 'memory_query', { recordId: r.id });
  assert.equal(details.isError, true);
  assert.ok(JSON.parse(details.content).requiredMaxChars > 1000);
});

await check('普通 memory_query 也整条分页，兼容投影和来源详情不被通用截断破坏', async () => {
  const m = new MemoryStore(path.join(DATA_DIR, 'normal-pages'));
  const originals = Array.from({ length: 3 }, (_, i) => m.saveRecord({ kind: 'fact', content: `${i}关键词` + '长'.repeat(300),
    subjectIds: ['123'], visibility: { type: 'chats', chatKeys: ['group:1'] } }));
  const c = { ...context(), memory: m, toolResultMaxChars: 1200 };
  let offset = 0; const ids = [];
  do {
    const result = await executeTool(defs, c, 'memory_query', { userId: '123', query: '关键词', limit: 50, offset });
    assert.ok(!result.isError, result.content);
    assert.ok(result.content.length <= 1200);
    const page = JSON.parse(result.content);
    assert.deepEqual(page.records.map(r => r.content), page.memberImpression.map(r => r.content));
    ids.push(...page.records.map(r => r.id)); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual([...ids].sort(), originals.map(r => r.id).sort());
});

console.log(`\n个人记忆查询：${count} 项通过。`);
