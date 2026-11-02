import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const IMAGE_ASSET_DIR = path.join(DATA_DIR, 'image-assets');
export const IMAGE_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const IMAGE_STAGING_FORMAT = 'qq-agent-image-staging-v1';
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
}

/** Do not follow a directory entry replaced with a symlink while scanning. */
export function readRegularFile(file, expected, maxBytes = Infinity) {
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > maxBytes) throw new Error('不是独立常规文件，或文件过大');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameFile(expected, fs.fstatSync(fd))) throw new Error('文件在检查期间变化');
    const content = fs.readFileSync(fd);
    if (!sameFile(expected, fs.fstatSync(fd)) || !sameFile(expected, fs.lstatSync(file))) throw new Error('文件在检查期间变化');
    return content;
  } finally { fs.closeSync(fd); }
}
