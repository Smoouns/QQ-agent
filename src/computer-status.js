// Local, read-only metrics. GPU queries use a fixed executable and arguments, without a shell.
import os from 'node:os';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';

const percent = (used, total) => total > 0 ? Math.round(Math.max(0, Math.min(1, used / total)) * 1000) / 10 : null;
const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runFile = promisify(execFile);
const gpuArgs = Object.freeze(['--query-gpu=index,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']);

export function parseGpuStatus(csv) {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { unavailable: true };
  const number = (value) => /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const devices = [];
  for (const line of lines) {
    const fields = line.split(',').map((s) => s.trim());
    if (fields.length !== 4 || !/^\d+$/.test(fields[0]) || !Number.isSafeInteger(Number(fields[0]))) return { unavailable: true };
    const [index, usage, used, total] = fields.map(number);
    devices.push({ index, usagePercent: usage !== null && usage <= 100 ? usage : null,
      memory: used !== null && total > 0 && used <= total
        ? { usedBytes: used * 1024 ** 2, totalBytes: total * 1024 ** 2, usedPercent: percent(used, total) }
        : { unavailable: true } });
  }
  return { devices };
}

export async function readGpuStatus({ run = runFile, platform = process.platform,
  systemRoot = process.env.SystemRoot, programFiles = process.env.ProgramW6432 || process.env.ProgramFiles } = {}) {
  const candidates = platform === 'win32'
    ? [systemRoot && path.win32.join(systemRoot, 'System32', 'nvidia-smi.exe'),
      programFiles && path.win32.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')].filter(Boolean)
    : platform === 'linux' ? ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi'] : [];
  for (const executable of candidates) {
    try {
      const { stdout } = await run(executable, [...gpuArgs], { shell: false, windowsHide: true,
        timeout: 2000, maxBuffer: 64 * 1024, encoding: 'utf8' });
      return parseGpuStatus(stdout);
    } catch (error) {
      // Retry only a missing executable; never publish driver stderr or local paths.
      if (error.code !== 'ENOENT') break;
    }
  }
  return { unavailable: true };
}

export function cpuUsage(before, after) {
  if (!before.length || before.length !== after.length) return null;
  let total = 0, idle = 0;
  for (let i = 0; i < before.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = after[i]?.times?.[key] - before[i]?.times?.[key];
      if (!Number.isFinite(delta) || delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return percent(total - idle, total);
}

async function diskSpace(root, readFs, timeoutMs) {
  let timer;
  try {
    const stats = await Promise.race([
      readFs(root),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })
    ]);
    const totalBytes = nonnegative(Number(stats.bsize) * Number(stats.blocks));
    const availableBytes = nonnegative(Number(stats.bsize) * Number(stats.bavail));
    if (!totalBytes || availableBytes === null || availableBytes > totalBytes) return null;
    return { totalBytes, availableBytes, usedPercent: percent(totalBytes - availableBytes, totalBytes) };
  } catch { return null; } // Do not expose paths or raw system errors to QQ.
  finally { clearTimeout(timer); }
}

export async function readComputerStatus({ system = os, readFs = statfs, readGpu = readGpuStatus, wait = sleep,
  dataDir = DATA_DIR, systemRoot = process.env.SystemRoot, diskTimeoutMs = 2000 } = {}) {
  const started = performance.now();
  const safeCpus = () => { try { return system.cpus(); } catch { return []; } };
  const before = safeCpus();
  const gpu = Promise.resolve().then(() => readGpu()).catch(() => ({ unavailable: true }));
  const platform = system.platform();
  const paths = platform === 'win32' ? path.win32 : path;
  const roots = [...new Set([platform === 'win32' ? paths.parse(paths.resolve(dataDir)).root : paths.resolve(dataDir),
    ...(platform === 'win32' && systemRoot ? [paths.parse(systemRoot).root] : [])].filter(Boolean))];
  const disks = Promise.all(roots.map(async (root, i) => ({
    label: /^[A-Za-z]:[\\/]$/.test(root) ? root.slice(0, 2).toUpperCase() : (i === 0 ? '程序所在卷' : '系统卷'),
    ...(await diskSpace(root, readFs, diskTimeoutMs) || { unavailable: true })
  })));
  await wait(500);
  const after = safeCpus();
  const sampleMs = Math.round(performance.now() - started);
  const totalBytes = nonnegative(system.totalmem());
  const freeBytes = nonnegative(system.freemem());
  const memory = totalBytes && freeBytes !== null && freeBytes <= totalBytes
    ? { totalBytes, availableBytes: freeBytes, usedPercent: percent(totalBytes - freeBytes, totalBytes) }
    : { unavailable: true };
  return {
    sampledAt: new Date().toISOString(),
    system: { platform, release: system.release(), arch: system.arch(), uptimeSeconds: Math.floor(system.uptime()) },
    cpu: { logicalCores: after.length || before.length, usagePercent: cpuUsage(before, after), sampleMs },
    memory,
    gpu: await gpu,
    disks: await disks,
    agent: { uptimeSeconds: Math.floor(process.uptime()), rssBytes: process.memoryUsage().rss }
  };
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未知';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), mins = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days}天` : ''}${hours}小时${mins}分`;
}
const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1);
export function formatComputerStatus(result) {
  const s = JSON.parse(result.content);
  const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[s.system.platform] || s.system.platform;
  return [
    `电脑状态：${platform} ${s.system.release}（${s.system.arch}）`,
    `CPU：${s.cpu.usagePercent === null ? '暂不可用' : `${s.cpu.usagePercent}%`}，${s.cpu.logicalCores} 个逻辑核心（短时采样）`,
    s.memory.unavailable ? '内存：暂不可用' : `内存：${gib(s.memory.totalBytes - s.memory.availableBytes)} / ${gib(s.memory.totalBytes)} GiB（${s.memory.usedPercent}%）`,
    ...(!s.gpu?.devices?.length ? ['GPU：暂不可用（需 NVIDIA 驱动及 nvidia-smi 支持）'] : s.gpu.devices.map((g) =>
      `GPU ${g.index}（NVIDIA）：${g.usagePercent === null ? '利用率暂不可用' : `利用率 ${g.usagePercent}%`}，${g.memory.unavailable
        ? '显存暂不可用' : `显存 ${gib(g.memory.usedBytes)} / ${gib(g.memory.totalBytes)} GiB（${g.memory.usedPercent}%）`}`)),
    ...s.disks.map((d) => d.unavailable ? `磁盘 ${d.label}：暂不可用` : `磁盘 ${d.label}：可用 ${gib(d.availableBytes)} / ${gib(d.totalBytes)} GiB`),
    `系统已运行：${duration(s.system.uptimeSeconds)}`,
    `机器人已运行：${duration(s.agent.uptimeSeconds)}，内存 RSS ${(s.agent.rssBytes / 1024 ** 2).toFixed(0)} MiB`
  ].join('\n');
}

export function createComputerStatusTool(readStatus = readComputerStatus) {
  return {
    name: 'get_computer_status',
    requiredRole: 'admin',
    defaultMaxCallsPerMinute: 3,
    description: '管理员查看本机 CPU、内存、NVIDIA GPU 利用率与显存、系统及程序所在磁盘空间和运行时间；只读，无参数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    formatCommandResult: formatComputerStatus,
    async execute(ctx, args) {
      if (!ctx.assertToolAuthorized) throw new Error('电脑状态必须通过权限检查后读取');
      if (!args || Array.isArray(args) || Object.keys(args).length) throw new Error('电脑状态不接受参数');
      ctx.assertToolAuthorized();
      const status = await readStatus();
      ctx.assertToolAuthorized();
      return { content: JSON.stringify(status), isError: false };
    }
  };
}
