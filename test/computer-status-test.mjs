import './isolated-env.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DATA_DIR, DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { cpuUsage, readGpuStatus, parseGpuStatus, readComputerStatus, formatComputerStatus, createComputerStatusTool } from '../src/computer-status.js';
import { PermissionService, normalizePermissions } from '../src/permissions.js';
import { buildToolDefs } from '../src/tools.js';
import { ChatStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { SessionRegistry } from '../src/sessions.js';
import { Orchestrator } from '../src/orchestrator.js';

const cfg = structuredClone(DEFAULT_CONFIG);
// These existing integration scenarios explicitly exercise the legacy response gate.
cfg.responseRules.groupMode = 'legacy';
cfg.allowAllWhenEmpty = true;
cfg.memory.consolidateEnabled = false;
cfg.sticker.enabled = false;
setRuntimeConfig(cfg);
const store = new ChatStore();
let count = 0, mid = 0, reads = 0;
const times = (user, idle) => [{ times: { user, idle, nice: 0, sys: 0, irq: 0 } }];
const snapshot = { sampledAt: '2026-09-13T00:00:00Z', system: { platform: 'win32', release: '10.0', arch: 'x64', uptimeSeconds: 90061 },
  cpu: { logicalCores: 8, usagePercent: 25, sampleMs: 500 }, memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedPercent: 50 },
  gpu: parseGpuStatus('0, 42, 2048, 8192\n1, N/A, N/A, N/A'),
  disks: [{ label: 'D:', totalBytes: 1024 ** 4, availableBytes: 512 * 1024 ** 3, usedPercent: 50 }], agent: { uptimeSeconds: 3600, rssBytes: 128 * 1024 ** 2 } };
const tool = createComputerStatusTool(async () => { reads++; return structuredClone(snapshot); });
function context(text = '/电脑状态', senderId = '123', chatKey = 'group:1') {
  const entry = store.appendIncoming(chatKey, { mid: ++mid, senderId, text, commandText: text });
  return { entry, ctx: { store, chatKey, session: { trigger: [entry], messages: [], sent: [] } } };
}
const run = (svc, c, def = tool) => svc.command(c.ctx, c.entry, async () => [def]);
async function check(name, fn) {
  cfg.permissions = { adminQQs: ['123'], adminStyle: '', tools: {}, commands: {} };
  cfg.blocklist = {};
  await fn(); console.log(`✓ ${++count}. ${name}`);
}

