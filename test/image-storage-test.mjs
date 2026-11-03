import './isolated-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { saveImage, loadImage } from '../src/image-assets.js';
import { generateImage } from '../src/image-generation.js';
import { scanImageStorage, cleanupImageStorage } from '../src/image-storage.js';
import { ChatStore } from '../src/store.js';
import { SendQueue } from '../src/sender.js';
import { buildToolDefs } from '../src/tools.js';

const root = path.join(DATA_DIR, 'image-assets');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C1sAAAAASUVORK5CYII=', 'base64');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.memory.consolidateEnabled = false;
setRuntimeConfig(cfg);
const apply = options => cleanupImageStorage({ enabled: true, dryRun: false, ...options });
const filename = (id, extension) => path.join(root, `${id}.${extension}`);
const tool = name => buildToolDefs().find(item => item.name === name);

function reset() {
  for (const entry of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
}

// Capture bytes and links, not mtimes; dry-run must not create even a temporary
// directory, lock, or report file inside the configured data root.
function snapshot(directory = DATA_DIR) {
  const result = {};
  function visit(current, prefix = '') {
    for (const name of fs.readdirSync(current).sort()) {
      const target = path.join(current, name), key = `${prefix}${name}`;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) result[key] = { link: fs.readlinkSync(target) };
      else if (stat.isDirectory()) { result[`${key}/`] = 'directory'; visit(target, `${key}/`); }
      else result[key] = fs.readFileSync(target).toString('base64');
    }
  }
  visit(directory);
  return result;
}

function writeJson(relative, value) {
  const target = path.join(DATA_DIR, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
  return target;
}

function metadata(chatKey = 'group:1', imageId = randomUUID()) {
  return { imageId, chatKey, mime: 'image/png', bytes: png.length, source: 'generated', createdAt: 1 };
}

function orphan(chatKey = 'group:1') {
  const image = metadata(chatKey);
  writeJson(`image-assets/${image.imageId}.json`, image);
  return image;
}

function staging(chatKey = 'group:1') {
  const image = metadata(chatKey), directory = path.join(root, `${image.imageId}.tmp`);
  writeJson(`image-assets/${image.imageId}.tmp/manifest.json`, {
    format: 'qq-agent-image-staging-v1', imageId: image.imageId, chatKey, createdAt: 1
  });
  fs.writeFileSync(path.join(directory, 'image.bin'), png);
  fs.writeFileSync(path.join(directory, 'image.json'), JSON.stringify(image));
  return { ...image, directory };
}

function session(id = 'test-run', chatKey = 'group:1', extra = {}) {
  return { id, chatKey, messages: [], sent: [], ...extra };
}

function context(chatKey, store, sender) {
  return { chatKey, store, sender, memory: {}, session: { id: 'test', sent: [], trigger: [] }, emit() {} };
}

function assertKept(image) {
  assert.ok(fs.existsSync(filename(image.imageId, 'json')), image.imageId);
}

let count = 0;
async function check(name, fn) {
  reset();
  await fn();
  console.log(`✓ ${++count}. ${name}`);
}

await check('空目录统计和默认清理调用完全只读', () => {
  const before = snapshot();
  const report = scanImageStorage();
  assert.equal(report.dryRun, true);
  assert.equal(report.totals.files, 0);
  assert.equal(report.totals.bytes, 0);
  assert.equal(report.summary.candidateFiles, 0);
  assert.equal(cleanupImageStorage().dryRun, true);
  assert.deepEqual(snapshot(), before);
});

await check('统计真实文件字节；完整未引用图片不因年龄或来源被删除', () => {
  const images = ['generated', 'message', 'web', 'edited'].map(source => saveImage('group:1', png, source));
  for (const image of images) {
    const data = JSON.parse(fs.readFileSync(filename(image.imageId, 'json'), 'utf8'));
    data.createdAt = 1;
    fs.writeFileSync(filename(image.imageId, 'json'), JSON.stringify(data));
  }
  const metadataBytes = images.reduce((sum, image) => sum + fs.statSync(filename(image.imageId, 'json')).size, 0);
  const report = scanImageStorage();
  assert.equal(report.totals.completeImages, images.length);
  assert.equal(report.totals.files, images.length * 2);
  assert.equal(report.totals.imageBytes, images.length * png.length);
  assert.equal(report.totals.metadataBytes, metadataBytes);
  assert.equal(report.totals.bytes, images.length * png.length + metadataBytes);
  assert.equal(report.summary.candidateFiles, 0);
  const before = snapshot();
  const result = apply();
  assert.equal(result.removed.length, 0);
  assert.deepEqual(snapshot(), before);
  for (const image of images) assert.deepEqual(loadImage('group:1', image.imageId).buffer, png);
});

await check('孤儿元数据进入候选；默认、dry-run、单独启用均不删除', () => {
  const image = orphan();
  const before = snapshot(), bytes = fs.statSync(filename(image.imageId, 'json')).size;
  const report = scanImageStorage();
  assert.equal(report.references.complete, true);
  assert.equal(report.summary.candidateFiles, 1);
  assert.equal(report.summary.candidateBytes, bytes);
  for (const options of [{}, { enabled: true }, { dryRun: true }, { enabled: true, dryRun: true }]) {
    assert.equal(cleanupImageStorage(options).dryRun, true);
    assert.deepEqual(snapshot(), before);
  }
  for (const enabled of [undefined, false, 'true', 1]) {
    assert.throws(() => cleanupImageStorage({ enabled, dryRun: false }));
    assert.deepEqual(snapshot(), before);
  }
});

await check('显式清理仅删除确定的孤儿元数据，重复执行幂等', () => {
  const image = orphan();
  const bytes = fs.statSync(filename(image.imageId, 'json')).size;
  const result = apply();
  assert.equal(result.dryRun, false);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removedBytes, bytes);
  assert.equal(fs.existsSync(filename(image.imageId, 'json')), false);
  const second = apply();
  assert.equal(second.removed.length, 0);
  assert.equal(second.removedBytes, 0);
});

