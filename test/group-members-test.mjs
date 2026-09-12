import './isolated-env.mjs';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { buildToolDefs, executeTool } from '../src/tools.js';

const cfg = structuredClone(DEFAULT_CONFIG);
setRuntimeConfig(cfg);
const defs = buildToolDefs();
const calls = [];
let roster = [
  { user_id: 100, nickname: 'Alice', card: '小明', sex: 'female', age: 20 },
  { user_id: 20, nickname: '另一个昵称', card: '小明' },
  { user_id: 3, nickname: '沉默群友', card: '' },
  { user_id: 999, nickname: '被屏蔽', card: '小明' },
  { user_id: null, nickname: '无效记录' }
];
let fail = false, onCall = null;
const onebot = { call: async (action, args) => {
  calls.push({ action, args });
  onCall?.();
  if (fail) throw new Error('连接中断');
  return structuredClone(roster);
} };
const ctx = { kind: 'group', chatKey: 'group:123', chatId: '错误字段不能作为群号', session: {}, onebot };
const query = (args = {}, context = ctx) => executeTool(defs, context, 'get_group_members', args);
const data = async (args = {}, context = ctx) => {
  const r = await query(args, context); assert.ok(!r.isError, r.content); return JSON.parse(r.content);
};
let count = 0;
async function check(name, fn) { await fn(); console.log(`✓ ${++count}. ${name}`); }

await check('从 OneBot 查当前群，返回沉默成员并最小化字段', async () => {
  const r = await data();
  assert.deepEqual(calls[0], { action: 'get_group_member_list', args: { group_id: 123 } });
  assert.deepEqual(r.members.map((m) => m.userId), ['3', '20', '100', '999']);
  assert.deepEqual(Object.keys(r.members[2]).sort(), ['card', 'nickname', 'userId']);
  assert.equal(r.nextAfterUserId, null);
});
await check('名字搜索保留同名候选，支持英文大小写和精确 QQ 查询', async () => {
  assert.deepEqual((await data({ query: '小明' })).members.map((m) => m.userId), ['20', '100', '999']);
  assert.equal((await data({ query: 'aLiCe' })).members[0].userId, '100');
  assert.equal((await data({ userId: '20' })).members[0].card, '小明');
  assert.equal((await data({ query: '不存在' })).count, 0);
  assert.equal((await data({ query: '00' })).members[0].userId, '100');
});
await check('固定名单快照支持稳定分页，下一轮重新获取名单', async () => {
  const first = await data({ limit: 2 });
  roster.unshift({ user_id: 2, nickname: '新入群' });
  const second = await data({ limit: 2, afterUserId: first.nextAfterUserId });
  assert.deepEqual(second.members.map((m) => m.userId), ['100', '999']);
  assert.equal(second.hasMore, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(ctx.session), ['permissionAudit']); // no full roster persisted
  assert.ok(!JSON.stringify(ctx.session).includes('小明'));
  assert.equal((await data({}, { ...ctx, session: {} })).members[0].userId, '2');
});
await check('缓存分页与网络返回后的屏蔽变更立即生效', async () => {
  cfg.blocklist = { '123': ['999'] };
  assert.equal((await data({ query: '小明' })).total, 2);
  onCall = () => { cfg.blocklist['123'] = ['999', '20']; };
  assert.deepEqual((await data({ query: '小明' }, { ...ctx, session: {} })).members.map((m) => m.userId), ['100']);
  onCall = null;
});
await check('私聊、跨群参数、无效游标和越界页长在请求前拒绝', async () => {
  const before = calls.length;
  assert.equal((await query({}, { ...ctx, kind: 'private', chatKey: 'private:123', session: {} })).isError, true);
  for (const args of [{ groupId: '456' }, { userId: '小明' }, { afterUserId: '-2' }, { limit: 101 }, { limit: 0 }, { limit: 1.5 }, { query: ['小明'] }]) {
    assert.equal((await query(args, { ...ctx, session: {} })).isError, true);
  }
  assert.equal(calls.length, before);
});
await check('接口错误不缓存，恢复后可重试；兼容 data 数组', async () => {
  const fresh = { ...ctx, session: {} };
  fail = true;
  assert.equal((await query({}, fresh)).isError, true);
  fail = false;
  assert.ok((await data({}, fresh)).count > 0);
  const wrapped = { ...ctx, session: {}, onebot: { call: async () => ({ data: [{ user_id: 42, nickname: '包装返回' }] }) } };
  assert.equal((await data({}, wrapped)).members[0].userId, '42');
  const invalid = { ...ctx, session: {}, onebot: { call: async () => ({ unexpected: [] }) } };
  assert.equal((await query({}, invalid)).isError, true);
});
console.log(`\n${count} group member checks passed`);
