import './isolated-env.mjs';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';

const originalLookup = dns.promises.lookup;
const originalRequest = https.request;
let localAddresses, answers, target, requests, dnsCalls, lookupFailure;
const cfg = structuredClone(DEFAULT_CONFIG);
setRuntimeConfig(cfg);
dns.promises.lookup = async () => { dnsCalls++; if (lookupFailure === 'stall') return new Promise(() => {}); if (lookupFailure) throw new Error('DNS lookup failed'); return localAddresses; };
https.request = (options, callback) => {
  requests.push(options);
  const req = new EventEmitter();
  req.destroy = () => {};
  req.end = () => queueMicrotask(() => {
    const isDns = options.hostname === '1.1.1.1';
    const type = isDns ? new URL('https://dns.test' + options.path).searchParams.get('type') : null;
    const reply = isDns ? answers[type] : typeof target === 'function' ? target(options) : target;
    const res = new PassThrough();
    res.statusCode = reply.status || 200;
    res.headers = reply.headers || {};
    callback(res);
    if (reply.abort) { res.emit('aborted'); res.destroy(); return; }
    if (reply.stall) return;
    res.end(reply.raw ?? (isDns ? JSON.stringify(reply) : '网页正文'));
  });
  return req;
};
// 在替换 lookup 后导入，确保所有用例不触网。
const { safeFetch, safeFetchBinary, validateFetchUrl, isPrivateIp } = await import('../src/safe-fetch.js');
const { imageTools } = await import('../src/image-tools.js');
const { loadImage } = await import('../src/image-assets.js');
const { isFakeIp } = await import('../src/public-dns.js');
const { extractWebpageImages } = await import('../src/webpage-images.js');
let count = 0;
function reset() {
  cfg.security.fakeIpDnsFallback = true;
  localAddresses = [{ address: '198.18.3.86', family: 4 }];
  answers = {
    A: { Status: 0, Answer: [{ type: 1, data: '8.209.255.199' }] },
    AAAA: { Status: 0 }
  };
  target = {};
  lookupFailure = false;
  requests = []; dnsCalls = 0;
}
async function check(name, fn) { reset(); await fn(); console.log(`✓ ${++count}. ${name}`); }
try {
  await check('系统 DNS 超时和异常可回退公共 DNS，仍检查全部 IP，关闭开关则拒绝', async () => {
    for (const failure of ['stall', true]) {
      lookupFailure = failure;
      const result = await validateFetchUrl('https://multimedia.nt.qq.com.cn/image');
      assert.equal(result.ip, '8.209.255.199');
    }
    answers.AAAA = { Status: 0, Answer: [{ type: 28, data: '::1' }] };
    await assert.rejects(validateFetchUrl('https://example.org/image'), /内网/);
    answers.AAAA = { Status: 0 }; answers.A = { Status: 0, Answer: [{ type: 1, data: '198.18.1.1' }] };
    const beforeFake = requests.length;
    await assert.rejects(validateFetchUrl('https://example.org/image'), /内网/);
    assert.equal(requests.length - beforeFake, 2, '公共解析返回 Fake-IP 时拒绝，不再次回退');
    cfg.security.fakeIpDnsFallback = false;
    const before = requests.length;
    await assert.rejects(validateFetchUrl('https://example.org/image'), /域名解析失败/);
    assert.equal(requests.length, before);
    cfg.security.fakeIpDnsFallback = true; answers.A = { Status: 3 };
    await assert.rejects(validateFetchUrl('https://example.org/image'), /回退也失败/);
  });
  await check('旧看图工具只解析一次 DNS；真实字节校验拒绝伪装成图片的 HTML', async () => {
    const { buildToolDefs } = await import('../src/tools.js');
    const tools = buildToolDefs();
    localAddresses = [{ address: '8.209.255.199', family: 4 }];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C1sAAAAASUVORK5CYII=', 'base64');
    let entry = { id: 1, mid: 123, senderId: '123', media: [{ kind: 'image', url: 'https://example.org/image' }] };
    const ctx = { chatKey: 'group:96', session: {}, memory: {}, store: { findByMid: () => entry }, stickers: { find: async () => ({ id: 'test', url: 'https://example.org/image' }) } };
    target = { raw: png, headers: { 'content-type': 'application/octet-stream' } };
    const get = tools.find(t => t.name === 'get_message_images');
    const result = await get.execute(ctx, { messageId: 123 });
    assert.ok(!result.isError, result.content); assert.equal(dnsCalls, 1);
    assert.ok(result.content[1].image_url.url.startsWith('data:image/png;base64,'));
    target = { raw: '<html>Access denied</html>', headers: { 'content-type': 'image/jpeg' } };
    for (const [name, args] of [['get_message_images', { messageId: 123 }], ['get_sticker_image', { stickerId: 'test' }]]) {
      const r = await tools.find(t => t.name === name).execute(ctx, args);
      assert.equal(r.isError, true); assert.match(r.content, /不是支持的图片/);
    }
    target = { raw: png }; let checks = 0;
    ctx.store.findByMid = () => ++checks === 1 ? entry : null;
    assert.match((await get.execute(ctx, { messageId: 123 })).content, /不可见/);
  });
  await check('网页图片解析支持相对地址、base、实体、懒加载、srcset 和元数据，忽略脚本', () => {
    const result = extractWebpageImages(`<img src="first.png"><base href="/assets/">
      <script>const fake = '<img src="fake.png">';</script><!-- <img src="comment.png"> -->
      <img data-src="hero.png?a=1&amp;b=2" alt="主角 &amp; 背景" width="1024" height="768" src="data:image/png;base64,AA">
      <picture><source srcset="small.webp 1x, large.webp 2x"><img src="first.png"></picture>
      <meta property="og:image" content="//cdn.example.org/cover.jpg">
      <img src="file:///C:/private.png"><img src="javascript:alert(1)"><img src="https://u:p@example.org/i">`, 'https://example.org/page');
    assert.deepEqual(result.map(i => i.url), ['https://example.org/assets/first.png', 'https://example.org/assets/hero.png?a=1&b=2',
      'https://example.org/assets/small.webp', 'https://example.org/assets/large.webp', 'https://cdn.example.org/cover.jpg']);
    assert.equal(result[1].alt, '主角 & 背景'); assert.equal(result[1].width, 1024);
    assert.equal(extractWebpageImages('<img src="a"><img src="b">', 'https://example.org', 1).length, 1);
  });
  await check('网页候选工具拒绝 HTTP 错误，动态空页面如实返回；抓取开关生效', async () => {
    const tool = imageTools().find(t => t.name === 'get_webpage_images');
    const ctx = { chatKey: 'group:99', session: {}, memory: {} };
    target = { status: 403, raw: '<img src="error.png">' };
    assert.match((await tool.execute(ctx, { url: 'https://example.org/page' })).content, /HTTP 403/);
    target = { raw: '<div id="app"></div>' };
    const value = JSON.parse((await tool.execute(ctx, { url: 'https://example.org/page' })).content);
    assert.deepEqual(value.images, []); assert.match(value.note, /JavaScript/);
    const before = requests.length; cfg.webSearch.enabled = false;
    try { assert.equal((await tool.execute(ctx, { url: 'https://example.org/page' })).isError, true); }
    finally { cfg.webSearch.enabled = true; }
    assert.equal(requests.length, before);
  });
  await check('导入图片不发送、不扣预算，下载结束仍检查取消和来源可见性', async () => {
    const { imageBudgetStatus } = await import('../src/image-budget.js');
    const tool = imageTools().find(t => t.name === 'import_image');
    target = { raw: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C1sAAAAASUVORK5CYII=', 'base64') };
    const ctx = { chatKey: 'group:98', session: {}, memory: {} };
    const value = JSON.parse((await tool.execute(ctx, { url: 'https://example.org/image' })).content);
    assert.deepEqual(loadImage(ctx.chatKey, value.imageId).buffer, target.raw);
    assert.equal(imageBudgetStatus(ctx.chatKey).used, 0);
    let checks = 0; ctx.isCancelled = () => ++checks > 1;
    assert.match((await tool.execute(ctx, { url: 'https://example.org/image' })).content, /暂停/);
    delete ctx.isCancelled;
    let reads = 0;
    ctx.store = { findByMid: () => ++reads === 1 ? { id: 1, senderId: '123', media: [{ kind: 'image', url: 'https://example.org/image' }] } : null };
    assert.match((await tool.execute(ctx, { messageId: '1' })).content, /找不到/);
    for (const url of ['file:///C:/image.png', 'http://127.0.0.1/image']) {
      assert.equal((await tool.execute(ctx, { url })).isError, true);
    }
    target = { status: 302, headers: { location: 'http://127.0.0.1/image' } };
    assert.match((await tool.execute(ctx, { url: 'https://example.org/image' })).content, /内网/);
  });
  await check('Fake-IP 经公共 DNS 校验后固定真实 IP，保留 Host/SNI/TLS', async () => {
    const result = await safeFetch('https://www.arknights-anime.jp/character/Talulah');
    assert.equal(result.body, '网页正文');
    assert.equal(dnsCalls, 1);
    assert.equal(requests.length, 3);
    for (const r of requests.slice(0, 2)) {
      assert.equal(r.hostname, '1.1.1.1'); assert.equal(r.servername, 'cloudflare-dns.com');
      assert.equal(r.headers.host, 'cloudflare-dns.com'); assert.equal(r.rejectUnauthorized, true);
      assert.ok(!r.path.includes('Talulah'));
    }
    const r = requests[2];
    assert.equal(r.hostname, '8.209.255.199'); assert.equal(r.servername, 'www.arknights-anime.jp');
    assert.equal(r.headers.host, 'www.arknights-anime.jp'); assert.equal(r.rejectUnauthorized, true);
  });
  await check('完整 Markdown 链接兼容；普通公网 DNS 不调用公共解析器', async () => {
    localAddresses = [{ address: '8.209.255.199', family: 4 }];
    const result = await safeFetch('[页面](https://www.arknights-anime.jp/character/Talulah)');
    assert.equal(result.url, 'https://www.arknights-anime.jp/character/Talulah');
    assert.equal(requests.length, 1);
    await assert.rejects(validateFetchUrl('查看 [页面](https://example.org)'), /URL 无效/);
  });
  await check('内网、Fake-IP 字面量和本地域名不进入公共 DNS', async () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '[::1]', '198.18.0.1', '198.19.255.254', 'localhost.', 'x.local.']) {
      await assert.rejects(validateFetchUrl(`https://${host}/`), /内网/);
    }
    await assert.rejects(validateFetchUrl('[x](https://127.0.0.1/)'), /内网/);
    await assert.rejects(validateFetchUrl('[x](https://user:pass@example.org/)'), /凭据/);
    assert.equal(dnsCalls, 0); assert.equal(requests.length, 0);
    assert.equal(isPrivateIp('198.18.3.86'), true);
    assert.equal(isFakeIp('198.20.0.1'), false);
  });
  await check('系统 DNS 私网或混合结果不能通过 Fake-IP 回退', async () => {
    for (const addresses of [['10.0.0.1'], ['198.18.1.1', '8.8.8.8'], ['198.18.1.1', '192.168.1.1']]) {
      localAddresses = addresses.map((address) => ({ address, family: 4 }));
      await assert.rejects(validateFetchUrl('https://example.org'), /内网/);
    }
    assert.equal(requests.length, 0);
  });
  await check('关闭兼容开关后保持严格系统 DNS 检查', async () => {
    cfg.security.fakeIpDnsFallback = false;
    await assert.rejects(validateFetchUrl('https://example.org'), /内网/);
    assert.equal(requests.length, 0);
  });
  await check('公共 DNS 的私网 IPv4、IPv6、混合结果仍拦截', async () => {
    for (const [type, ip] of [[1, '192.168.1.1'], [1, '198.18.2.2'], [28, '::1'], [28, 'fd00::1'], [28, '::ffff:127.0.0.1']]) {
      answers.AAAA = { Status: 0, Answer: [{ type, data: ip }] };
      await assert.rejects(safeFetch('https://example.org'), /内网/);
    }
    assert.ok(requests.every((r) => r.hostname === '1.1.1.1'));
  });
  await check('公共 DNS 的失败、截断、无效格式和空结果都失败关闭', async () => {
    for (const reply of [{ Status: 3 }, { Status: 0, TC: true }, { raw: 'bad json' },
      { Status: 0, Answer: {} }, { Status: 0, Answer: [{ type: 1, data: '127.1' }] }, { Status: 0 }]) {
      answers.A = reply;
      await assert.rejects(safeFetch('https://example.org'), /公共 DNS/);
    }
    assert.ok(requests.every((r) => r.hostname === '1.1.1.1'));
  });
  await check('公共 DNS 不跟随重定向，响应大小受限', async () => {
    for (const reply of [{ status: 302, headers: { location: 'https://127.0.0.1/' } }, { raw: 'x'.repeat(65537) }]) {
      answers.A = reply;
      await assert.rejects(safeFetch('https://example.org'), /公共 DNS/);
    }
    assert.ok(requests.every((r) => r.hostname === '1.1.1.1'));
  });
  await check('公共 DNS 超时覆盖响应体读取', async () => {
    answers.A = { stall: true };
    await assert.rejects(safeFetch('https://example.org'), /公共 DNS 查询超时/);
    assert.equal(requests.length, 2);
  });
  await check('目标重定向每跳校验，不能跳到本机', async () => {
    target = { status: 302, headers: { location: 'https://127.0.0.1/private' } };
    await assert.rejects(safeFetch('https://example.org'), /内网/);
    assert.equal(requests.length, 3);
  });
  await check('公共 DNS 的 CNAME 与公网 AAAA 正常处理', async () => {
    answers.A = { Status: 0, Answer: [{ type: 5, data: 'cdn.example.org.' }] };
    answers.AAAA = { Status: 0, Answer: [{ type: 28, data: '2606:4700::1111' }] };
    const result = await validateFetchUrl('https://example.org');
    assert.equal(result.ip, '2606:4700::1111');
  });
  await check('网页图片下载后以图片 ID 交给发送队列，不交给 OneBot 再抓 URL', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C1sAAAAASUVORK5CYII=', 'base64');
    target = { raw: png };
    const ctx = { chatKey: 'group:99', session: { id: 'test', sent: [] }, memory: {}, emit() {}, sender: {
      async sendImage(chatKey, imageId, options) {
        options.beforeSend();
        assert.deepEqual(loadImage(chatKey, imageId).buffer, png);
        return { message_id: 123 };
      }
    } };
    const result = await imageTools()[0].execute(ctx, { url: 'https://example.org/image.png' });
    assert.ok(!result.isError, result.content);
    assert.equal(JSON.parse(result.content).messageId, 123);
    assert.ok(!result.content.includes(png.toString('base64')));
    assert.equal(requests.at(-1).hostname, '8.209.255.199');
  });
  await check('二进制超限必须报错，不能把截断图片当作成功', async () => {
    target = { raw: Buffer.alloc(33) };
    await assert.rejects(safeFetchBinary('https://example.org/img', 32), /超过大小/);
    target = { raw: Buffer.alloc(32) };
    assert.equal((await safeFetchBinary('https://example.org/img', 32)).buffer.length, 32);
    target = { abort: true };
    await assert.rejects(safeFetchBinary('https://example.org/img'), /传输中断/);
    target = { raw: 'a'.repeat(50001) };
    const page = await safeFetch('https://example.org/page');
    assert.equal(page.body.length, 50000); assert.equal(page.truncated, true);
  });
  await check('网页 HTML 不能作为图片发送', async () => {
    target = { raw: '<html>This is a web page</html>' };
    const result = await imageTools()[0].execute({ chatKey: 'group:99', session: {}, memory: {} }, { url: 'https://example.org/page' });
    assert.equal(result.isError, true); assert.match(result.content, /不是支持的图片/);
  });
  await check('真实 Agent 编排串联网页选图→导入→看图→编辑→发送；日志不保存图片字节', async () => {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { ChatStore } = await import('../src/store.js');
    const { MemoryStore } = await import('../src/memory.js');
    const { SessionRegistry } = await import('../src/sessions.js');
    const { imageBudgetStatus } = await import('../src/image-budget.js');
    const workflowCfg = structuredClone(cfg);
    Object.assign(workflowCfg.api, { provider: '', model: 'image-workflow-test', apiKey: '', baseUrl: 'https://model.example.org/v1', vision: true });
    workflowCfg.imageGeneration.baseUrl = 'https://image.example.org/v1';
    workflowCfg.memory.consolidateEnabled = false;
    workflowCfg.sticker.enabled = false;
    workflowCfg.responseRules.groupMode = 'legacy'; workflowCfg.store.contextTier = 4;
    setRuntimeConfig(workflowCfg);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C1sAAAAASUVORK5CYII=', 'base64');
    target = options => options.path === '/page' ? { raw: '<img src="/reference.png" alt="角色参考图">' } : { raw: png };
    const originalFetch = globalThis.fetch, modelRequests = [], deliveries = [], imageRequests = [];
    let step = 0, importedId, generatedId;
    const call = (name, args) => ({ id: `call_${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url === 'https://image.example.org/v1/images/edits') {
        imageRequests.push(body);
        assert.deepEqual(body.images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }]);
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      }
      assert.equal(url, 'https://model.example.org/v1/chat/completions');
      modelRequests.push(body);
      const resultOf = name => JSON.parse(body.messages.findLast(m => m.role === 'tool' && m.name === name).content);
      let next;
      switch (step++) {
        case 0: next = call('get_webpage_images', { url: 'https://example.org/page' }); break;
        case 1: next = call('import_image', { url: resultOf('get_webpage_images').images[0].url }); break;
        case 2: importedId = resultOf('import_image').imageId; next = call('inspect_image', { imageId: importedId }); break;
        case 3:
          assert.ok(body.messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')));
          next = call('generate_image', { prompt: '保留参考图人物，更换背景', referenceImageIds: [importedId] }); break;
        case 4: generatedId = resultOf('generate_image').imageId; next = call('send_image', { imageId: generatedId }); break;
        default: next = call('finish', { reason: '已完成' });
      }
      return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [next] } }] });
    };
    const store = new ChatStore(), memory = new MemoryStore(), sessions = new SessionRegistry();
    const sender = { async sendImage(chatKey, imageId, options) {
      options.beforeSend(); deliveries.push({ chatKey, imageId });
      assert.deepEqual(loadImage(chatKey, imageId).buffer, png); return { message_id: 123 };
    } };
    const orch = new Orchestrator({ store, memory, sessions, sender, stickers: {}, emit() {},
      onebot: { selfId: '888', selfNickname: '机器人', getGroupInfo: async () => ({ group_name: '测试群' }) } });
    orch.scheduleWake = () => {};
    try {
      store.appendIncoming('group:97', { mid: 1, senderId: '123', senderName: '用户', text: '@机器人 从网站找图并改背景发出来' });
      await orch.wake('group:97');
      const session = sessions.get(sessions.index[0]?.id);
      assert.equal(session.status, 'done', JSON.stringify(session.error));
      assert.deepEqual(deliveries, [{ chatKey: 'group:97', imageId: generatedId }]);
      assert.notEqual(importedId, generatedId); assert.equal(imageRequests.length, 1);
      assert.equal(imageBudgetStatus('group:97').used, 1); assert.equal(modelRequests.length, 6);
      const serialized = JSON.stringify(session);
      assert.ok(!serialized.includes(png.toString('base64'))); assert.ok(!serialized.includes('file:///'));
      assert.equal(session.sideEffectAttempted, true);
      assert.equal(session.webSearchCount, 1);
      // 关闭视觉/网页抓取后工具不可见，但仍可按 ID 图生图。
      workflowCfg.api.vision = false; workflowCfg.webSearch.enabled = false;
      store.appendIncoming('group:97', { mid: 2, senderId: '123', senderName: '用户', text: '@机器人 再来' });
      await orch.wake('group:97');
      const names = modelRequests.at(-1).tools.map(t => t.function.name);
      assert.ok(!names.includes('inspect_image')); assert.ok(!names.includes('get_webpage_images'));
      assert.ok(names.includes('generate_image')); assert.ok(names.includes('import_image'));
    } finally { globalThis.fetch = originalFetch; orch.aborted = true; orch.memoryPipeline.stop(); setRuntimeConfig(cfg); }
  });
} finally {
  dns.promises.lookup = originalLookup;
  https.request = originalRequest;
}
console.log(`safe-fetch: ${count} passed`);