await check('完整聊天存档中的旧引用保护缺失二进制的元数据', () => {
  const image = orphan(), store = new ChatStore(1);
  store.appendSelf('group:1', { mid: 1, text: `[图片:${image.imageId}]`, media: [{ kind: 'image', imageId: image.imageId }] });
  for (let i = 2; i <= 100; i++) store.appendSelf('group:1', { mid: i, text: `newer ${i}` });
  store.close();
  const report = apply();
  assert.equal(report.references.complete, true);
  assert.equal(report.removed.length, 0);
  assertKept(image);
});

await check('其他会话中的引用同样保护资源，不能借会话过滤绕过引用', () => {
  const image = orphan('group:1');
  const store = new ChatStore();
  store.appendSelf('private:1', { text: 'foreign diagnostic reference', media: [{ kind: 'image', imageId: image.imageId }] });
  store.close();
  const report = apply({ chatKey: 'group:1' });
  assert.equal(report.removed.length, 0);
  assertKept(image);
});

await check('编辑参数、嵌套 JSON、失败重发文字和 sent 中的会话引用均保留', () => {
  const images = Array.from({ length: 5 }, () => orphan());
  writeJson('sessions/test-run.json', session('test-run', 'group:1', {
    messages: [
      { role: 'assistant', tool_calls: [{ function: { arguments: JSON.stringify({ referenceImageIds: [images[0].imageId] }) } }] },
      { toolCall: { args: { referenceImageIds: [images[1].imageId] }, result: JSON.stringify({ imageId: images[2].imageId }) } },
      { role: 'tool', content: `发送超时；图片已保存，imageId=${images[3].imageId}，可重发` }
    ],
    sent: [{ type: 'image', imageId: images[4].imageId }]
  }));
  const report = apply();
  assert.equal(report.references.complete, true);
  assert.equal(report.removed.length, 0);
  for (const image of images) assertKept(image);
});

await check('编辑图片的持久化来源关系在会话日志缺失时仍保护参考图', () => {
  const reference = saveImage('group:1', png, 'message');
  const derived = saveImage('group:1', png, 'edited', { referenceImageIds: [reference.imageId] });
  assert.deepEqual(loadImage('group:1', derived.imageId).referenceImageIds, [reference.imageId]);
  fs.unlinkSync(filename(reference.imageId, 'bin'));
  assert.equal(apply().removed.length, 0);
  assertKept(reference);
  assert.deepEqual(loadImage('group:1', derived.imageId).buffer, png);
});

