// Isolated browser preview. No QQ connection, model calls or telemetry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-memory-preview-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.allow.groups = ['1', '2']; cfg.allow.private = ['123'];
cfg.memory.consolidateEnabled = false; cfg.providersImported = true;
cfg.api.model = 'preview-only';
setRuntimeConfig(cfg);
const { createApp } = await import('../src/app.js');
const app = createApp({ log() {} });
const msg = app.store.appendIncoming('group:1', { mid: 101, senderId: '123', senderName: '小明', text: '我喜欢合作游戏，周六可以一起玩。' });
app.memory.commitExtraction('group:1', [msg], [{ kind: 'preference', content: '小明喜欢合作游戏', subjectIds: ['123'], sourceMessageIds: [msg.id], evidence: 'explicit' }], { cursor: 0 });
app.memory.append('group:2', 'memberImpression', '常参加群内游戏讨论', { userId: '123', target: '老明' });
app.memory.saveRecord({ kind: 'fact', content: '私聊中的测试记录', subjectIds: ['123'], visibility: { type: 'chats', chatKeys: ['private:123'] } });
let r = app.memory.saveRecord({ kind: 'commitment', title: '周末联机', content: '小明与小林约好周六联机', subjectIds: ['123', '456'], status: 'pending', visibility: { type: 'chats', chatKeys: ['group:1'] } });
app.memory.saveRecord({ id: r.id, content: '周末联机已完成', status: 'completed' }, { expectedVersion: r.version });
// A completed, synthetic context record for inspecting the new diagnostics UI.
app.store.markAllRead('group:1');
const trigger = app.store.appendIncoming('group:1', { mid: 102, senderId: '123', senderName: '小明', text: '还记得周末一起玩的合作游戏吗？' });
const { buildUserPrompt, buildSystemPrompt } = await import('../src/prompt.js');
const session = app.sessions.create({ chatKey: 'group:1', trigger: [trigger], triggerSummary: '上下文预览：周末合作游戏' });
session.systemPrompt = buildSystemPrompt();
session.userPrompt = buildUserPrompt({ chatKey: 'group:1', kind: 'group', chatId: '1', chatName: '预览群', store: app.store, memory: app.memory,
  triggerEntries: [trigger], session, selfId: '888', selfNickname: '预览机器人', stickerEntries: [] });
session.inputMessages = [{ role: 'system', content: session.systemPrompt }, { role: 'user', content: session.userPrompt }];
app.sessions.finish(session.id, 'noreply');
app.store.markAllRead('group:1');
app.server.listen(0, '127.0.0.1', () => console.log(`MEMORY_PREVIEW_URL=http://127.0.0.1:${app.server.address().port}`));
async function stop() {
  await app.stop();
  if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('qq-agent-memory-preview-')) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