await check('CPU 使用率来自两个采样差值，计数异常不能显示为正常空闲', () => {
  assert.equal(cpuUsage(times(100, 100), times(150, 250)), 25);
  assert.equal(cpuUsage(times(100, 100), times(100, 100)), null);
  assert.equal(cpuUsage(times(100, 100), times(99, 100)), null);
  assert.equal(cpuUsage([], []), null);
  assert.equal(cpuUsage(times(0, 0), [...times(1, 1), ...times(1, 1)]), null);
});
await check('固定读取程序与系统所在卷，输出不包含目录、机器名、用户名和进程列表', async () => {
  let tick = 0; const roots = [];
  const system = { platform: () => 'win32', cpus: () => tick++ ? times(150, 250) : times(100, 100), totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3, release: () => '10.0', arch: () => 'x64', uptime: () => 90061 };
  const result = await readComputerStatus({ system, readGpu: async () => snapshot.gpu, wait: async () => {}, dataDir: 'D:\\private-user\\bot', systemRoot: 'C:\\Windows',
    readFs: async (root) => { roots.push(root); return { bsize: 1024, blocks: 100, bavail: 40 }; } });
  assert.deepEqual(roots.sort(), ['C:\\', 'D:\\']);
  assert.equal(result.cpu.usagePercent, 25); assert.equal(result.memory.usedPercent, 50);
  assert.equal(result.disks[0].availableBytes, 40960);
  assert.deepEqual(result.gpu, snapshot.gpu);
  assert.doesNotMatch(JSON.stringify(result), /private-user|Windows\\|hostname|username|processes/);
});
await check('磁盘读取错误或超时只影响该项，原始错误和路径不出现在结果中', async () => {
  const system = { platform: () => 'win32', cpus: () => [], totalmem: () => 10, freemem: () => 20,
    release: () => '10.0', arch: () => 'x64', uptime: () => 1 };
  const result = await readComputerStatus({ system, readGpu: async () => { throw new Error('secret driver error'); }, wait: async () => {}, dataDir: 'D:\\secret\\bot', systemRoot: 'C:\\Windows', diskTimeoutMs: 10,
    readFs: (root) => root.startsWith('D:') ? Promise.reject(new Error('secret path')) : new Promise(() => {}) });
  assert.ok(result.disks.every((d) => d.unavailable)); assert.ok(result.memory.unavailable);
  assert.ok(result.gpu.unavailable);
  assert.equal(result.cpu.usagePercent, null); assert.doesNotMatch(JSON.stringify(result), /secret/);
});
await check('GPU 多卡、零负载和部分不支持可区分，异常输出不冒充有效指标', () => {
  const result = parseGpuStatus('0, 0, 2048, 8192\r\n1, [N/A], [Not Supported], 16384\n');
  assert.equal(result.devices[0].usagePercent, 0);
  assert.equal(result.devices[0].memory.usedBytes, 2048 * 1024 ** 2);
  assert.equal(result.devices[0].memory.usedPercent, 25);
  assert.equal(result.devices[1].usagePercent, null);
  assert.ok(result.devices[1].memory.unavailable);
  for (const csv of ['', 'driver error: C:\\secret', '0, 10, 20, 30, secret', '-1, 10, 20, 30']) {
    assert.deepEqual(parseGpuStatus(csv), { unavailable: true });
  }
  const invalid = parseGpuStatus('0, 101, 100, 20\n1, -1, -1, 10');
  assert.ok(invalid.devices.every((g) => g.usagePercent === null && g.memory.unavailable));
  const reply = formatComputerStatus({ content: JSON.stringify({ ...snapshot, gpu: result }) });
  assert.match(reply, /GPU 0（NVIDIA）：利用率 0%.*2.0 \/ 8.0 GiB（25%）/);
  assert.match(reply, /GPU 1（NVIDIA）：利用率暂不可用，显存暂不可用/);
});
await check('GPU 仅运行固定查询，隐藏窗口并限制时间与输出；缺失、超时和驱动错误安全降级', async () => {
  const calls = [];
  const options = { platform: 'win32', systemRoot: 'C:\\Windows', programFiles: 'C:\\Program Files' };
  const result = await readGpuStatus({ ...options, run: async (executable, args, opts) => {
    calls.push(executable);
    assert.deepEqual(args, ['--query-gpu=index,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']);
    assert.deepEqual(opts, { shell: false, windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024, encoding: 'utf8' });
    if (calls.length === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { stdout: '0, 42, 2048, 8192' };
  } });
  assert.deepEqual(calls, ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']);
  assert.equal(result.devices[0].usagePercent, 42);
  for (const error of [{ code: 'ENOENT' }, { killed: true }, { code: 1 }, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }]) {
    let attempts = 0;
    assert.deepEqual(await readGpuStatus({ ...options, run: async () => { attempts++; throw Object.assign(new Error('secret stderr'), error); } }), { unavailable: true });
    assert.equal(attempts, error.code === 'ENOENT' ? 2 : 1);
  }
  assert.deepEqual(await readGpuStatus({ platform: 'darwin', run: () => { assert.fail('不支持的平台不应启动查询'); } }), { unavailable: true });
});
await check('管理员不需编辑 JSON 注册即可调用，直接返回可读状态并进入审计', async () => {
  const svc = new PermissionService(), c = context(), before = reads;
  const result = await run(svc, c);
  assert.equal(reads, before + 1); assert.ok(!result.isError);
  assert.match(result.reply, /CPU：25%/); assert.match(result.reply, /8.0 \/ 16.0 GiB/);
  assert.match(result.reply, /GPU 0（NVIDIA）：利用率 42%/);
  assert.match(result.reply, /1天1小时1分/); assert.match(result.reply, /128 MiB/);
  assert.equal(c.ctx.session.permissionAudit[0].actorQQ, '123');
  const help = await run(new PermissionService(), context('/帮助'));
  assert.match(help.reply, /\/电脑状态/);
  assert.ok(!new PermissionService().visible(buildToolDefs().find((d) => d.name === 'get_computer_status'), 'group:1'));
});
await check('普通用户、管理员闲聊和额外参数不会触发本机采集', async () => {
  const svc = new PermissionService(), before = reads;
  await assert.rejects(run(svc, context('/电脑状态', '456')), /管理员/);
  await assert.rejects(run(svc, context('/电脑状态 {"path":"C:\\\\secret"}')), /参数/);
  assert.ok((await svc.execute(context('普通聊天').ctx, tool, {})).isError);
  await assert.rejects(tool.execute(context().ctx, {}), /权限/);
  assert.equal(reads, before);
});
await check('默认每分钟 3 次，跨会话 QQ 限流；禁用、范围和强制管理员规则生效', async () => {
  const svc = new PermissionService();
  for (let i = 1; i <= 3; i++) assert.ok(!(await run(svc, context('/电脑状态', '123', `group:${i}`))).isError);
  assert.ok((await run(svc, context('/电脑状态', '123', 'private:123'))).isError);
  cfg.permissions.tools['builtin:get_computer_status'] = { role: 'disabled' };
  await assert.rejects(run(new PermissionService(), context()), /禁用/);
  cfg.permissions.tools['builtin:get_computer_status'] = { role: 'admin', chats: ['private:123'] };
  await assert.rejects(run(new PermissionService(), context()), /会话/);
  cfg.permissions.tools['builtin:get_computer_status'] = { role: 'public' };
  assert.equal(new PermissionService().visible(tool, 'group:1'), false);
  assert.throws(() => normalizePermissions({ ...cfg.permissions, commands: { '电脑状态': { tool: 'builtin:get_computer_status' } } }), /保留/);
});
await check('采集过程中或排队回复前撤销身份，都不能发送电脑状态', async () => {
  const svc = new PermissionService();
  const delayed = createComputerStatusTool(async () => { await Promise.resolve(); cfg.permissions.adminQQs = []; return snapshot; });
  assert.ok((await run(svc, context(), delayed)).isError);
  cfg.permissions.adminQQs = ['123'];
  const result = await run(new PermissionService(), context());
  cfg.permissions.adminQQs = [];
  assert.throws(result.beforeReply, /管理员/);
});
await check('可选确认仍绑定同一状态工具，QQ 回复格式不会影响其他工具', async () => {
  cfg.permissions.tools['builtin:get_computer_status'] = { role: 'admin', confirm: true };
  const svc = new PermissionService(), before = reads;
  const pending = await run(svc, context());
  assert.equal(reads, before);
  const token = /\/确认 ([a-f0-9]{12})/.exec(pending.reply)[1];
  assert.match((await run(svc, context(`/确认 ${token}`))).reply, /电脑状态：Windows/);
});
await check('编排器实际发送状态且不调用模型或发现 MCP 工具，等待发送时仍复查', async () => {
  const sessions = new SessionRegistry(), memory = new MemoryStore(path.join(DATA_DIR, 'status-memory'));
  const sent = [];
  let revoke = false;
  const orch = new Orchestrator({ store, sessions, memory, stickers: {},
    onebot: { selfId: '999', selfNickname: 'bot' },
    mcp: { toolDefsForChat() { throw new Error('本地命令不应发现 MCP'); } },
    sender: { async sendTextBatch(_key, messages, options) { if (revoke) cfg.permissions.adminQQs = []; options.beforeSend(); sent.push(...messages); return { sent: messages.map((text) => ({ text })) }; } } });
  orch.scheduleWake = () => {}; orch.toolDefs = [tool];
  try {
    context('/电脑状态', '123', 'group:90');
    await orch.wake('group:90');
    assert.match(sent[0], /CPU：25%/); assert.equal(sessions.get(sessions.index[0].id).usage.calls, 0);
    revoke = true;
    context('/电脑状态', '123', 'group:91');
    await orch.wake('group:91');
    assert.equal(sent.filter((m) => m.includes('CPU：')).length, 1);
  } finally { await orch.abortAll(); }
});
await check('真实本机只读采样可用（不发送 QQ）', async () => {
  const result = await readComputerStatus();
  assert.ok(result.memory.totalBytes > 0); assert.ok(result.agent.rssBytes > 0);
  assert.ok(result.cpu.usagePercent === null || (result.cpu.usagePercent >= 0 && result.cpu.usagePercent <= 100));
  assert.ok(result.disks.length > 0);
  assert.ok(result.gpu.unavailable || result.gpu.devices.length > 0);
  assert.match(formatComputerStatus({ content: JSON.stringify(result) }), /电脑状态/);
});
console.log(`\n${count} computer status checks passed`);