await check('消息与会话的原子写入临时快照也是引用根', () => {
  const messageImage = orphan(), sessionImage = orphan();
  writeJson('messages/group_1.json.123.tmp', {
    chatKey: 'group:1', nextLocalId: 2,
    messages: [{ id: 1, text: messageImage.imageId }]
  });
  writeJson('sessions/test-run.json.456.tmp', session('test-run', 'group:1', {
    messages: [{ role: 'tool', content: sessionImage.imageId }]
  }));
  const report = apply();
  assert.equal(report.references.complete, true);
  assert.equal(report.removed.length, 0);
  assertKept(messageImage);
  assertKept(sessionImage);
});

await check('清理重新扫描引用，dry-run 后新增的记录使候选失效', () => {
  const image = orphan();
  assert.equal(scanImageStorage().summary.candidateFiles, 1);
  const store = new ChatStore();
  store.appendSelf('group:1', { text: `recovered reference ${image.imageId}` });
  store.close();
  const result = apply();
  assert.equal(result.removed.length, 0);
  assertKept(image);
});

await check('可识别暂存事务按文件真实大小统计，预览不改动，显式清理移除残留', () => {
  const image = staging();
  const files = fs.readdirSync(image.directory);
  const bytes = files.reduce((sum, name) => sum + fs.statSync(path.join(image.directory, name)).size, 0);
  const before = snapshot(), report = scanImageStorage();
  assert.equal(report.summary.candidateFiles, files.length);
  assert.equal(report.summary.candidateBytes, bytes);
  assert.equal(report.totals.temporaryBytes, bytes);
  assert.deepEqual(snapshot(), before);
  const result = apply();
  assert.equal(result.removedBytes, bytes);
  assert.equal(fs.existsSync(image.directory), false);
  assert.equal(apply().removed.length, 0);
});

await check('发布中断留下的正式文件与暂存同伴一起保留供恢复', () => {
  for (const published of ['bin', 'json']) {
    reset();
    const image = staging();
    fs.renameSync(path.join(image.directory, `image.${published}`), filename(image.imageId, published));
    const before = snapshot(), report = apply();
    assert.equal(report.removed.length, 0);
    assert.deepEqual(snapshot(), before);
    assert.ok(fs.existsSync(filename(image.imageId, published)));
    assert.ok(fs.existsSync(path.join(image.directory, published === 'bin' ? 'image.json' : 'image.bin')));
  }
});

await check('大小恰好匹配的正式 BIN 符号链接不能替代唯一的暂存图片字节', () => {
  const image = staging();
  fs.copyFileSync(path.join(image.directory, 'image.json'), filename(image.imageId, 'json'));
  // lstat.size describes the link text, not an actual image. Its matching size
  // must not make this damaged publication count as a safe replacement.
  fs.symlinkSync('x'.repeat(png.length), filename(image.imageId, 'bin'), 'file');
  assert.equal(fs.lstatSync(filename(image.imageId, 'bin')).size, image.bytes);
  const before = snapshot(), report = apply();
  assert.equal(report.removed.length, 0);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(fs.readFileSync(path.join(image.directory, 'image.bin')), png);
});

await check('正式图片已保存时暂存清理失败仍返回可复用的 ID', () => {
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function (target, ...args) {
    if (String(target).endsWith(`${path.sep}manifest.json`)) {
      throw Object.assign(new Error('simulated staging cleanup failure'), { code: 'EACCES' });
    }
    return originalUnlink.call(this, target, ...args);
  };
  let image;
  try { image = saveImage('group:1', png, 'generated'); }
  finally { fs.unlinkSync = originalUnlink; }
  assert.ok(image.imageId);
  assert.deepEqual(loadImage('group:1', image.imageId).buffer, png);
  const directory = path.join(root, `${image.imageId}.tmp`);
  assert.ok(fs.existsSync(path.join(directory, 'manifest.json')));
  const report = apply();
  assert.equal(report.removed.length, 1);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(loadImage('group:1', image.imageId).buffer, png);
});

