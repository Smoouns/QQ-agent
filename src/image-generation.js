import { getConfig } from './config.js';
import { imageEndpoint, normalizeImageConfig } from './image-config.js';
import { reserveImageAttempt } from './image-budget.js';
import { decodeImage, loadImage, saveImage, MAX_IMAGE_BYTES } from './image-assets.js';

const active = new Set();
const MAX_RESPONSE_BYTES = 2 * MAX_IMAGE_BYTES;

export async function generateImage(chatKey, prompt, { beforeRequest = () => {}, signal, referenceImageIds = [] } = {}) {
  const c = normalizeImageConfig(getConfig().imageGeneration);
  if (!c.enabled) throw new Error('生图功能已关闭');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('生图描述须为 1–4000 字符');
  if (active.has(chatKey)) throw new Error('当前会话已有生图请求进行中，请等待完成');
  // 所有参考图在扣次前验证；仅接受本会话已导入的资源，不能让上游抓任意 URL。
  if (!Array.isArray(referenceImageIds) || referenceImageIds.length > 4
      || referenceImageIds.some(id => typeof id !== 'string') || new Set(referenceImageIds).size !== referenceImageIds.length) {
    throw new Error('referenceImageIds 须为最多 4 个不重复的图片 ID');
  }
  const references = referenceImageIds.map(id => loadImage(chatKey, id));
  if (references.some(image => !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime))) {
    throw new Error('参考图仅支持 PNG/JPEG/WebP，不支持 GIF');
  }
  if (references.reduce((sum, image) => sum + image.buffer.length, 0) > MAX_IMAGE_BYTES) throw new Error('参考图合计不能超过 12 MiB');
  const mode = references.length ? 'edit' : 'generate';
  const endpoint = imageEndpoint(c.baseUrl, references.length ? 'edits' : 'generations');
  const body = JSON.stringify({ prompt: prompt.trim(), n: 1, size: c.size, quality: c.quality,
    ...(c.model ? { model: c.model } : {}),
    ...(references.length ? { images: references.map(image => ({ image_url: `data:${image.mime};base64,${image.buffer.toString('base64')}` })) } : {}) });
  const timeout = AbortSignal.timeout(c.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  requestSignal.throwIfAborted();
  active.add(chatKey);
  try {
    beforeRequest();
    const budget = reserveImageAttempt(chatKey);
    let response;
    try {
      // 固定单张，参数来自控制台，不接受模型提高 n、尺寸、质量或每日次数。
      response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
        body
      });
    } catch {
      throw new Error(requestSignal.aborted ? '生图已取消或超时，本次名额已计入；请勿自动重试' : '生图连接失败，本次名额已计入；请检查 OpenCodex，勿自动重试');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`生图接口 HTTP ${response.status}，本次名额已计入；请检查 OpenCodex 的生图权限和模型配置`);
    }
    if (!response.body) throw new Error('生图接口返回空响应，本次名额已计入');
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new Error('生图响应过大');
        chunks.push(value);
      }
    } catch (e) {
      throw new Error(requestSignal.aborted ? '生图响应读取超时或已取消，本次名额已计入' : `生图响应读取失败：${e.message}`);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('生图接口返回了无效 JSON，本次名额已计入'); }
    // 不接受模型回复中的链接或本地路径；Images 接口必须返回真实的单张图片字节。
    if (!Array.isArray(result.data) || result.data.length !== 1 || !result.data[0]?.b64_json) throw new Error('生图接口没有返回单张 Base64 图片，本次名额已计入');
    const image = saveImage(chatKey, decodeImage(result.data[0].b64_json), mode === 'edit' ? 'edited' : 'generated');
    return { imageId: image.imageId, mime: image.mime, bytes: image.bytes, mode, referenceImageIds, budget };
  } finally { active.delete(chatKey); }
}
