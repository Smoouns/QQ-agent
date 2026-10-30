import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from './config.js';
import { assertImageChat } from './image-config.js';
import { safeFetchBinary } from './safe-fetch.js';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const root = path.join(DATA_DIR, 'image-assets');

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

export function saveImage(chatKey, buffer, source) {
  assertImageChat(chatKey);
  const mime = imageMime(buffer), imageId = randomUUID();
  const metadata = { imageId, chatKey, mime, bytes: buffer.length, source, createdAt: Date.now() };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${imageId}.bin`), buffer, { flag: 'wx' });
  fs.writeFileSync(path.join(root, `${imageId}.json`), JSON.stringify(metadata), { flag: 'wx' });
  return metadata;
}

export function loadImage(chatKey, imageId) {
  assertImageChat(chatKey);
  if (typeof imageId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(imageId)) throw new Error('图片 ID 无效');
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
