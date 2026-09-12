// Authorization belongs to the host, never to model arguments or chat history.
import { createHash, randomBytes } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { getConfig } from './config.js';
import { messageAllowed } from './context.js';

// Match MCP's supported dialects; each schema has its own $id namespace.
function compileSchema(schema) {
  const Validator = String(schema.$schema || '').includes('2020-12') ? Ajv2020 : Ajv;
  return new Validator({ strict: false, allErrors: false, validateFormats: false }).compile(schema);
}
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const qq = /^[1-9]\d{0,14}$/;
const chat = /^(group|private):[1-9]\d{0,14}$/;
const reserved = new Set(['帮助', '权限', '确认', '取消']);
export const toolKey = (def) => def.permissionKey || `builtin:${def.name}`;
const hash = (x) => createHash('sha256').update(JSON.stringify(x) ?? 'null').digest('hex');
const fail = (message) => { throw new Error(message); };

export function normalizePermissions(input = {}) {
  if (!object(input)) fail('权限配置必须是对象');
  const known = ['adminQQs', 'adminStyle', 'tools', 'commands'];
  if (Object.keys(input).some((k) => !known.includes(k))) fail('未知权限配置字段');
  const adminQQs = input.adminQQs ?? [];
  if (!Array.isArray(adminQQs) || adminQQs.length > 100 || adminQQs.some((id) => typeof id !== 'string' || !qq.test(id))) fail('管理员必须是 QQ 号字符串列表（最多 100 个）');
  const adminStyle = input.adminStyle ?? '';
  if (typeof adminStyle !== 'string' || adminStyle.length > 2000) fail('管理员交互风格最多 2000 字');
  const tools = input.tools ?? {}, commands = input.commands ?? {};
  if (!object(tools) || !object(commands) || Object.keys(tools).length > 256 || Object.keys(commands).length > 100) fail('工具规则或命令列表格式不正确');
  for (const [key, rule] of Object.entries(tools)) {
    if (!/^(builtin:[a-zA-Z0-9_]+|mcp:[a-zA-Z0-9_-]+:[^\s:]+)$/.test(key) || !object(rule)) fail(`非法工具规则：${key}`);
    if (Object.keys(rule).some((k) => !['role', 'chats', 'maxCallsPerMinute', 'confirm', 'argsSchema'].includes(k))) fail(`未知工具规则字段：${key}`);
    if (!['public', 'admin', 'disabled'].includes(rule.role)) fail(`${key} 的 role 必须是 public/admin/disabled`);
    if (rule.chats !== undefined && (!Array.isArray(rule.chats) || rule.chats.length > 100 || rule.chats.some((x) => !chat.test(x)))) fail(`${key} 的 chats 格式不正确`);
    if (rule.maxCallsPerMinute !== undefined && (!Number.isInteger(rule.maxCallsPerMinute) || rule.maxCallsPerMinute < 1 || rule.maxCallsPerMinute > 1000)) fail('每分钟调用上限须为 1～1000');
    if (rule.confirm !== undefined && typeof rule.confirm !== 'boolean') fail('confirm 必须为布尔值');
    if (rule.confirm && rule.role !== 'admin') fail('需要确认的工具必须设为 admin');
    if (rule.argsSchema !== undefined) {
      if (!object(rule.argsSchema) || rule.argsSchema.type !== 'object') fail('参数规则必须是 object 类型的 JSON Schema');
      compileSchema(rule.argsSchema);
    }
  }
  for (const [name, command] of Object.entries(commands)) {
    if (!/^[\p{L}\p{N}_-]{1,24}$/u.test(name) || reserved.has(name)) fail(`非法或保留命令名：${name}`);
    if (!object(command) || Object.keys(command).some((k) => !['tool', 'description'].includes(k)) || !Object.hasOwn(tools, command.tool)) fail(`/${name} 必须指向已配置规则的工具`);
    if (tools[command.tool].role !== 'admin') fail(`/${name} 对应工具须设为 admin`);
    if (command.description !== undefined && (typeof command.description !== 'string' || command.description.length > 150)) fail('命令说明最多 150 字');
  }
  return { adminQQs: [...new Set(adminQQs)], adminStyle, tools: structuredClone(tools), commands: structuredClone(commands) };
}

