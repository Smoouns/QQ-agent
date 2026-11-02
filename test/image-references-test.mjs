import './isolated-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../src/config.js';
import { scanImageReferences } from '../src/image-references.js';

let count = 0;
function check(name, fn) { fn(); console.log(`✓ ${++count}. ${name}`); }
function fixture() { return fs.mkdtempSync(path.join(DATA_DIR, 'references-')); }
function write(root, name, data) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
  return target;
}
const chat = (chatKey = 'group:1', messages = []) => ({ chatKey, nextLocalId: messages.length + 1, messages });
const session = (id = 'run-abc12345', extra = {}) => ({ id, chatKey: 'group:1', messages: [], sent: [], ...extra });
const inspect = root => scanImageReferences({ dataDir: root });

check('缺失目录为空快照，扫描不会创建目录或修改文件', () => {
  const root = fixture(), absent = path.join(root, 'absent');
  assert.deepEqual(inspect(absent), { imageIds: new Set(), references: new Map(), issues: [], complete: true });
  assert.equal(fs.existsSync(absent), false);
  const file = write(root, 'messages/group_1.json', chat());
  const before = fs.readFileSync(file);
  assert.equal(inspect(root).complete, true);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
});

check('扫描完整聊天历史、文本引用及跨会话引用，按文件去重', () => {
  const root = fixture(), firstId = randomUUID(), textId = randomUUID();
  const messages = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, text: `message ${i}` }));
  messages[0].media = [{ kind: 'image', imageId: firstId }];
  messages[149].text = `[图片:${textId}] 又一次 ${textId}`;
  write(root, 'messages/group_1.json', chat('group:1', messages));
  write(root, 'messages/private_1.json', chat('private:1', [{ id: 1, media: [{ imageId: firstId }] }]));
  const result = inspect(root);
  assert.equal(result.complete, true);
  assert.deepEqual(result.imageIds, new Set([firstId, textId]));
  assert.deepEqual(result.references.get(firstId), [
    { source: 'messages/group_1.json', chatKey: 'group:1' },
    { source: 'messages/private_1.json', chatKey: 'private:1' }
  ]);
  assert.equal(result.references.get(textId).length, 1);
});

