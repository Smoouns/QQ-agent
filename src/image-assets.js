import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertImageChat } from './image-config.js';
import { safeFetchBinary } from './safe-fetch.js';
import { IMAGE_ASSET_DIR, IMAGE_ID_RE, IMAGE_STAGING_FORMAT, MAX_IMAGE_BYTES } from './image-asset-files.js';
import { withImageStorageLock } from './image-storage-lock.js';

export { MAX_IMAGE_BYTES };
const root = IMAGE_ASSET_DIR;

export function imageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_IMAGE_BYTES) throw new Error('图片为空、过小或超过 12 MiB');
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('内容不是支持的图片（PNG/JPEG/GIF/WebP）');
}

export function decodeImage(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('生图返回的 Base64 无效或过大');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.toString('base64') !== encoded) throw new Error('生图返回的 Base64 无效');
  imageMime(buffer);
  return buffer;
}

export function saveImage(chatKey, buffer, source, { referenceImageIds = [] } = {}) {
  assertImageChat(chatKey);
  const mime = imageMime(buffer), imageId = randomUUID();
  if (!Array.isArray(referenceImageIds) || referenceImageIds.length > 4 || new Set(referenceImageIds).size !== referenceImageIds.length) throw new Error('参考图 ID 无效');
  for (const id of referenceImageIds) loadImage(chatKey, id);
  const metadata = { imageId, chatKey, mime, bytes: buffer.length, source, createdAt: Date.now(),
    ...(referenceImageIds.length ? { referenceImageIds: [...referenceImageIds] } : {}) };
  return withImageStorageLock(() => {
    fs.mkdirSync(root, { recursive: true });
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('图片资源目录不是常规目录');
    const staging = path.join(root, `${imageId}.tmp`);
    fs.mkdirSync(staging);
    // A marker, not an age or a .tmp extension, establishes ownership. An
    // interrupted write is left intact for explicit, reference-aware cleanup.
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
      format: IMAGE_STAGING_FORMAT, imageId, chatKey, createdAt: metadata.createdAt
    }), { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'image.bin'), buffer, { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'image.json'), JSON.stringify(metadata), { flag: 'wx' });
    // Cooperating writers hold the same lock. Check both destinations before
    // atomic publication; do not replace an existing UUID even on collision.
    for (const extension of ['bin', 'json']) {
      try {
        fs.lstatSync(path.join(root, `${imageId}.${extension}`));
        throw new Error('图片 ID 已存在，拒绝覆盖');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Publish metadata last. Readers never see a partial JSON file. Renames
    // also work on filesystems without hard-link support.
    fs.renameSync(path.join(staging, 'image.bin'), path.join(root, `${imageId}.bin`));
    fs.renameSync(path.join(staging, 'image.json'), path.join(root, `${imageId}.json`));
    // Once committed, a housekeeping failure must not hide the reusable ID
    // from the caller (especially for a paid generation). Retain residue.
    try {
      fs.unlinkSync(path.join(staging, 'manifest.json'));
      fs.rmdirSync(staging);
    } catch { /* explicit maintenance can inspect the leftover staging dir */ }
    return metadata;
  }, { waitMs: 5000 });
}

export function loadImage(chatKey, imageId) {
  assertImageChat(chatKey);
  if (typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) throw new Error('图片 ID 无效');
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(path.join(root, `${imageId}.json`), 'utf8')); }
  catch { throw new Error('图片不存在'); }
  if (metadata.chatKey !== chatKey || metadata.imageId !== imageId) throw new Error('不能使用其他会话的图片');
  const file = path.join(root, `${imageId}.bin`);
  if (fs.statSync(file).size > MAX_IMAGE_BYTES) throw new Error('图片超过 12 MiB');
  const buffer = fs.readFileSync(file);
  return { ...metadata, mime: imageMime(buffer), buffer, fileUrl: pathToFileURL(file).href };
}

export async function downloadImage(url) {
  // 新通用工具不继承旧表情/看图工具的 allowPrivateImageHosts 例外。
  const { buffer } = await safeFetchBinary(url, MAX_IMAGE_BYTES, { allowPrivate: false });
  imageMime(buffer);
  return buffer;
}
