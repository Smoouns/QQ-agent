import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { withImageStorageLock } from './image-storage-lock.js';

const directory = path.join(DATA_DIR, 'archive-writers');
const leases = new Set();
process.once('exit', () => {
  for (const lease of leases) {
    try { lease.close(); } catch { /* Keep an uncertain lease: maintenance must fail closed. */ }
  }
});

// Register before accepting messages, never after a network side effect. The
// short registration shares GC's lock; ordinary archive writes do not need it.
export function acquireArchiveWriter(kind) {
  return withImageStorageLock(() => {
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('存档写入者登记目录不是常规目录');
    const file = path.join(directory, `${process.pid}-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, kind, createdAt: Date.now() }), { flag: 'wx' });
    const owned = fs.lstatSync(file);
    let closed = false;
    const lease = {
      assertOpen() { if (closed) throw new Error('存档存储已关闭，不能继续写入'); },
      close() {
        if (closed) return;
        try {
          const current = fs.lstatSync(file);
          if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('存档写入者登记文件发生变化，拒绝移除');
          fs.unlinkSync(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        closed = true; leases.delete(lease);
      }
    };
    leases.add(lease);
    return lease;
  });
}

// Do not expire leases by age or PID. A crashed writer may have an in-flight
// snapshot; require the operator to stop all writers and inspect the data.
export function archiveWriterBlockers() {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [{ path: 'archive-writers', reason: '存档写入者登记目录异常，禁止清理' }];
    return fs.readdirSync(directory).map(name => ({ path: `archive-writers/${name}`,
      reason: '存在运行中或遗留的存档写入者；图片清理仅允许离线执行，请先停止共享此目录的全部应用' }));
  } catch (error) {
    return error.code === 'ENOENT' ? [] : [{ path: 'archive-writers', reason: error.code || error.message }];
  }
}