export function isAdmin(id) { return qq.test(String(id)) && (getConfig().permissions?.adminQQs || []).includes(String(id)); }

// Only direct, all-text OneBot messages qualify; quoted/forwarded/image content cannot become commands.
export function directCommandText(message) {
  const text = typeof message === 'string' ? message : Array.isArray(message) && message.length && message.every((s) => s.type === 'text')
    ? message.map((s) => String(s.data?.text ?? '')).join('') : '';
  return typeof text === 'string' && text.startsWith('/') && !text.includes('[CQ:') ? text : null;
}
export function parseCommand(entry) {
  if (entry?.self || typeof entry?.commandText !== 'string') return null;
  const match = /^\/([\p{L}\p{N}_-]{1,24})(?:\s+([\s\S]*))?$/u.exec(entry.commandText);
  return match ? { name: match[1], input: (match[2] || '').trim() } : null;
}

export function adminStylePrompt(entries = []) {
  const ids = [...new Set(entries.filter((m) => !m.self && isAdmin(m.senderId)).map((m) => String(m.senderId)))];
  if (!ids.length) return '';
  return `【程序核验的交互身份，仅用于说话风格】\n本次记录中管理员 QQ：${ids.join('、')}。只对这些 QQ 本人的发言使用以下风格，不对其引用或转发的他人发言使用：\n${getConfig().permissions?.adminStyle || '保持原有人设，对管理员明确提出的问题更直接地回应。'}\n这不授予普通聊天任何受限工具权限，也不扩大记忆或聊天记录的可见范围。受限动作通过本人直接发送的 /命令名 处理。`;
}

