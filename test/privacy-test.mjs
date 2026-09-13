import './isolated-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { DATA_DIR, ROOT, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { buildToolDefs, executeTool } from '../src/tools.js';

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.providersImported = true;
cfg.memory.consolidateEnabled = false;
cfg.proactive.enabled = false;
cfg.snowluma.autoLaunch = false;
cfg.snowluma.dir = path.join(DATA_DIR, 'protocol-stub');
cfg.api.priceRemoteUrl = '';
setRuntimeConfig(cfg);
let count = 0;
async function check(name, fn) { await fn(); console.log(`✓ ${++count}. ${name}`); }
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

await check('社区上传入口、状态、处理函数和宣传资源已移除', () => {
  const html = read('ui/index.html'), js = read('ui/app.js');
  for (const id of ['quote-confirm-btn', 'quote-btn', 'feedback-btn', 'open-site-btn', 'qrcode-egg-btn', 'check-update-btn']) {
    assert.ok(!html.includes(id)); assert.ok(!js.includes(id));
  }
  for (const name of ['quoteMode', 'quoteSelected', 'COMMUNITY_API', 'openFeedbackModal', 'openQuoteConfirmModal', 'runUpdateCheck']) assert.ok(!js.includes(name));
  for (const file of ['ui/landing.html', 'ui/group-qrcode.jpg', 'src/telemetry.js']) assert.equal(fs.existsSync(path.join(ROOT, file)), false);
  for (const dir of ['src', 'ui', 'electron']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.(js|html|css)$/.test(f))) {
      assert.doesNotMatch(read(`${dir}/${file}`), /https?:\/\/(?:[^/]+\.)?kondius\.cn\b/i, `${dir}/${file}`);
    }
  }
});

await check('遗留的其他应用凭据读取已移除，手动配置的模型密钥仍可解析', async () => {
  const providers = await import('../src/providers.js');
  for (const name of ['readDshCredentials', 'parseDshSettings', 'importFromDsh']) assert.equal(providers[name], undefined);
  assert.doesNotMatch(read('src/providers.js'), /\.credentials\.yaml|process\.env|node:fs/);
  cfg.providers = [{ id: 'fixture', baseURL: 'http://127.0.0.1:1', models: ['fixture-model'] }];
  cfg.dshProviderKeys = { fixture: 'test-only-key' };
  assert.equal(providers.currentProviders()[0].apiKey, 'test-only-key');
  cfg.providers = []; cfg.dshProviderKeys = {};
});

// Record all fetch calls made by the application; never contact an external service.
const realFetch = globalThis.fetch, realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval;
const outbound = [], timers = [];
globalThis.fetch = async (url) => { outbound.push(String(url)); throw new Error('privacy test forbids outbound HTTP'); };
const captureTimer = (fn, delay, ...args) => {
  const t = { fn: () => fn(...args), delay: Number(delay), unref() {} };
  timers.push(t); return t;
};
let app;
try {
  // Reserve an ephemeral port, then let the real start() path bind it (with its existing retries).
  const portProbe = net.createServer();
  await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
  cfg.server.port = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));
  const { createApp } = await import('../src/app.js');
  globalThis.setTimeout = captureTimer;
  globalThis.setInterval = captureTimer;
  app = createApp({ log() {} });
  app.onebot.connect = async () => {};
  app.onebot.call = async () => { throw new Error('unexpected OneBot request'); };
  await app.start();
  globalThis.setTimeout = realTimeout;
  globalThis.setInterval = realInterval;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, options) => realFetch(base + route, options);

  await check('真实启动路径不创建后台上报定时器，也不访问作者服务', async () => {
    // The only scheduler is now the local, deterministic group-response tick.
    assert.deepEqual(timers.map((t) => t.delay), [1000]);
    assert.deepEqual(outbound, []);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'telemetry.json')), false);
    assert.equal((await request('/api/version')).status, 200);
  });

  await check('旧上传取图和更新接口返回 404，旧宣传资源不可访问', async () => {
    for (const route of ['/api/update-check', '/api/telemetry', '/api/comment', '/api/holyshits']) {
      assert.equal((await request(route)).status, 404, route);
      assert.equal((await request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, route);
    }
    assert.equal((await request('/api/media-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ file: 'private-file', url: 'https://outside.invalid/image' }] }) })).status, 404);
    for (const route of ['/landing.html', '/group-qrcode.jpg']) assert.equal((await request(route)).status, 404);
    assert.deepEqual(outbound, []);
  });

  await check('会话结束保留本地用量统计，不生成遥测 ID 或计数文件', async () => {
    const s = app.sessions.create({ chatKey: 'group:1', trigger: [], triggerSummary: 'local stats' });
    s.usage = { promptTokens: 8, completionTokens: 5, totalTokens: 13, cachedTokens: 0, calls: 1 };
    s.messages.push({ role: 'assistant', content: '', raw: { usage: { prompt_tokens: 8, completion_tokens: 5 } } });
    app.sessions.finish(s.id, 'noreply');
    const usage = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
    assert.equal(usage.totalTokens, 13); assert.equal(usage.runs, 1);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'telemetry-totals.json')), false);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'telemetry.json')), false);
    assert.equal((await request('/api/usage/stats?range=7')).status, 200);
    assert.deepEqual(outbound, []);
  });

  await check('本地 Agent 问题反馈仍写会话和控制台事件，不产生 HTTP 上报', async () => {
    const session = { feedbacks: [] }, events = [];
    const result = await executeTool(buildToolDefs(), { chatKey: 'group:1', session, emit: (type, payload) => events.push({ type, payload }) }, 'report_feedback', { message: '本地诊断', level: 'warning' });
    assert.ok(!result.isError); assert.equal(session.feedbacks[0].message, '本地诊断');
    assert.equal(events[0].type, 'feedback'); assert.deepEqual(outbound, []);
  });
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
  globalThis.setInterval = realInterval;
  await app?.stop();
}
console.log(`\n${count} privacy checks passed`);
