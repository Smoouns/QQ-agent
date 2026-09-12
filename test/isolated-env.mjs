// 必须在导入 src 模块之前执行，保证测试不读取真实配置、消息或凭据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ui-test-'));
process.env.QQ_AGENT_DATA_DIR = testDir;
process.once('exit', () => {
  if (path.dirname(testDir) === path.resolve(os.tmpdir()) && path.basename(testDir).startsWith('qq-agent-ui-test-')) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