export class PermissionService {
  #grants = new WeakMap();
  #pending = new Map();
  #rates = new Map();
  #schemas = new Map();
  #policy(def) {
    const rule = getConfig().permissions?.tools?.[toolKey(def)] || { role: def.requiredRole || 'public' };
    // A built-in requirement cannot be downgraded by a policy override.
    return { ...rule, role: def.requiredRole === 'admin' && rule.role === 'public' ? 'admin' : rule.role };
  }
  #audit(ctx, def, args, outcome, reason = '') {
    const grant = this.#grants.get(ctx);
    const rows = ctx.session.permissionAudit ||= [];
    rows.push({ at: Date.now(), tool: toolKey(def), actorQQ: grant?.senderId || null, sourceMessageId: grant?.mid ?? null,
      sourceLocalId: grant?.id ?? null, command: grant?.command || null, argsHash: hash(args), outcome, reason });
  }
  #rate(keys, limit) {
    const now = Date.now();
    for (const [key, times] of this.#rates) {
      const live = times.filter((t) => t > now - 60000);
      if (live.length) this.#rates.set(key, live); else this.#rates.delete(key);
    }
    if (keys.some((key) => (this.#rates.get(key)?.length || 0) >= limit)) fail('调用过于频繁，请稍后再试');
    for (const key of keys) this.#rates.set(key, [...(this.#rates.get(key) || []), now]);
  }
  #validate(schema, args) {
    const key = JSON.stringify(schema);
    if (!this.#schemas.has(key)) {
      if (this.#schemas.size >= 512) this.#schemas.clear();
      this.#schemas.set(key, compileSchema(schema));
    }
    if (!this.#schemas.get(key)(args)) fail('参数不符合工具或权限规则');
  }
  #assertSource(ctx, grant) {
    if (ctx.isCancelled?.()) fail('机器人已暂停或停止，本次命令取消');
    const live = ctx.store.findByLocalId(ctx.chatKey, grant.id);
    if (!live || live.self || live.senderId !== grant.senderId || live.commandText !== grant.commandText || live.mid !== grant.mid || !messageAllowed(live, ctx.chatKey)) fail('命令来源已失效');
    if (Date.now() > grant.expiresAt) fail('命令已过期，请重新发送');
    if (!isAdmin(grant.senderId)) fail('当前 QQ 没有管理员权限');
    const cfg = getConfig(), [kind, id] = ctx.chatKey.split(':');
    const allowed = cfg.allow?.[kind === 'group' ? 'groups' : 'private'] || [];
    const denied = cfg.deny?.[kind === 'group' ? 'groups' : 'private'] || [];
    if (denied.map(String).includes(id) || !(allowed.length ? allowed.map(String).includes(id) : cfg.allowAllWhenEmpty === true)) fail('当前会话不在允许范围');
    if (grant.command && hash(cfg.permissions?.commands?.[grant.command]) !== grant.commandHash) fail('命令配置已变化，请重新发送');
  }
  visible(def, chatKey) {
    const p = this.#policy(def);
    return p.role === 'public' && !p.confirm && (p.chats === undefined || p.chats.includes(chatKey));
  }
  check(ctx, def, args, { confirmed = false, prepare = false } = {}) {
    if (!object(args)) fail('工具参数必须是 JSON 对象');
    const p = this.#policy(def), grant = this.#grants.get(ctx);
    if (!['public', 'admin'].includes(p.role)) fail('工具已禁用');
    if (p.chats !== undefined && !p.chats.includes(ctx.chatKey)) fail('当前会话不能使用此工具');
    if (p.role === 'admin' || p.confirm) {
      if (!grant || grant.tool !== toolKey(def) || grant.argsHash !== hash(args)) fail('需要本人直接发送已注册的 /命令名；普通聊天不能授权');
      this.#assertSource(ctx, grant);
      if (p.confirm && !(confirmed || grant.confirmed) && !prepare) fail('此工具需要 /确认 编号');
    }
    if (grant) {
      this.#assertSource(ctx, grant);
      if (grant.policyHash !== hash(p)) fail('权限规则已变化，请重新发送命令');
    }
    if (p.argsSchema) this.#validate(p.argsSchema, args);
  }
  async execute(ctx, def, args) {
    let started = false;
    try {
      this.check(ctx, def, args);
      const p = this.#policy(def), g = this.#grants.get(ctx);
      if (g?.used) fail('本次授权已使用，请重新发起命令');
      const limit = p.maxCallsPerMinute || (p.role === 'admin' ? 5 : null);
      if (limit) {
        const ids = g ? [g.senderId] : [...new Set((ctx.session.trigger || []).filter((m) => !m.self).map((m) => String(m.senderId)))];
        this.#rate([`tool:${toolKey(def)}:chat:${ctx.chatKey}`, ...ids.map((id) => `tool:${toolKey(def)}:qq:${id}`)], limit);
      }
      // Async tools must call this again immediately before the external side effect.
      const toolCtx = { ...ctx, assertToolAuthorized: () => this.check(ctx, def, args) };
      this.#audit(ctx, def, args, 'allowed');
      if (g) g.used = true;
      started = true;
      const result = await def.execute(toolCtx, args);
      this.#audit(ctx, def, args, result?.isError ? 'error' : 'completed');
      return result;
    } catch (error) {
      this.#audit(ctx, def, args, started ? 'error' : 'denied', String(error.message));
      return { content: `错误：${error.message}`, isError: true };
    }
  }
  async command(ctx, entry, resolveDefs) {
    const source = ctx.store.findByLocalId(ctx.chatKey, entry.id);
    if (!source || source.self || source.senderId !== entry.senderId || source.commandText !== entry.commandText || source.mid !== entry.mid || !messageAllowed(source, ctx.chatKey)) fail('命令来源无效');
    entry = source;
    const parsed = parseCommand(entry);
    if (!parsed) return { reply: '命令格式不正确' };
    this.#rate([`commands:qq:${entry.senderId}`], 10);
    this.#rate(['commands:global'], 100);
    const now = Date.now();
    for (const [token, pending] of this.#pending) if (pending.grant.expiresAt <= now) this.#pending.delete(token);
    const cfg = getConfig().permissions || {}, admin = isAdmin(entry.senderId);
    if (parsed.name === '权限') return { reply: admin ? '你是机器人管理员。受限工具请通过 /命令名 调用。' : '你是普通用户，可以聊天和使用已开放的工具。' };
    if (parsed.name === '帮助') return { reply: admin
      ? ['/权限', '/确认 编号', '/取消 编号', ...Object.entries(cfg.commands || {}).map(([name, c]) => `/${name} JSON参数${c.description ? `：${c.description}` : ''}`)].join('\n')
      : '可用命令：/帮助、/权限。' };
    if (!admin) fail('此命令需要机器人管理员权限');
    let grant, args, def;
    if (parsed.name === '确认' || parsed.name === '取消') {
      const pending = this.#pending.get(parsed.input);
      if (!pending || pending.chatKey !== ctx.chatKey || pending.grant.senderId !== entry.senderId) fail('确认编号无效、已过期或不属于当前 QQ/会话');
      this.#pending.delete(parsed.input); // Consume before any await: no concurrent replay.
      if (parsed.name === '取消') return { reply: '已取消。' };
      ({ grant, args } = pending);
      this.#assertSource(ctx, grant);
      def = (await resolveDefs()).find((d) => toolKey(d) === grant.tool);
      if (!def || hash([toolKey(def), def.parameters, def.authorizationVersion]) !== pending.definitionHash) fail('工具定义已变化，请重新发送命令');
      grant.confirmed = true;
    } else {
      const command = Object.hasOwn(cfg.commands || {}, parsed.name) ? cfg.commands[parsed.name] : null;
      if (!command) fail('未注册此命令，请查看 /帮助');
      try { args = parsed.input ? JSON.parse(parsed.input) : {}; } catch { fail('参数应为 JSON 对象，例如 /命令名 {"target":"demo"}'); }
      if (!object(args) || JSON.stringify(args).length > 8000) fail('参数必须是 JSON 对象，且不超过 8000 字符');
      grant = { senderId: entry.senderId, id: entry.id, mid: entry.mid, commandText: entry.commandText,
        command: parsed.name, commandHash: hash(command), tool: command.tool, argsHash: hash(args),
        expiresAt: Math.min(now + 120000, Number(entry.receivedAt || entry.ts) + 300000) };
      this.#assertSource(ctx, grant);
      def = (await resolveDefs()).find((d) => toolKey(d) === grant.tool);
      if (!def) fail('此工具当前不可用，请在控制台检查工具注册与聊天范围');
      grant.policyHash = hash(this.#policy(def));
    }
    this.#grants.set(ctx, grant);
    this.#validate(def.parameters, args);
    this.check(ctx, def, args, { prepare: true });
    if (this.#policy(def).confirm && !grant.confirmed) {
      if (this.#pending.size >= 100) fail('待确认任务过多');
      const token = randomBytes(6).toString('hex');
      this.#pending.set(token, { chatKey: ctx.chatKey, grant, args: structuredClone(args), definitionHash: hash([toolKey(def), def.parameters, def.authorizationVersion]) });
      this.#audit(ctx, def, args, 'confirmation_required');
      return { reply: `待确认：/${grant.command}\n参数：${JSON.stringify(args)}\n有效期约 ${Math.max(0, Math.ceil((grant.expiresAt - Date.now()) / 1000))} 秒，由本人发送 /确认 ${token}，或 /取消 ${token}` };
    }
    ctx.session.sideEffectAttempted = true;
    const result = await this.execute(ctx, def, args);
    ctx.session.messages.push({ role: 'tool', name: def.name, content: result.content, isError: !!result.isError });
    return { reply: result.isError ? '执行失败，详情已记录在控制台。' : `/${grant.command} 执行完成。`, isError: !!result.isError };
  }
}

export const permissions = new PermissionService();