await check('有引用的暂存事务保留，未知临时文件和额外内容不按扩展名清理', () => {
  const referenced = staging(), unknown = staging();
  const store = new ChatStore();
  store.appendSelf('group:1', { text: referenced.imageId });
  store.close();
  fs.writeFileSync(path.join(unknown.directory, 'do-not-delete.txt'), 'unexpected');
  fs.writeFileSync(path.join(root, 'legacy.tmp'), 'not application-owned');
  fs.mkdirSync(path.join(root, `${randomUUID()}.tmp`));
  const before = snapshot();
  const result = apply();
  assert.equal(result.removed.length, 0);
  assert.deepEqual(snapshot(), before);
});

await check('无元数据二进制、损坏和 ID 错配元数据均保留', () => {
  fs.mkdirSync(root, { recursive: true });
  const binaryId = randomUUID(), brokenId = randomUUID(), mismatchId = randomUUID();
  fs.writeFileSync(filename(binaryId, 'bin'), png);
  fs.writeFileSync(filename(brokenId, 'json'), '{truncated');
  fs.writeFileSync(filename(mismatchId, 'json'), JSON.stringify(metadata('group:1')));
  const before = snapshot(), report = apply();
  assert.equal(report.removed.length, 0);
  assert.deepEqual(snapshot(), before);
  assert.ok(report.summary.unknownFiles > 0);
});

await check('截断的暂存编辑元数据不能让其参考图的孤儿元数据被误删', () => {
  const reference = orphan(), staged = staging();
  fs.writeFileSync(path.join(staged.directory, 'image.json'), `{"referenceImageIds":["${reference.imageId}"]`);
  const before = snapshot(), report = apply();
  assert.equal(report.references.complete, false);
  assert.ok(report.blockers.length > 0);
  assert.equal(report.removed.length, 0);
  assert.deepEqual(snapshot(), before);
  assertKept(reference);
});

await check('损坏资源元数据中的转义参考 ID 不会被误判为无引用', () => {
  for (const truncated of [false, true]) {
    reset();
    const reference = orphan(), broken = metadata();
    const escapedId = reference.imageId.replace(/[a-f0-9]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const text = JSON.stringify({ ...broken, bytes: 0, referenceImageIds: [reference.imageId] }).replace(reference.imageId, escapedId);
    fs.writeFileSync(filename(broken.imageId, 'json'), truncated ? text.slice(0, -1) : text);
    const before = snapshot(), report = apply();
    assert.equal(report.references.complete, false);
    assert.ok(report.blockers.length > 0);
    assert.equal(report.removed.length, 0);
    assert.deepEqual(snapshot(), before);
    assertKept(reference);
  }
});

await check('暂存目录归属不明或出现未知内容时阻止其他候选删除', () => {
  for (const kind of ['missing-marker', 'broken-marker', 'unknown-child']) {
    reset();
    const reference = orphan('group:1'), staged = staging('private:2');
    if (kind === 'missing-marker') fs.unlinkSync(path.join(staged.directory, 'manifest.json'));
    if (kind === 'broken-marker') fs.writeFileSync(path.join(staged.directory, 'manifest.json'), '{incomplete');
    if (kind === 'unknown-child') fs.writeFileSync(path.join(staged.directory, 'unknown.json'), JSON.stringify({ imageId: reference.imageId }));
    const before = snapshot(), report = apply({ chatKey: 'group:1' });
    assert.equal(report.references.complete, false);
    assert.ok(report.blockers.length > 0);
    assert.equal(report.removed.length, 0);
    assert.deepEqual(snapshot(), before);
    assertKept(reference);
  }
});

await check('精确会话范围隔离 group/private；无法归属的文件不进入会话清理', () => {
  const groupImage = orphan('group:1'), privateImage = orphan('private:1');
  const groupStage = staging('group:1'), privateStage = staging('private:1');
  const unknownId = randomUUID();
  fs.writeFileSync(filename(unknownId, 'bin'), png);
  const report = scanImageStorage({ chatKey: 'group:1' });
  assert.equal(report.scope, 'group:1');
  assert.equal(report.summary.candidateFiles, 4);
  apply({ chatKey: 'group:1' });
  assert.equal(fs.existsSync(filename(groupImage.imageId, 'json')), false);
  assert.equal(fs.existsSync(groupStage.directory), false);
  assertKept(privateImage);
  assert.ok(fs.existsSync(privateStage.directory));
  assert.ok(fs.existsSync(filename(unknownId, 'bin')));
  for (const chatKey of ['group:0', 'group:1/../../private:1', 'GROUP:1', 'private:', '', 1]) {
    assert.throws(() => scanImageStorage({ chatKey }));
  }
});

await check('损坏、格式未知或归属错误的历史使清理安全停止', () => {
  for (const archive of ['{broken', '{}', JSON.stringify({ chatKey: 'private:1', nextLocalId: 1, messages: [] })]) {
    reset();
    const image = orphan(), staged = staging();
    fs.mkdirSync(path.join(DATA_DIR, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'messages', 'group_1.json'), archive);
    const before = snapshot(), report = apply();
    assert.equal(report.references.complete, false);
    assert.equal(report.removed.length, 0);
    assert.deepEqual(snapshot(), before);
    assertKept(image);
    assert.ok(fs.existsSync(staged.directory));
  }
});

await check('符号链接不被跟随或清除，引用目录中的链接使盘点不完整', () => {
  const image = orphan(), staged = staging();
  const outside = path.join(DATA_DIR, 'outside');
  fs.writeFileSync(outside, 'valuable external bytes');
  fs.symlinkSync(outside, filename(randomUUID(), 'json'));
  fs.unlinkSync(path.join(staged.directory, 'image.bin'));
  fs.symlinkSync(outside, path.join(staged.directory, 'image.bin'));
  const messages = path.join(DATA_DIR, 'messages');
  fs.mkdirSync(messages);
  fs.symlinkSync(outside, path.join(messages, 'group_1.json'));
  const before = snapshot(), report = apply();
  assert.equal(report.references.complete, false);
  assert.equal(report.removed.length, 0);
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'valuable external bytes');
  assertKept(image);
});

