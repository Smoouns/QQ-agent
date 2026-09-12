// 管理员配置的 MCP 服务。仅接入 tools，不向服务开放 QQ 凭据、聊天历史或模型采样。
import crypto from 'node:crypto';
import path from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { getConfig, updateConfig } from './config.js';

const MAX_TOOLS = 256;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fingerprint = (s) => JSON.stringify(s);
const requestOptions = (s) => ({ timeout: s.timeoutMs, maxTotalTimeout: s.timeoutMs, resetTimeoutOnProgress: false });

function stringMap(value, label) {
  if (!object(value)) throw new Error(`${label} 必须是 JSON 对象`);
  if (Object.keys(value).length > 64) throw new Error(`${label} 最多 64 项`);
  for (const [k, v] of Object.entries(value)) {
    if (!k || typeof v !== 'string' || /[\r\n\0]/.test(k) || v.includes('\0')) throw new Error(`${label} 的键和值必须是有效字符串`);
    if (label === 'HTTP 请求头' && (/[\r\n]/.test(v) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(k))) throw new Error('HTTP 请求头格式不正确');
    if (label === '环境变量' && !/^[a-z_][a-z0-9_]*$/i.test(k)) throw new Error('环境变量名格式不正确');
  }
  return { ...value };
}

function boundedInt(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} 必须为 ${min}–${max} 的整数`);
  return n;
}

export function normalizeMcpServer(input, previous = null) {
  if (!object(input)) throw new Error('服务配置必须是对象');
  const s = { ...(previous || {}), ...input };
  const id = String(previous?.id || s.id || crypto.randomBytes(6).toString('hex'));
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(id)) throw new Error('服务 ID 只能包含字母、数字、下划线和短横线，最多 24 字符');
  const name = String(s.name || '').trim();
  if (!name || name.length > 80) throw new Error('请填写服务名称（最多 80 字符）');
  const transport = s.transport || 'stdio';
  if (!['stdio', 'http'].includes(transport)) throw new Error('只支持 stdio 和 Streamable HTTP');
  const enabledTools = s.enabledTools ?? [];
  if (!Array.isArray(enabledTools) || enabledTools.length > MAX_TOOLS || enabledTools.some((x) => typeof x !== 'string' || !x || x.length > 200)) throw new Error('启用工具列表格式不正确');
  const scope = s.scope ?? { mode: 'all', chatKeys: [] };
  if (!object(scope) || !['all', 'selected'].includes(scope.mode) || !Array.isArray(scope.chatKeys) || scope.chatKeys.some((k) => !/^(group|private):\d+$/.test(k))) throw new Error('适用聊天格式不正确');
  const out = {
    id, name, transport, enabled: s.enabled === true,
    enabledTools: [...new Set(enabledTools)],
    scope: { mode: scope.mode, chatKeys: [...new Set(scope.chatKeys)] },
    timeoutMs: boundedInt(s.timeoutMs, 30000, 1000, 180000, '超时毫秒数'),
    maxResultChars: boundedInt(s.maxResultChars, 8000, 512, 50000, '结果字符上限')
  };
  if (transport === 'stdio') {
    out.command = String(s.command || '').trim();
    if (!out.command || /[\r\n\0]/.test(out.command)) throw new Error('请填写可执行程序名称或路径');
    if (!Array.isArray(s.args ?? []) || (s.args ?? []).some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Error('启动参数必须是字符串数组');
    out.args = s.args ?? [];
    out.cwd = String(s.cwd || '').trim();
    if (out.cwd && !path.isAbsolute(out.cwd)) throw new Error('工作目录必须填写绝对路径');
    out.env = stringMap(s.env ?? {}, '环境变量');
  } else {
    let url;
    try { url = new URL(s.url); } catch { throw new Error('请填写有效的 MCP 服务 URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP URL 必须使用 http(s)，认证信息请放入请求头');
    out.url = url.href;
    out.headers = stringMap(s.headers ?? {}, 'HTTP 请求头');
  }
  return out;
}

export function publicMcpServer(s) {
  const { env, headers, ...rest } = s;
  return { ...rest, envKeys: Object.keys(env || {}), headerKeys: Object.keys(headers || {}) };
}

export function mcpToolName(serverId, toolName) {
  const hash = crypto.createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 12);
  const slug = String(toolName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  return `mcp_${serverId}_${slug}_${hash}`; // ≤ 62，避免与内置工具或其他服务同名
}

function allowed(s, chatKey) {
  return s.enabled && (s.scope.mode === 'all' || s.scope.chatKeys.includes(chatKey));
}

function chatAllowed(cfg, chatKey) {
  if (!/^(group|private):\d+$/.test(chatKey)) return false;
  const [kind, id] = chatKey.split(':');
  const denied = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  const permitted = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  return !denied.map(String).includes(id) && (permitted.length ? permitted.map(String).includes(id) : cfg.allowAllWhenEmpty === true);
}

export function formatMcpResult(result, maxChars = 8000) {
  const parts = [];
  for (const c of result.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource' && typeof c.resource?.text === 'string') parts.push(c.resource.text);
    else if (c.type === 'resource_link') parts.push(`[资源链接] ${c.name || ''} ${c.uri || ''}`);
    else parts.push(`[MCP 返回 ${c.type || '未知'} 内容；当前仅支持文本和结构化结果]`);
  }
  if (result.structuredContent != null) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n') || '（工具没有返回文本）';
  const suffix = '\n[结果已截断，请缩小查询范围]';
  return { content: text.length > maxChars ? text.slice(0, maxChars - suffix.length) + suffix : text, isError: result.isError === true };
}

export class McpManager {
  constructor({ config = getConfig, save = updateConfig } = {}) {
    this.config = config;
    this.save = save;
    this.entries = new Map();
    this.closed = false;
    this.ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, addUsedSchema: false });
    this.ajv2020 = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, addUsedSchema: false });
  }

  servers() { return this.config().mcp?.servers || []; }
  get(id) {
    const s = this.servers().find((x) => x.id === id);
    if (!s) throw new Error('找不到 MCP 服务');
    return s;
  }

  list() {
    return this.servers().map((s) => {
      const e = this.entries.get(s.id);
      return {
        ...publicMcpServer(s), status: e?.status || 'disconnected', error: e?.error || '',
        tools: (e?.tools || []).map(({ validate, ...t }) => ({ ...t, enabled: s.enabledTools.includes(t.name) }))
      };
    });
  }

  async upsert(input) {
    const previous = input?.id ? this.servers().find((s) => s.id === input.id) : null;
    const next = normalizeMcpServer(input, previous);
    const servers = this.servers().filter((s) => s.id !== next.id);
    if (servers.length >= 16) throw new Error('最多添加 16 个 MCP 服务');
    servers.push(next);
    this.save({ mcp: { servers } });
    await this.reconcile();
    return this.list().find((s) => s.id === next.id);
  }

  async remove(id) {
    this.get(id);
    this.save({ mcp: { servers: this.servers().filter((s) => s.id !== id) } });
    await this.reconcile();
  }

  async reconcile() {
    await Promise.all([...this.entries].map(async ([id, e]) => {
      const s = this.servers().find((s) => s.id === id);
      if (!s || fingerprint(s) !== e.fingerprint) {
        this.entries.delete(id);
        await this.dispose(e);
      }
    }));
  }

  safeError(error, s) {
    let msg = String(error?.message || error);
    const secrets = [...Object.values(s.env || {}), ...Object.values(s.headers || {})].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of secrets) msg = msg.split(secret).join('[已隐藏]');
    // HTTP SDK 的错误可能含整个请求 URL；不向聊天记录泄露查询参数中的凭据。
    if (s.url) msg = msg.split(s.url).join('[MCP 地址]');
    return msg.slice(0, 600);
  }

  async dispose(e) {
    e.retired = true;
    e.discoveryAbort?.abort();
    await e.client?.close().catch(() => {});
    await e.transport?.close().catch(() => {});
  }

  async close() {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((e) => this.dispose(e)));
  }

  async ensure(id, { refresh = false } = {}) {
    if (this.closed) throw new Error('MCP 管理器已关闭');
    const s = this.get(id);
    let e = this.entries.get(id);
    if (e && e.fingerprint !== fingerprint(s)) {
      this.entries.delete(id);
      await this.dispose(e);
      e = null;
    }
    if (e?.promise) return e.promise;
    if (e?.status === 'connected' && !refresh && !e.stale) return e;
    if (e?.status === 'error' && !refresh && Date.now() - e.failedAt < 30000) throw new Error(e.error);
    if (!e || e.status !== 'connected') {
      if (e) await this.dispose(e);
      e = { fingerprint: fingerprint(s), tools: [], status: 'connecting', error: '', retired: false };
      this.entries.set(id, e);
    }
    e.promise = this.connectAndList(s, e).finally(() => { e.promise = null; });
    return e.promise;
  }

  async connectAndList(s, e) {
    const controller = new AbortController();
    e.discoveryAbort = controller;
    const deadline = setTimeout(() => controller.abort(new Error('MCP 连接和发现工具超时')), s.timeoutMs);
    const options = { ...requestOptions(s), signal: controller.signal };
    try {
      if (!e.client) {
        e.client = new Client({ name: 'qq-agent', version: '0.3.0' }, { capabilities: {} });
        if (s.transport === 'stdio') {
          e.transport = new StdioClientTransport({ command: s.command, args: s.args, cwd: s.cwd || undefined, env: s.env, stderr: 'pipe', maxBufferSize: 4 * 1024 * 1024 });
          // 消费 stderr 避免管道堵塞；只保留脱敏后的末尾错误，绝不直接打到日志。
          e.transport.stderr?.on('data', (chunk) => { e.stderr = this.safeError(String(chunk), s).slice(-400); });
        } else {
          e.transport = new StreamableHTTPClientTransport(new URL(s.url), {
            requestInit: { headers: s.headers, redirect: 'error' },
            fetch: (url, init = {}) => fetch(url, {
              ...init, redirect: 'error',
              signal: init.method === 'GET' ? init.signal : AbortSignal.any([...(init.signal ? [init.signal] : []), ...(e.discoveryAbort ? [e.discoveryAbort.signal] : []), AbortSignal.timeout(s.timeoutMs)])
            })
          });
        }
        e.client.onclose = () => {
          if (!e.retired) { e.status = 'error'; e.failedAt = Date.now(); e.error = 'MCP 连接已断开'; }
        };
        e.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { e.stale = true; });
        await e.client.connect(e.transport, options);
      }
      const tools = [];
      const names = new Set();
      const cursors = new Set();
      let cursor;
      do {
        const page = await e.client.listTools(cursor ? { cursor } : {}, options);
        for (const t of page.tools) {
          if (tools.length >= MAX_TOOLS) throw new Error(`服务工具超过 ${MAX_TOOLS} 个，请缩小服务范围`);
          if (names.has(t.name)) throw new Error('服务返回了重复的工具名称');
          names.add(t.name);
          let validate, unavailableReason = '';
          try {
            if (t.inputSchema?.type !== 'object') throw new Error('输入 Schema 必须为 object');
            if (JSON.stringify(t.inputSchema).length > 32000) throw new Error('输入 Schema 太大');
            validate = (String(t.inputSchema.$schema || '').includes('2020-12') ? this.ajv2020 : this.ajv).compile(t.inputSchema);
          } catch (error) { unavailableReason = `参数 Schema 不支持：${this.safeError(error, s)}`; }
          tools.push({ name: t.name, modelName: mcpToolName(s.id, t.name), description: String(t.description || '').slice(0, 4000), inputSchema: t.inputSchema, unavailableReason, validate });
        }
        cursor = page.nextCursor;
        if (cursor && (cursors.has(cursor) || cursors.size >= 16)) throw new Error('MCP 工具分页异常');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (e.retired || this.closed || fingerprint(this.get(s.id)) !== e.fingerprint) throw new Error('MCP 配置已变更，请重新连接');
      e.tools = tools;
      e.stale = false;
      e.status = 'connected';
      e.error = '';
      return e;
    } catch (error) {
      e.status = 'error';
      e.failedAt = Date.now();
      e.error = this.safeError(error, s) + (e.stderr ? `；${e.stderr}` : '');
      await this.dispose(e);
      throw new Error(e.error);
    } finally {
      clearTimeout(deadline);
      e.discoveryAbort = null;
    }
  }

  async toolDefsForChat(chatKey) {
    const defs = [];
    const warnings = [];
    if (!chatAllowed(this.config(), chatKey)) return { defs, warnings };
    await Promise.all(this.servers().filter((s) => allowed(s, chatKey) && s.enabledTools.length).map(async (s) => {
      try {
        const e = await this.ensure(s.id);
        const current = this.get(s.id);
        if (!allowed(current, chatKey)) return;
        for (const t of e.tools) {
          if (!current.enabledTools.includes(t.name)) continue;
          if (t.unavailableReason) { warnings.push(`${s.name}/${t.name}：${t.unavailableReason}`); continue; }
          defs.push({
            name: t.modelName,
            permissionKey: `mcp:${s.id}:${t.name}`,
            authorizationVersion: e.fingerprint,
            description: `[外部工具：${s.name}] ${t.description || t.name}`,
            parameters: t.inputSchema,
            async execute(ctx, args) {
              // 在任何可能的外部副作用前设置；整轮重试不能重复执行外部动作。
              ctx.session.externalToolAttempted = true;
              return ctx.mcp.call(s.id, t.name, args, ctx.chatKey, ctx.assertToolAuthorized, e.fingerprint);
            }
          });
        }
      } catch (error) { warnings.push(`${s.name}：${this.safeError(error, s)}`); }
    }));
    defs.sort((a, b) => a.name.localeCompare(b.name));
    if (defs.length > 64) warnings.push('本次最多提供 64 个 MCP 工具，请减少启用数量或限定适用聊天');
    return { defs: defs.slice(0, 64), warnings };
  }

  async call(id, name, args, chatKey, beforeCall = null, expectedVersion = null) {
    const s = this.get(id);
    if (!chatAllowed(this.config(), chatKey) || !allowed(s, chatKey) || !s.enabledTools.includes(name)) return { content: '错误：当前聊天未获准使用该 MCP 工具', isError: true };
    try {
      const e = await this.ensure(id);
      const live = this.get(id);
      if (!chatAllowed(this.config(), chatKey) || !allowed(live, chatKey) || !live.enabledTools.includes(name) || fingerprint(live) !== e.fingerprint) throw new Error('工具配置已变更，本次调用取消');
      if (expectedVersion !== null && expectedVersion !== e.fingerprint) throw new Error('工具配置已变化，请重新发起调用');
      const tool = e.tools.find((t) => t.name === name);
      if (!tool || tool.unavailableReason) throw new Error(tool?.unavailableReason || '服务已不再提供该工具');
      if (!object(args) || !tool.validate(args)) throw new Error(`工具参数不符合 Schema：${this.ajv.errorsText(tool.validate.errors)}`);
      beforeCall?.();
      const result = await e.client.callTool({ name, arguments: args }, undefined, requestOptions(s));
      return formatMcpResult(result, s.maxResultChars);
    } catch (error) {
      // 不自动重试调用：超时并不证明外部服务没有执行动作。
      return { content: `MCP 调用失败（未自动重试）：${this.safeError(error, s)}`, isError: true };
    }
  }
}
