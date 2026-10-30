import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';
import { assertImageChat, normalizeImageConfig } from './image-config.js';

export function imageBudgetDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function budget(chatKey, now) {
  assertImageChat(chatKey);
  const c = normalizeImageConfig(getConfig().imageGeneration);
  const date = imageBudgetDate(now);
  const limit = c.chatDailyLimits[chatKey] ?? c.dailyLimit;
  const dir = path.join(DATA_DIR, 'image-budget', date, createHash('sha256').update(chatKey).digest('hex'));
  return { date, limit, dir };
}

export function imageBudgetStatus(chatKey, now = Date.now()) {
  const { date, limit, dir } = budget(chatKey, now);
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const used = files.filter((f) => /^[1-9]\d*\.json$/.test(f)).length;
  return { date, timezone: 'Asia/Shanghai', limit, used, remaining: Math.max(0, limit - used) };
}

export function reserveImageAttempt(chatKey, now = Date.now()) {
  const { limit, dir } = budget(chatKey, now);
  fs.mkdirSync(dir, { recursive: true });
  // 每个名额通过 wx 独占创建。多进程并发、重启和未知请求结果都不会重复使用名额。
  for (let i = 1; i <= limit; i++) {
    let fd;
    try { fd = fs.openSync(path.join(dir, `${i}.json`), 'wx'); }
    catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try { fs.writeFileSync(fd, JSON.stringify({ chatKey, requestedAt: now })); }
    finally { fs.closeSync(fd); }
    return imageBudgetStatus(chatKey, now);
  }
  throw new Error(`当前会话今日生图预算已用完（${limit} 次；北京时间零点重置）`);
}
