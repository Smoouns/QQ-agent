import './isolated-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { DATA_DIR } from '../src/config.js';
import { ChatStore } from '../src/store.js';
import { SessionRegistry } from '../src/sessions.js';
import { SendQueue } from '../src/sender.js';
import { saveImage } from '../src/image-assets.js';
import { scanImageStorage, cleanupImageStorage } from '../src/image-storage.js';
import { archiveWriterBlockers } from '../src/archive-writer-lease.js';

let count = 0;
const check = async (name, fn) => { await fn(); console.log(`✓ ${++count}. ${name}`); };
const json = relative => JSON.parse(fs.readFileSync(path.join(DATA_DIR, relative), 'utf8'));
const apply = () => cleanupImageStorage({ enabled: true, dryRun: false });
const child = code => spawn(process.execPath, ['--input-type=module', '-e', code], {
  cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=', 'base64');
const store = new ChatStore(), sessions = new SessionRegistry();
const s = sessions.create({ chatKey: 'private:123', trigger: [], triggerSummary: 'fixture' });
const waiting = sessions.create({ chatKey: 'private:456', trigger: [], status: 'waiting' });
const image = saveImage('private:123', png, 'test');
let textSends = 0, imageSends = 0;
const sender = new SendQueue({ store, onebot: {
  async sendText() { textSends++; return { message_id: 42 }; },
  async sendImage() { imageSends++; return { message_id: 43 }; }
} });

// Hold the actual cross-process lock beyond the former five-second timeout.
// Existing writers must persist normally; a new writer must fail at startup.
const holder = child(`
  import { withImageStorageLock } from './src/image-storage-lock.js';
  withImageStorageLock(() => {
    process.stdout.write('locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
  });
`);
const holderExit = once(holder, 'exit');
await once(holder.stdout, 'data');
try {
  await check('长时间持锁仍立即保存入站消息，事件循环不等待五秒', async () => {
    const start = Date.now();
    store.appendIncoming('private:123', { mid: 1, senderId: '123', text: 'incoming fixture' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(Date.now() - start < 1500, '维护锁不应阻塞普通消息写入/计时器');
    assert.equal(json('messages/private_123.json').messages[0].text, 'incoming fixture');
    assert.equal(holder.exitCode, null, '断言时另一个进程仍持有锁');
  });
  await check('QQ 确认发送的文字和图片正确报告成功并落盘，不误报或重发', async () => {
    const text = await sender.sendTextBatch('private:123', ['delivered fixture']);
    assert.equal(text.sent.length, 1); assert.equal(text.failed.length, 0);
    const sentImage = await sender.sendImage('private:123', image.imageId);
    assert.equal(sentImage.message_id, 43); assert.equal(textSends, 1); assert.equal(imageSends, 1);
    const saved = json('messages/private_123.json').messages;
    assert.equal(saved.length, 3); assert.equal(saved[1].mid, 42);
    assert.equal(saved[2].media[0].imageId, image.imageId);
  });
  await check('持锁时结束会话和 token 汇总完整持久化，丢弃等待会话不残留', () => {
    s.usage.totalTokens = 1234; s.usage.promptTokens = 1000; s.usage.completionTokens = 234;
    sessions.finish(s.id, 'done');
    assert.equal(json(`sessions/${s.id}.json`).status, 'done');
    assert.equal(json(`sessions/${s.id}.json`).usage.totalTokens, 1234);
    assert.equal(json('usage-today.json').totalTokens, 1234);
    assert.equal(json('usage-today.json').runs, 1);
    assert.equal(sessions.discard(waiting.id), true);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'sessions', waiting.id + '.json')), false);
  });
  await check('维护已经先开始时，新存储在接收消息前快速拒绝启动且不留下登记', () => {
    const before = archiveWriterBlockers().length, start = Date.now();
    assert.throws(() => new ChatStore(), /图片存储正在/);
    assert.throws(() => new SessionRegistry(), /图片存储正在/);
    assert.ok(Date.now() - start < 1500);
    assert.equal(archiveWriterBlockers().length, before);
  });
} finally {
  // Always wait for the holder to release its own lock, even on assertion failure.
  await holderExit;
}

await check('应用存储仍打开时，CLI 拒绝在线清理且原候选文件保持不变', () => {
  const unused = saveImage('private:999', png, 'test');
  fs.unlinkSync(path.join(DATA_DIR, 'image-assets', unused.imageId + '.bin'));
  let result;
  try { execFileSync(process.execPath, ['scripts/image-storage.mjs', '--enable-cleanup', '--apply', '--json'], { env: process.env, encoding: 'utf8', windowsHide: true }); }
  catch (error) { assert.equal(error.status, 2); result = JSON.parse(error.stdout); }
  assert.equal(result?.skipped, true); assert.equal(result.removed.length, 0);
  assert.ok(result.blockers.some(b => b.path.startsWith('archive-writers/')));
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'image-assets', unused.imageId + '.json')), true);
  const before = fs.readdirSync(path.join(DATA_DIR, 'archive-writers'));
  assert.equal(scanImageStorage().totals.completeImages, 1);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, 'archive-writers')), before);
});
await check('每个写入者独立登记，全部关闭后才可清理，关闭后的实例禁止再次写入', () => {
  store.close(); store.close();
  assert.equal(apply().skipped, true); // sessions is still open.
  sessions.close(); sessions.close();
  assert.equal(archiveWriterBlockers().length, 0);
  assert.throws(() => store.appendSelf('private:123', { text: 'late write' }), /已关闭/);
  assert.throws(() => sessions.create({ chatKey: 'private:123' }), /已关闭/);
  const report = apply(); assert.equal(report.blockers.length, 0); assert.equal(report.removed.length, 1);
  assert.equal(apply().removed.length, 0);
  const reopened = new ChatStore();
  assert.equal(reopened.recent('private:123').length, 3); reopened.close();
});
await check('正常进程退出释放登记，异常退出的登记不按 PID 或年龄自动删除', async () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', "import { ChatStore } from './src/store.js'; new ChatStore();"], { env: process.env, windowsHide: true });
  assert.equal(archiveWriterBlockers().length, 0);
  const crashed = child("import { ChatStore } from './src/store.js'; new ChatStore(); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
  const exited = once(crashed, 'exit');
  await once(crashed.stdout, 'data'); crashed.kill('SIGKILL'); await exited;
  assert.ok(archiveWriterBlockers().length > 0); assert.equal(apply().skipped, true);
  // Stale leases block deletion only, never normal startup or message persistence.
  const next = new ChatStore(); next.appendIncoming('private:777', { senderId: '777', text: 'still works' });
  assert.equal(json('messages/private_777.json').messages.length, 1); next.close();
});
console.log(`\n${count} archive writer checks passed`);
