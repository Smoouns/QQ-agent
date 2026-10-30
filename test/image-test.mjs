import './isolated-env.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { DATA_DIR, DEFAULT_CONFIG, getConfig, setRuntimeConfig } from '../src/config.js';
import { normalizeImageConfig, imageEndpoint } from '../src/image-config.js';
import { imageBudgetDate, imageBudgetStatus, reserveImageAttempt } from '../src/image-budget.js';
import { decodeImage, loadImage, saveImage, imageMime, MAX_IMAGE_BYTES } from '../src/image-assets.js';
import { generateImage } from '../src/image-generation.js';
import { buildToolDefs } from '../src/tools.js';
import { PermissionService } from '../src/permissions.js';
import { SendQueue } from '../src/sender.js';
import { OneBotClient } from '../src/onebot.js';
import { ChatStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C1sAAAAASUVORK5CYII=', 'base64');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.imageGeneration.apiKey = 'image-test-secret';
cfg.api.apiKey = 'chat-test-secret';
cfg.memory.consolidateEnabled = false;
setRuntimeConfig(cfg);
const requests = [], deliveries = [];
const normalHandle = (_req, res) => res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
let handle = normalHandle, deliveryFailure = false;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body || '{}');
  if (['/v1/images/generations', '/v1/images/edits'].includes(req.url)) {
    requests.push({ url: req.url, auth: req.headers.authorization, body: payload });
    handle(req, res);
  } else {
    deliveries.push({ action: req.url, body: payload, bodyBytes: Buffer.byteLength(body) });
    res.end(JSON.stringify(deliveryFailure ? { status: 'failed', retcode: 1 } : { status: 'ok', retcode: 0, data: { message_id: 100 + deliveries.length } }));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
cfg.imageGeneration.baseUrl = base + '/v1';
const store = new ChatStore();
const onebot = new OneBotClient({ httpUrl: base });
const sender = new SendQueue({ onebot, store });
const tool = name => buildToolDefs().find(t => t.name === name);
const makeCtx = chatKey => ({ chatKey, sender, store, memory: {}, session: { id: 'image-test', sent: [], trigger: [] }, emit() {} });
let count = 0, app;
async function check(name, fn) { await fn(); console.log(`✓ ${++count}. ${name}`); }
try {
  await check('多参考图按顺序发送编辑端点，原图保留，预算与文生图共用', async () => {
    const ctx = makeCtx('group:70');
    const refs = [saveImage(ctx.chatKey, png, 'test'), saveImage(ctx.chatKey, png, 'test')];
    const reply = await tool('generate_image').execute(ctx, { prompt: '按参考图改色', referenceImageIds: refs.map(r => r.imageId) });
    assert.ok(!reply.isError, reply.content);
    const value = JSON.parse(reply.content), sent = requests.at(-1);
    assert.equal(sent.url, '/v1/images/edits'); assert.equal(sent.body.n, 1);
    assert.deepEqual(sent.body.images, refs.map(() => ({ image_url: `data:image/png;base64,${png.toString('base64')}` })));
    assert.equal(sent.auth, 'Bearer image-test-secret'); assert.equal(value.mode, 'edit');
    assert.deepEqual(value.referenceImageIds, refs.map(r => r.imageId));
    assert.ok(!reply.content.includes('base64')); assert.equal(deliveries.length, 0);
    assert.deepEqual(loadImage(ctx.chatKey, refs[0].imageId).buffer, png);
    assert.equal(loadImage(ctx.chatKey, value.imageId).source, 'edited');
    assert.notEqual(value.imageId, refs[0].imageId);
    await generateImage(ctx.chatKey, '文生图'); assert.equal(imageBudgetStatus(ctx.chatKey).used, 2);
    assert.equal(imageEndpoint(base + '/v1/images/generations/', 'edits'), base + '/v1/images/edits');
    assert.equal(imageEndpoint(base + '/v1/images/edits', 'generations'), base + '/v1/images/generations');
  });
  await check('非法、跨会话、过多、重复、GIF、合计超限参考图在扣次前拒绝', async () => {
    const id = saveImage('group:71', png, 'test').imageId;
    const foreign = saveImage('private:71', png, 'test').imageId;
    const gif = saveImage('group:71', Buffer.from('GIF89a' + '0'.repeat(30)), 'test').imageId;
    const big = Buffer.alloc(7 * 1024 * 1024); png.copy(big);
    const bigRefs = [saveImage('group:71', big, 'test').imageId, saveImage('group:71', big, 'test').imageId];
    const before = requests.length;
    for (const ids of [null, 'bad', [null], ['../../bad'], [foreign], [id, id], [id, id, id, id, id], [gif], bigRefs]) {
      await assert.rejects(generateImage('group:71', '编辑', { referenceImageIds: ids }));
    }
    assert.equal(imageBudgetStatus('group:71').used, 0); assert.equal(requests.length, before);
  });
  await check('编辑失败只扣一次，不回退文生图；参考 ID 可继续使用', async () => {
    const imageId = saveImage('group:72', png, 'test').imageId;
    const before = requests.length;
    handle = (_req, res) => { res.writeHead(400); res.end('edit unsupported'); };
    try { await assert.rejects(generateImage('group:72', '编辑', { referenceImageIds: [imageId] }), /HTTP 400/); }
    finally { handle = normalHandle; }
    assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).url, '/v1/images/edits');
    assert.equal(imageBudgetStatus('group:72').used, 1); assert.deepEqual(loadImage('group:72', imageId).buffer, png);
  });
  await check('本会话已发送图片可按消息导入；拒绝跨边界和被屏蔽消息', async () => {
    const ctx = makeCtx('group:73'), asset = saveImage(ctx.chatKey, png, 'test');
    let entry = { id: 1, mid: '1', senderId: '733', media: [{ kind: 'image', imageId: asset.imageId }] };
    ctx.store = { findByMid: (_chat, mid) => mid === '1' ? entry : null };
    ctx.session.contextSelection = { boundary: 1, blocklist: '[]' };
    let result = await tool('import_image').execute(ctx, { messageId: '1' });
    assert.ok(!result.isError, result.content); assert.equal(JSON.parse(result.content).imageId, asset.imageId);
    assert.equal(imageBudgetStatus(ctx.chatKey).used, 0);
    entry.id = 2; assert.equal((await tool('import_image').execute(ctx, { messageId: '1' })).isError, true);
    entry.id = 1;
    const old = cfg.blocklist; cfg.blocklist = { ...old, '73': ['733'] };
    try { assert.equal((await tool('import_image').execute(ctx, { messageId: '1' })).isError, true); }
    finally { cfg.blocklist = old; }
    assert.equal((await tool('import_image').execute(ctx, { messageId: '1', imageIndex: 2 })).isError, true);
    assert.equal((await tool('import_image').execute(ctx, { messageId: '1', url: 'https://example.org/img' })).isError, true);
  });
  await check('参考图查看受视觉开关和会话隔离约束，文本结果不含 Base64', async () => {
    const asset = saveImage('group:74', png, 'test'), ctx = makeCtx('group:74');
    const result = await tool('inspect_image').execute(ctx, { imageId: asset.imageId });
    assert.ok(!result.isError, result.content); assert.equal(result.content[1].type, 'image_url');
    assert.ok(!result.content[0].text.includes('base64'));
    assert.equal((await tool('inspect_image').execute(makeCtx('private:74'), { imageId: asset.imageId })).isError, true);
    cfg.api.vision = false;
    try { assert.equal((await tool('inspect_image').execute(ctx, { imageId: asset.imageId })).isError, true); }
    finally { cfg.api.vision = true; }
  });
  await check('旧读图工具支持机器人本地图片，序号选择、多图限量与跨会话隔离', async () => {
    const ctx = makeCtx('group:75'), asset = saveImage(ctx.chatKey, png, 'test');
    const foreign = saveImage('private:75', png, 'test');
    let entry = { id: 1, mid: 1, self: true, media: [{ kind: 'image', imageId: asset.imageId }] };
    ctx.store = { findByMid: () => entry };
    const read = args => tool('get_message_images').execute(ctx, { messageId: 1, ...args });
    let r = await read();
    assert.ok(!r.isError, r.content); assert.equal(r.content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
    entry.media = Array.from({ length: 5 }, () => ({ kind: 'image', imageId: asset.imageId }));
    r = await read(); assert.equal(r.content.length, 5); assert.match(r.content[0].text, /共 5 张/);
    r = await read({ imageIndex: 4 }); assert.equal(r.content.length, 2);
    assert.equal((await read({ imageIndex: 5 })).isError, true);
    entry.media = [{ kind: 'image', imageId: foreign.imageId }];
    assert.match((await read()).content, /其他会话/);
    entry.media = [{ kind: 'image', file: 'C:/private.png' }];
    assert.match((await read()).content, /缺少可下载地址/);
    entry.media = [{ kind: 'face', faceId: '1' }];
    assert.match((await read()).content, /QQ 原生表情/);
    const large = Buffer.alloc(7 * 1024 * 1024); png.copy(large);
    const largeAsset = saveImage(ctx.chatKey, large, 'test');
    entry.media = [largeAsset, largeAsset].map(a => ({ kind: 'image', imageId: a.imageId }));
    r = await read(); assert.equal(r.content.length, 2); assert.match(r.content[0].text, /合计超过/);
  });
  await check('单张生图请求、独立 Key、真实字节保存，不把 Base64 返回模型', async () => {
    const result = await tool('generate_image').execute(makeCtx('group:10'), { prompt: '一朵花', n: 100 });
    assert.ok(!result.isError, result.content);
    const value = JSON.parse(result.content), sent = requests.at(-1);
    assert.equal(sent.auth, 'Bearer image-test-secret'); assert.equal(sent.body.n, 1);
    assert.equal(sent.body.size, '1024x1024'); assert.equal(sent.body.quality, 'low'); assert.equal(sent.body.model, undefined);
    assert.ok(!result.content.includes(png.toString('base64')));
    assert.deepEqual(loadImage('group:10', value.imageId).buffer, png);
    assert.equal(value.budget.used, 1); assert.equal(deliveries.length, 0);
  });
  await check('会话预算独立，0 禁用；达到上限不发请求', async () => {
    cfg.imageGeneration.chatDailyLimits = { 'group:11': 1, 'private:11': 0 };
    await generateImage('group:11', '花');
    const before = requests.length;
    await assert.rejects(generateImage('group:11', '另一朵'), /预算已用完/);
    await assert.rejects(generateImage('private:11', '花'), /预算已用完/);
    assert.equal(requests.length, before);
    assert.equal(imageBudgetStatus('group:10').used, 1);
  });
  await check('北京时间跨日重置，旧日记录保留', () => {
    const a = Date.parse('2026-10-27T15:59:59Z'), b = a + 1000;
    assert.equal(imageBudgetDate(a), '2026-10-27'); assert.equal(imageBudgetDate(b), '2026-10-28');
    reserveImageAttempt('group:12', a);
    assert.equal(imageBudgetStatus('group:12', a).used, 1); assert.equal(imageBudgetStatus('group:12', b).used, 0);
  });
  await check('重启和多个进程不能超卖持久化名额', async () => {
    const code = `import {setRuntimeConfig,DEFAULT_CONFIG} from './src/config.js'; import {reserveImageAttempt} from './src/image-budget.js'; const c=structuredClone(DEFAULT_CONFIG); c.imageGeneration.dailyLimit=2; setRuntimeConfig(c); try {reserveImageAttempt('group:13'); console.log('reserved');} catch {console.log('full');}`;
    const run = () => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, QQ_AGENT_DATA_DIR: DATA_DIR } }, (e, out) => e ? reject(e) : resolve(out.trim())));
    const outputs = await Promise.all([run(), run(), run(), run()]);
    assert.equal(outputs.filter(v => v === 'reserved').length, 2);
    assert.equal(await run(), 'full'); assert.equal(imageBudgetStatus('group:13').used, 2);
  });
  await check('同会话生图并发拦截，不重复扣次', async () => {
    let release, started;
    const entered = new Promise(r => { started = r; });
    handle = (req, res) => { release = () => normalHandle(req, res); started(); };
    const first = generateImage('group:14', '花'); await entered;
    await assert.rejects(generateImage('group:14', '花'), /进行中/);
    assert.equal(imageBudgetStatus('group:14').used, 1); release(); await first; handle = normalHandle;
  });
  await check('上游失败、无效 JSON、伪图均不重试；错误不泄露 Key', async () => {
    for (const [i, reply] of [
      [0, res => { res.writeHead(401); res.end('image-test-secret'); }],
      [1, res => res.end('invalid image-test-secret')],
      [2, res => res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('<html>fake image</html>').toString('base64') }] }))],
      [3, res => res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.1/image' }] }))]
    ]) {
      handle = (_req, res) => reply(res); const before = requests.length;
      await assert.rejects(generateImage(`group:${20 + i}`, '花'), e => !e.message.includes('image-test-secret'));
      assert.equal(requests.length, before + 1); assert.equal(imageBudgetStatus(`group:${20 + i}`).used, 1);
    }
    handle = normalHandle;
  });
  await check('生图接口重定向不能携带 Key 到新地址', async () => {
    handle = (_req, res) => { res.writeHead(307, { location: base + '/other' }); res.end(); };
    const before = deliveries.length;
    await assert.rejects(generateImage('group:24', '花'), /连接失败/);
    assert.equal(deliveries.length, before); handle = normalHandle;
  });
  await check('超时覆盖响应体，取消请求不返还已用名额', async () => {
    cfg.imageGeneration.timeoutMs = 1000;
    handle = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); };
    await assert.rejects(generateImage('group:25', '花'), /超时/);
    assert.equal(imageBudgetStatus('group:25').used, 1);
    const controller = new AbortController();
    const pending = generateImage('group:26', '花', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30); await assert.rejects(pending, /取消/);
    assert.equal(imageBudgetStatus('group:26').used, 1);
    cfg.imageGeneration.timeoutMs = 300000; handle = normalHandle;
  });
  await check('参数错误、开关关闭、权限撤销不扣次不发请求', async () => {
    const before = requests.length;
    await assert.rejects(generateImage('group:27', ''), /描述/);
    await assert.rejects(generateImage('group:27', '花', { beforeRequest: () => { throw new Error('撤销'); } }), /撤销/);
    cfg.imageGeneration.enabled = false;
    await assert.rejects(generateImage('group:27', '花'), /关闭/); cfg.imageGeneration.enabled = true;
    const p = new PermissionService(); cfg.permissions.tools['builtin:generate_image'] = { role: 'disabled' };
    const r = await p.execute(makeCtx('group:27'), tool('generate_image'), { prompt: '花' }); assert.equal(r.isError, true);
    delete cfg.permissions.tools['builtin:generate_image'];
    assert.equal(requests.length, before); assert.equal(imageBudgetStatus('group:27').used, 0);
  });
  await check('图片 ID 隔离、路径和格式校验', () => {
    const image = saveImage('group:30', png, 'generated');
    assert.throws(() => loadImage('private:30', image.imageId), /其他会话/);
    assert.throws(() => loadImage('group:30', '../../config'), /ID/);
    assert.throws(() => decodeImage(png.toString('base64') + '!'), /Base64/);
    assert.throws(() => imageMime(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /12 MiB/);
  });
  await check('图片发送使用当前群的 OneBot 图片段，留档记录资源 ID；不扣生图次数', async () => {
    const image = saveImage('group:31', png, 'generated'), ctx = makeCtx('group:31');
    const r = await tool('send_image').execute(ctx, { imageId: image.imageId, replyToMessageId: -123 });
    assert.ok(!r.isError, r.content);
    const delivery = deliveries.at(-1);
    assert.equal(delivery.action, '/send_group_msg'); assert.equal(delivery.body.group_id, 31);
    assert.equal(delivery.body.message[0].type, 'reply'); assert.equal(delivery.body.message[0].data.id, '-123');
    const imageFile = delivery.body.message[1].data.file;
    assert.equal(delivery.body.message[1].type, 'image'); assert.ok(imageFile.startsWith('file:///'));
    assert.deepEqual(fs.readFileSync(fileURLToPath(imageFile)), png);
    assert.ok(delivery.bodyBytes < 1024);
    assert.equal(store.recent('group:31', 1)[0].media[0].imageId, image.imageId);
    assert.equal(ctx.session.sent[0].type, 'image'); assert.equal(imageBudgetStatus('group:31').used, 0);
  });
  await check('私聊图片路由正确，发送失败后复用 ID，无需生图', async () => {
    const image = saveImage('private:32', png, 'generated'), ctx = makeCtx('private:32');
    deliveryFailure = true;
    const failed = await tool('send_image').execute(ctx, { imageId: image.imageId });
    assert.equal(failed.isError, true); assert.ok(failed.content.includes(image.imageId));
    assert.equal(store.recent('private:32', 1).length, 0);
    deliveryFailure = false;
    const r = await tool('send_image').execute(ctx, { imageId: image.imageId });
    assert.ok(!r.isError, r.content); assert.equal(deliveries.at(-1).action, '/send_private_msg');
    assert.equal(deliveries.at(-1).body.user_id, 32); assert.equal(imageBudgetStatus('private:32').used, 0);
  });
  await check('发送前再次检查取消与权限，其他会话的 ID 不可发送', async () => {
    const image = saveImage('group:33', png, 'generated'), ctx = makeCtx('group:33');
    const before = deliveries.length;
    await assert.rejects(sender.sendImage('group:33', image.imageId, { beforeSend() { throw new Error('撤销'); } }), /撤销/);
    ctx.isCancelled = () => true;
    assert.equal((await tool('send_image').execute(ctx, { imageId: image.imageId })).isError, true);
    assert.equal((await tool('send_image').execute(makeCtx('group:34'), { imageId: image.imageId })).isError, true);
    assert.equal(deliveries.length, before);
  });
  await check('网页图片工具即使允许旧图床内网例外也拒绝本机地址', async () => {
    cfg.security.allowPrivateImageHosts = true;
    const before = deliveries.length;
    const r = await tool('send_image').execute(makeCtx('group:35'), { url: base + '/private-image' });
    assert.equal(r.isError, true); assert.match(r.content, /内网/); assert.equal(deliveries.length, before);
    cfg.security.allowPrivateImageHosts = false;
  });
  await check('超过 2 MiB 的本机图片只传内部文件地址，HTTP 请求保持很小', async () => {
    const large = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    const image = saveImage('group:36', large, 'generated');
    const r = await tool('send_image').execute(makeCtx('group:36'), { url: '', imageId: image.imageId, replyToMessageId: '-586761091', atUserId: '' });
    assert.ok(!r.isError, r.content);
    const d = deliveries.at(-1);
    assert.ok(d.bodyBytes < 1024);
    assert.deepEqual(fs.readFileSync(fileURLToPath(d.body.message[1].data.file)), large);
    assert.equal(d.body.message.length, 2); // 空 atUserId 不生成 at 段。
  });
  await check('远程协议端不读取本机文件，超大 Base64 在发送前明确拒绝', async () => {
    const remote = new OneBotClient({ httpUrl: 'https://onebot.example.test' });
    assert.equal(remote.canReadLocalImageFiles, false);
    let calls = 0;
    remote.call = async (_action, params, timeout) => {
      calls++; assert.equal(timeout, 120000);
      assert.equal(params.message[0].data.file, 'base64://' + png.toString('base64'));
      return { message_id: 88 };
    };
    const q = new SendQueue({ onebot: remote, store });
    await q.sendImage('group:37', saveImage('group:37', png, 'generated').imageId);
    await assert.rejects(q.sendImage('group:37', saveImage('group:37', Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]), 'generated').imageId), /2 MiB/);
    assert.equal(calls, 1);
  });
  await check('本机容器可强制 Base64；图片上传使用独立的 120 秒超时', async () => {
    cfg.snowluma.imageTransport = 'base64';
    const r = await tool('send_image').execute(makeCtx('group:38'), { imageId: saveImage('group:38', png, 'generated').imageId });
    assert.ok(!r.isError, r.content);
    assert.equal(deliveries.at(-1).body.message[0].data.file, 'base64://' + png.toString('base64'));
    cfg.snowluma.imageTransport = 'auto';
    const client = new OneBotClient({ httpUrl: base });
    let timeout;
    client.call = async (_a, _p, t) => { timeout = t; };
    await client.sendImage('group', '38', 'file:///internal.png'); assert.equal(timeout, 120000);
    await client.sendText('group', '38', 'text'); assert.equal(timeout, 15000);
  });
  await check('断连、超时错误可诊断，不泄露底层凭据且不自动重试', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new TypeError('secret raw url', { cause: Object.assign(new Error('secret'), { code: 'UND_ERR_SOCKET' }) }); };
      await assert.rejects(onebot.call('send_group_msg', {}), e => /连接被协议端关闭/.test(e.message) && /结果可能未知/.test(e.message) && !/secret/.test(e.message));
      assert.equal(calls, 1);
      globalThis.fetch = async (_url, opts) => new Promise((_r, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
      const keepAlive = setTimeout(() => {}, 1000);
      try { await assert.rejects(onebot.call('send_group_msg', {}, 20), /请求超时/); }
      finally { clearTimeout(keepAlive); }
    } finally { globalThis.fetch = originalFetch; }
  });
  await check('预算配置严格校验，不能通过负数或字符串变成无限次', () => {
    for (const dailyLimit of [-1, 1.5, '3', 1001]) assert.throws(() => normalizeImageConfig({ dailyLimit }), /次数/);
    assert.throws(() => normalizeImageConfig({ chatDailyLimits: { 'other:12': 3 } }), /会话/);
    assert.throws(() => normalizeImageConfig({ baseUrl: 'https://user:password@example.org' }), /接口/);
  });
  app = createApp({ log() {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const appBase = `http://127.0.0.1:${app.server.address().port}`;
  const post = patch => fetch(appBase + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  await check('用量查询与持久化计数一致，非法会话返回 400', async () => {
    const r = await (await fetch(appBase + '/api/images/budget?chatKey=group:11')).json();
    assert.equal(r.used, 1); assert.equal(r.remaining, 0);
    assert.equal((await fetch(appBase + '/api/images/budget?chatKey=../../')).status, 400);
  });
  await check('生图设置保存、Key 脱敏/保留/清除、删除会话覆盖', async () => {
    const publicCfg = await (await fetch(appBase + '/api/config')).json();
    assert.equal(publicCfg.imageGeneration.apiKey, undefined); assert.equal(publicCfg.imageGeneration.hasApiKey, true);
    const saved = await (await post({ imageGeneration: { ...publicCfg.imageGeneration, dailyLimit: 5, chatDailyLimits: { __replace__: {} } } })).json();
    assert.equal(getConfig().imageGeneration.apiKey, 'image-test-secret');
    assert.equal(saved.config.imageGeneration.apiKey, undefined);
    assert.deepEqual(getConfig().imageGeneration.chatDailyLimits, {});
    assert.equal((await post({ imageGeneration: { dailyLimit: -1 } })).status, 400);
    assert.equal(getConfig().imageGeneration.dailyLimit, 5);
    await post({ imageGeneration: { apiKey: '' } }); assert.equal(getConfig().imageGeneration.apiKey, '');
  });
} finally {
  await app?.stop(); app?.server.closeAllConnections();
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(`image tools: ${count} passed`);