await check('现有维护锁不按年龄抢占；预览无写入，清理不触碰候选', () => {
  const image = orphan();
  const lock = path.join(DATA_DIR, 'image-storage.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, createdAt: 1 }));
  fs.utimesSync(lock, new Date(1), new Date(1));
  const before = snapshot();
  scanImageStorage();
  assert.deepEqual(snapshot(), before);
  assert.throws(() => apply());
  assert.deepEqual(snapshot(), before);
  assertKept(image);
});

await check('历史读图和重新导入在清理后仍复用同一个 imageId，并保持会话隔离', async () => {
  const image = saveImage('group:1', png, 'generated'), store = new ChatStore();
  store.appendSelf('group:1', { mid: 42, text: `[图片:${image.imageId}]`, media: [{ kind: 'image', imageId: image.imageId }] });
  store.close();
  orphan();
  apply();
  const ctx = context('group:1', store);
  const read = await tool('get_message_images').execute(ctx, { messageId: 42 });
  assert.ok(!read.isError, JSON.stringify(read));
  assert.equal(read.content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  const imported = await tool('import_image').execute(ctx, { messageId: 42 });
  assert.ok(!imported.isError, imported.content);
  assert.equal(JSON.parse(imported.content).imageId, image.imageId);
  assert.throws(() => loadImage('private:1', image.imageId));
  const foreign = await tool('inspect_image').execute(context('private:1', store), { imageId: image.imageId });
  assert.equal(foreign.isError, true);
});

await check('发送失败后的资源经清理仍可用原 ID 重发，不触发生图', async () => {
  const image = saveImage('private:1', png, 'generated'); let store = new ChatStore();
  let attempts = 0;
  const sender = new SendQueue({ store, onebot: {
    canReadLocalImageFiles: true,
    async sendImage(kind, id, source) {
      assert.equal(kind, 'private'); assert.equal(id, '1');
      assert.deepEqual(fs.readFileSync(fileURLToPath(source)), png);
      if (++attempts === 1) throw new Error('delivery result unknown');
      return { message_id: 123 };
    }
  } });
  const ctx = context('private:1', store, sender);
  const failed = await tool('send_image').execute(ctx, { imageId: image.imageId });
  assert.equal(failed.isError, true);
  assert.ok(failed.content.includes(image.imageId));
  assert.equal(store.recent('private:1').length, 0);
  store.close();
  assert.equal(apply().removed.length, 0);
  store = new ChatStore(); sender.store = store; ctx.store = store;
  const retried = await tool('send_image').execute(ctx, { imageId: image.imageId });
  assert.ok(!retried.isError, retried.content);
  assert.equal(JSON.parse(retried.content).imageId, image.imageId);
  assert.equal(attempts, 2);
  assert.equal(store.recent('private:1')[0].media[0].imageId, image.imageId);
});

await check('排队中和协议端尚在读取图片时拒绝在线清理，发送继续落盘', async () => {
  const first = saveImage('group:1', png, 'generated'), queued = saveImage('group:1', png, 'web');
  const store = new ChatStore();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const sender = new SendQueue({ store, onebot: {
    canReadLocalImageFiles: true,
    async sendImage(_kind, _id, source) {
      const call = ++calls;
      if (call === 1) { entered(); await held; }
      // Mimic the external protocol process opening the local file after GC.
      assert.deepEqual(fs.readFileSync(fileURLToPath(source)), png);
      return { message_id: call };
    }
  } });
  const sending = sender.sendImage('group:1', first.imageId);
  const pending = sender.sendImage('group:1', queued.imageId);
  try {
    await waiting;
    assert.equal(calls, 1);
    assert.equal(store.recent('group:1').length, 0);
    const report = apply();
    assert.equal(report.removed.length, 0);
    assert.equal(report.skipped, true);
    assert.ok(report.blockers.some(b => b.path.startsWith('archive-writers/')));
    assert.deepEqual(loadImage('group:1', queued.imageId).buffer, png);
  } finally { release(); }
  await Promise.all([sending, pending]);
  assert.equal(store.recent('group:1').length, 2);
  assert.deepEqual(store.recent('group:1').map(entry => entry.media[0].imageId), [first.imageId, queued.imageId]);
});

await check('正在编辑且尚未写入会话日志的参考图在清理后继续可读和复用', async () => {
  const reference = saveImage('group:1', png, 'message');
  const originalFetch = globalThis.fetch;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (endpoint, options) => {
    assert.ok(endpoint.endsWith('/images/edits'));
    assert.deepEqual(JSON.parse(options.body).images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }]);
    entered();
    await held;
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  };
  const editing = generateImage('group:1', 'change the color', { referenceImageIds: [reference.imageId] });
  try {
    await waiting;
    assert.equal(apply().removed.length, 0);
    assert.deepEqual(loadImage('group:1', reference.imageId).buffer, png);
    release();
    const result = await editing;
    assert.equal(result.mode, 'edit');
    assert.deepEqual(result.referenceImageIds, [reference.imageId]);
    assert.notEqual(result.imageId, reference.imageId);
    assert.equal(apply().removed.length, 0);
    assert.deepEqual(loadImage('group:1', result.imageId).buffer, png);
    assert.deepEqual(loadImage('group:1', reference.imageId).buffer, png);
  } finally {
    release();
    globalThis.fetch = originalFetch;
    await editing.catch(() => {});
  }
});

await check('CLI 默认只预览；执行必须显式同时启用与 apply，矛盾参数拒绝', () => {
  const image = orphan();
  const script = fileURLToPath(new URL('../scripts/image-storage.mjs', import.meta.url));
  const run = args => execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, QQ_AGENT_DATA_DIR: DATA_DIR }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  const before = snapshot();
  assert.equal(JSON.parse(run(['--json'])).dryRun, true);
  assert.equal(JSON.parse(run(['--dry-run', '--json'])).dryRun, true);
  for (const args of [['--apply'], ['--enable-cleanup'], ['--enable-cleanup', '--apply', '--dry-run'], ['--unknown']]) {
    assert.throws(() => run(args));
    assert.deepEqual(snapshot(), before);
  }
  const report = JSON.parse(run(['--enable-cleanup', '--apply', '--json']));
  assert.equal(report.dryRun, false);
  assert.equal(report.removed.length, 1);
  assert.equal(fs.existsSync(filename(image.imageId, 'json')), false);
});

console.log(`\nImage storage regression tests: ${count} passed.`);
