// 隔离的控制台预览：只用临时数据和本地测试 MCP，不启动 OneBot 或遥测。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-mcp-preview-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.allow.groups = ['1'];
cfg.memory.consolidateEnabled = false;
setRuntimeConfig(cfg);
const { createApp } = await import('../src/app.js');
const app = createApp({ log: () => {} });
const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
await app.mcp.upsert({ name: '本地演示（测试用）', command: process.execPath, args: [fixture, '--stdio'] });
app.server.listen(0, '127.0.0.1', () => console.log(`MCP_PREVIEW_URL=http://127.0.0.1:${app.server.address().port}`));
async function stop() {
  await app.stop();
  if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('qq-agent-mcp-preview-')) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
