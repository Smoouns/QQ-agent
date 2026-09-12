// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 固定消息边界和上下文 → agent 用工具发言/决定不发言 → 确认已处理批次
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, storeConfigForChat } from './config.js';
import { vendorOfConfig } from './model-prices.js';
import { sleep, randInt, createEventBus, todayKey } from './util.js';
import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
import { modelImageVerdict } from './vision-scan.js';
import { currentProviders } from './providers.js';
import { MemoryPipeline } from './memory-pipeline.js';
import { selectWindow, messageAllowed, assertContextAllowed, recallMemories, primarySubjects } from './context.js';
import { permissions, parseCommand } from './permissions.js';

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null, mcp = null }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();
    this.mcp = mcp;

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.gateRolls = new Map();
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
    this.memoryPipeline = new MemoryPipeline({ store, memory, busy: this.consolidating, emit: this.emit,
      enabled: () => !this.paused && !this.aborted,
      runModel: (messages) => this.#memoryChat(messages) });
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    this.memoryPipeline.resume();
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    this.memoryPipeline.schedule(chatKey);
    if (this.paused || this.aborted) return;
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    this.scheduleWake(chatKey);
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  /**
   * 对"当前这批未读"做档位预判：这批消息值不值得机器人响应？
   *
   * scheduleWake（建等待会话前）与 wake（真正运行前）共用这一个函数，
   * 避免两处各写一份判定、日后逻辑漂移。
   *
   * 注意：这里**不消费**未读（用 peekUnread 只看不取），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  #predictTier(chatKey) {
    const cfg = getConfig();
    const entries = (this.store.peekUnread(chatKey, Infinity) || []).filter((m) => messageAllowed(m, chatKey));
    if (entries.some(parseCommand)) return { tier: 0, reason: '直接命令', shouldRespond: true };
    if (!this.gateRolls.has(chatKey)) this.gateRolls.set(chatKey, Math.random() * 100);
    const r = resolveContextTier({
      triggerEntries: entries,
      roll: this.gateRolls.get(chatKey),
      selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfg.persona?.botName || '',
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey)   // 按会话取档位：统一开关关闭时各群可以有独立滑条
    });
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) return { ...r, shouldRespond: false, reason: '无未读' };
    return r;
  }

  scheduleWake(chatKey, delay = null) {
    const ms = delay ?? Math.max(0, Number(getConfig().wakeDelayMs) || 2000);
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);

    // 等待窗口 > 0：在会话页立刻创建“等待中”会话，并随新消息重置倒计时
    //
    // ⚠️ 先预判再创建：档位非 4 时，若这批消息确定不会响应，
    //    就**不创建**"等待中"会话 —— 否则用户会在会话页看到一堆
    //    等半天最后变成"中止"的条目，既干扰又让人以为出了错。
    //    窗口结束前若来了新消息且命中，届时再创建（见下面 pendingSessions 分支）。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      const predicted = this.#predictTier(chatKey);
      if (predicted.shouldRespond === false) {
        // 不响应：把已存在的等待会话撤掉（例如刚被艾特、随后判定又不成立的情况）
        const stale = this.pendingSessions.get(chatKey);
        if (stale) {
          this.#discardWaiting(stale);   // 干净消失，不留"中止"
          this.pendingSessions.delete(chatKey);
        }
        this.emit('chat-update', chatKey);
        // 定时器仍然保留：窗口内可能来新消息，届时重新预判
      } else {
      const unread = this.store.peekUnread(chatKey, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const waitUntil = Date.now() + ms;
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        const s = this.sessions.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
      }
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      const waitingId = this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      this.wake(chatKey, { waitingSessionId: waitingId ?? null })
        .catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /** 手动触发一次处理（UI 按钮）。 */
  forceWake(chatKey) {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, waitingSessionId = null } = {}) {
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.paused && !proactive) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.runningChats.has(chatKey)) return;

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim() && !this.store.peekUnread(chatKey, Infinity).some(parseCommand)) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) {
        const s = this.sessions.get(waitingSessionId);
        if (s && s.status === 'waiting') {
          this.sessions.current.get(waitingSessionId).waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
        }
      }
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      return;
    }

    // Fix the batch synchronously before the first await. New arrivals stay unread.
    const boundary = this.store.boundary(chatKey);
    const pendingEntries = structuredClone(this.store.peekUnread(chatKey, Infinity));
    const commandEntry = pendingEntries.find(parseCommand);
    if (commandEntry) {
      await this.#runCommand(chatKey, commandEntry, waitingSessionId);
      return;
    }
    if (pendingEntries.length) proactive = false;
    if (!proactive && !pendingEntries.length) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return;
    }
    const tierResult = proactive ? { tier: 0, reason: '主动机会', shouldRespond: true } : this.#predictTier(chatKey);
    this.gateRolls.delete(chatKey);
    if (!tierResult.shouldRespond) {
      this.store.acknowledge(chatKey, pendingEntries.map((m) => m.id));
      if (waitingSessionId) this.#discardWaiting(waitingSessionId);
      this.emit('chat-update', chatKey);
      return;
    }
    const window = selectWindow(this.store, chatKey, proactive ? [] : pendingEntries, { boundary });
    const triggerEntries = window.trigger;
    const selectedMemories = recallMemories(this.memory, chatKey, {
      query: triggerEntries.map((m) => m.text).join('\n'),
      secondary: [...window.history.slice(-8), ...window.quotes].map((m) => m.text).join('\n'),
      subjectIds: primarySubjects(triggerEntries.length ? triggerEntries : window.history.slice(-3), this.store, chatKey)
    });

    this.runningChats.add(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind, chatId] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.activeRuns.set(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    const MAX_SESSION_ATTEMPTS = 3;   // 用户要求：自行重试两次，两次都失败才停
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          const completed = await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, window, selectedMemories, contextLimit: window.limit, tierInfo: tierResult });
          if (completed) this.store.acknowledge(chatKey, pendingEntries.map((m) => m.id));
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !session.sideEffectAttempted
            && !session.externalToolAttempted
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        session.error = String(lastError?.message ?? lastError);
        this.sessions.finish(session.id, 'error');
        this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
        console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
      }
    } finally {
      // An uncertain external action must never be automatically replayed.
      if (session.sideEffectAttempted || session.externalToolAttempted || session.sent.length) {
        this.store.acknowledge(chatKey, pendingEntries.map((m) => m.id));
      }
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0 && this.store.peekUnread(chatKey, Infinity).some((m) => m.id > boundary)) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.memoryPipeline.schedule(chatKey);
  }

  async #runCommand(chatKey, entry, waitingSessionId) {
    if (waitingSessionId) this.#discardWaiting(waitingSessionId);
    this.gateRolls.delete(chatKey);
    const session = this.sessions.create({ chatKey, trigger: [entry], triggerSummary: `命令 ${parseCommand(entry).name} · QQ ${entry.senderId}` });
    session.command = { name: parseCommand(entry).name, actorQQ: entry.senderId, sourceMessageId: entry.mid, sourceLocalId: entry.id };
    const window = selectWindow(this.store, chatKey, [entry], { limit: 0 });
    session.contextSelection = { boundary: window.boundary, beforeLocalId: entry.id, blocklist: window.blocklist,
      historyIds: [], triggerIds: [entry.id], quoteIds: [], interleavedIds: [], memories: [] };
    this.runningChats.add(chatKey);
    this.activeRuns.set(chatKey, session.id);
    this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary: session.triggerSummary });
    // Persist consumption before external actions. A crash cannot replay the command.
    this.store.acknowledge(chatKey, [entry.id]);
    const [kind, chatId] = chatKey.split(':');
    const ctx = { chatKey, kind, chatId, store: this.store, memory: this.memory, stickers: this.stickers,
      sender: this.sender, onebot: this.onebot, mcp: this.mcp, session, selfId: this.onebot.selfId,
      botName: getConfig().persona.botName, selfNickname: this.onebot.selfNickname,
      isCancelled: () => this.paused || this.aborted,
      emit: (type, payload) => this.emit(type, payload) };
    try {
      if (!messageAllowed(entry, chatKey)) throw new Error('此 QQ 已被屏蔽');
      const result = await permissions.command(ctx, entry, async () => {
        const cfg = getConfig();
        const vision = cfg.api.vision !== false && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
        const defs = this.toolDefs.filter((d) => (kind === 'group' || d.name !== 'get_group_members')
          && (vision || !['get_message_images', 'get_sticker_image'].includes(d.name))
          && (cfg.webSearch?.enabled !== false || !['web_search', 'web_fetch'].includes(d.name)));
        if (this.mcp) defs.push(...(await this.mcp.toolDefsForChat(chatKey)).defs);
        return defs;
      });
      session.finishReason = result.reply;
      const sent = await this.sender.sendTextBatch(chatKey, [result.reply], { replyToMessageId: entry.mid,
        beforeSend: () => { if (!messageAllowed(entry, chatKey)) throw new Error('此 QQ 已被屏蔽'); } });
      session.sent.push(...sent.sent);
      this.sessions.finish(session.id, result.isError ? 'error' : 'done');
    } catch (error) {
      session.error = String(error.message);
      session.feedbacks.push({ level: 'error', message: session.error, at: Date.now() });
      // No tool output or internal failure details are published to the chat.
      if (messageAllowed(entry, chatKey) && !/频繁/.test(session.error)) {
        try {
          const reply = session.sideEffectAttempted ? '命令处理未完成，请在控制台核对执行结果。' : '命令未执行：请检查 /权限、/帮助 或控制台记录。';
          const sent = await this.sender.sendTextBatch(chatKey, [reply], { replyToMessageId: entry.mid,
            beforeSend: () => { if (!messageAllowed(entry, chatKey)) throw new Error('此 QQ 已被屏蔽'); } });
          session.sent.push(...sent.sent);
        } catch { /* Keep the original command error. Never retry the action. */ }
      }
      this.sessions.finish(session.id, 'error');
    } finally {
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('session-end', { sessionId: session.id, chatKey });
      this.emit('chat-update', chatKey);
      if (!this.aborted && !this.paused && this.store.unreadCount(chatKey)) this.scheduleWake(chatKey, Math.max(200, Number(getConfig().drainDelayMs) || 1200));
      this.memoryPipeline.schedule(chatKey);
    }
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   */
  #resetSessionForRetry(session) {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.inputMessages = [];
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, window, selectedMemories, contextLimit = null, tierInfo = null }) {
    const cfg = getConfig();
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    const snapshotMessages = [...window.history, ...window.interleaved, ...window.trigger].sort((a, b) => a.id - b.id);
    const now = window.createdAt;
    const recentCount = snapshotMessages.filter((m) => m.ts >= now - 600000).length;
    const selfLastMessageAt = snapshotMessages.findLast((m) => m.self)?.ts || 0;
    const lastMessageAt = snapshotMessages.at(-1)?.ts || now;

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 组装提示词（无 LLM 历史）
    const systemPrompt = (session.contextSelection ? session.systemPrompt : buildSystemPrompt({ entries: [...snapshotMessages, ...window.quotes] }));
    const userPrompt = (session.contextSelection ? session.userPrompt : buildUserPrompt({
      window, selectedMemories, now, session, selfId: this.onebot.selfId,
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      selfNickname,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      contextLimit,
      tierInfo
    }));
    assertContextAllowed(session, this.memory, chatKey);
    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = contextLimit;
      session.contextReason = tierInfo.reason || '';
    }
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessions.update(session.id);

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;
    const toolDefs = this.toolDefs.filter((d) => {
      if (kind !== 'group' && d.name === 'get_group_members') return false;
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      return true;
    });
    if (this.mcp) {
      const external = await this.mcp.toolDefsForChat(chatKey);
      toolDefs.push(...external.defs);
      session.mcpWarnings = external.warnings;
      if (external.warnings.length) {
        session.feedbacks.push(...external.warnings.map((message) => ({ level: 'warning', message: `MCP：${message}`, at: Date.now() })));
      }
    }
    const availableDefs = toolDefs.filter((d) => permissions.visible(d, chatKey));
    const openAiTools = toOpenAiTools(availableDefs);

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      mcp: this.mcp,
      sender: this.sender,
      session,
      emit: (type, payload) => this.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return false; }
      assertContextAllowed(session, this.memory, chatKey);
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools, beforeRequest: () => assertContextAllowed(session, this.memory, chatKey) });
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;

      assertContextAllowed(session, this.memory, chatKey);
      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        break;
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        assertContextAllowed(session, this.memory, chatKey);
        const name = call?.function?.name ?? '';
        if (['send_message', 'send_sticker', 'send_poke', 'memory_append', 'memory_remove', 'collect_sticker', 'sticker_note'].includes(name)) session.sideEffectAttempted = true;
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        const result = await executeTool(availableDefs, ctx, name, argsRaw);
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    assertContextAllowed(session, this.memory, chatKey);
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
    return true;
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 增量记忆写入（与聊天上下文/已读状态独立）──
  /** Process the next unread-by-memory batch; chat read state is independent. */
  async consolidateMemoryForChat(chatKey) {
    return this.memoryPipeline.run(chatKey);
  }

  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2 });
    }    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    if (!p?.baseURL || !p?.apiKey || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    this.memoryPipeline.stop();
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      consolidating: [...this.consolidating],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}