check('编辑参数、字符串化工具调用和结果、失败重发及已发送记录均保护 ID', () => {
  const root = fixture(), ids = Array.from({ length: 7 }, () => randomUUID());
  const escaped = ids[6].replace(/[a-f0-9]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  write(root, 'sessions/run-abc12345.json', session('run-abc12345', {
    messages: [
      { toolCall: { args: { referenceImageIds: [ids[0]] }, result: JSON.stringify({ imageId: ids[1] }) } },
      { tool_calls: [{ function: { name: 'send_image', arguments: JSON.stringify({ imageId: ids[2] }) } }] },
      { toolCall: { result: `错误：超时，imageId=${ids[3]}，确认未收到后可重发` } },
      { tool_calls: [{ function: { arguments: `{"imageId":"${escaped}"}` } }] }
    ],
    sent: [{ type: 'image', imageId: ids[4] }],
    systemPrompt: `原图 ${ids[5].toUpperCase()}`
  }));
  const result = inspect(root);
  assert.equal(result.complete, true);
  assert.deepEqual([...result.imageIds].sort(), ids.sort());
  for (const sources of result.references.values()) assert.equal(sources[0].chatKey, 'group:1');
});

check('已知原子写入临时快照和 BOM 被完整读取', () => {
  const root = fixture(), ids = [randomUUID(), randomUUID()];
  write(root, 'messages/group_2.json.123.tmp', '\uFEFF' + JSON.stringify(chat('group:2', [{ imageId: ids[0] }])));
  write(root, 'sessions/run-12345678.json.456.tmp', session('run-12345678', { sent: [{ imageId: ids[1] }] }));
  const result = inspect(root);
  assert.equal(result.complete, true);
  assert.deepEqual(result.imageIds, new Set(ids));
});

check('损坏、截断或未知文件保留原文中的 ID 并标记不完整', () => {
  const root = fixture(), malformed = randomUUID(), unknown = randomUUID();
  write(root, 'messages/group_1.json', `{"chatKey":"group:1","messages":[{"imageId":"${malformed}`);
  write(root, 'sessions/backup.tmp', `possible imageId=${unknown}`);
  const result = inspect(root);
  assert.equal(result.complete, false);
  assert.deepEqual(result.imageIds, new Set([malformed, unknown]));
  assert.ok(result.issues.some(item => item.reason === 'invalid-json'));
  assert.ok(result.issues.some(item => item.path === 'sessions/backup.tmp' && item.reason === 'unexpected-filename'));
});

check('聊天归属、消息结构、计数器及运行 ID 不合法时拒绝完整性声明', () => {
  const cases = [
    ['messages/group_1.json', chat('private:1'), 'chat-key-mismatch'],
    ['messages/group_1.json', { ...chat(), messages: [null] }, 'invalid-archive-shape'],
    ['messages/group_1.json', { ...chat(), nextLocalId: 0 }, 'invalid-message-counter'],
    ['messages/group_1.json', { ...chat(), chatKey: 'other:1' }, 'invalid-archive-shape'],
    ['sessions/run-12345678.json', session('other-12345678'), 'session-id-mismatch'],
    ['sessions/run-12345678.json', session('run-12345678', { sent: 'unknown' }), 'invalid-session-sent']
  ];
  for (const [file, data, reason] of cases) {
    const root = fixture();
    write(root, file, data);
    const result = inspect(root);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(item => item.reason === reason), JSON.stringify(result.issues));
  }
});

check('符号链接与未知子目录不会被读取或遍历', () => {
  const root = fixture(), outside = fixture(), id = randomUUID();
  const target = write(outside, 'group_1.json', chat('group:1', [{ imageId: id }]));
  fs.mkdirSync(path.join(root, 'messages'));
  fs.symlinkSync(target, path.join(root, 'messages', 'group_1.json'), 'file');
  fs.mkdirSync(path.join(root, 'messages', 'nested'));
  write(root, 'messages/nested/group_2.json', chat('group:2', [{ imageId: id }]));
  fs.symlinkSync(outside, path.join(root, 'sessions'), 'junction');
  const result = inspect(root);
  assert.equal(result.complete, false);
  assert.equal(result.imageIds.size, 0);
  assert.ok(result.issues.some(item => item.path === 'messages/group_1.json' && item.reason === 'symbolic-link'));
  assert.ok(result.issues.some(item => item.path === 'sessions' && item.reason === 'symbolic-link'));
  assert.ok(result.issues.some(item => item.path === 'messages/nested' && item.reason === 'not-a-regular-file'));
});

check('不可读文件按失败关闭处理，不会误判为空历史', () => {
  const root = fixture(), file = write(root, 'messages/group_1.json', chat());
  const originalOpen = fs.openSync;
  fs.openSync = function (target, ...args) {
    if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return originalOpen.call(this, target, ...args);
  };
  try {
    const result = inspect(root);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(item => item.reason === 'unreadable-file:EACCES'));
  } finally { fs.openSync = originalOpen; }
});

check('扫描期间文件变更会失效当前快照', () => {
  const root = fixture(), file = write(root, 'messages/group_1.json', chat());
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    const text = originalRead.call(this, target, ...args);
    if (typeof target === 'number') write(root, 'messages/group_1.json', chat('group:1', [{ imageId: randomUUID() }]));
    return text;
  };
  try {
    const result = inspect(root);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(item => item.path === 'messages/group_1.json' && item.reason === 'changed-during-scan'));
  } finally { fs.readFileSync = originalRead; }
  assert.equal(fs.existsSync(file), true);
});

console.log(`image references: ${count} passed`);
