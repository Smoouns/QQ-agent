import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const IMAGE_STORAGE_LOCK = path.join(DATA_DIR, 'image-storage.lock');
let depth = 0;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Short, synchronous exclusion for image publication, reference snapshots and GC.
 * A crashed owner's lock never expires automatically. Inspect it with the app
 * stopped before manually removing it; age/PID alone cannot prove inactivity.
 */
export function withImageStorageLock(fn, { waitMs = 0 } = {}) {
  if (depth) return fn();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + waitMs;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(IMAGE_STORAGE_LOCK, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('图片存储正在写入或维护（image-storage.lock）；不会自动移除锁，请停止程序并核查后再处理遗留锁');
      Atomics.wait(sleeper, 0, 0, Math.min(20, deadline - Date.now()));
    }
  }
  const owned = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    depth++;
    return fn();
  } finally {
    depth = 0;
    fs.closeSync(fd);
    // Never unlink a lock replaced by an external actor.
    try {
      const current = fs.lstatSync(IMAGE_STORAGE_LOCK);
      if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(IMAGE_STORAGE_LOCK);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
