import type {
  SessionId, SessionUpdate, SessionPromptResult, ContentBlock,
  SessionUpdateNotification, StopReason, RequestPermissionParams, RequestPermissionOutcome, RequestId,
} from '../types/acp.js';
import type { AgentHandle } from '../acp/lifecycle.js';
import type { McacpConfig } from '../types/config.js';
import type { ActiveSession, BarePromptEvent, PromptEvent } from './index.js';
import { LifecycleManager } from '../acp/lifecycle.js';
import { SessionManager } from './index.js';
import { PermissionEngine } from '../permissions/index.js';

/** Per-agent dispatch table for sessions with active prompts. */
interface AgentDispatch {
  sessions: Map<SessionId, ActiveSession>;
  /** The handler that was on the transport before we installed ours. */
  prevNotificationHandler: ((method: string, params: unknown) => void) | null;
  prevRequestHandler: ((method: string, params: unknown, id: RequestId) => Promise<unknown>) | null;
}

export class PromptHandler {
  private dispatchers = new Map<string, AgentDispatch>();
  private globalWaiter: {
    resolve: (events: PromptEvent[]) => void;
    collected: PromptEvent[];
    nagleTimer: ReturnType<typeof setTimeout> | null;
    nagleMs: number;
  } | null = null;

  constructor(
    private lifecycle: LifecycleManager,
    private sessions: SessionManager,
    private permissions: PermissionEngine,
    private config: McacpConfig,
  ) {}

  /**
   * Send a prompt to an ACP session. Returns immediately after dispatching.
   * The session enters "prompted" state; use prompt_events to poll for events.
   */
  promptPolled(sessionId: SessionId, promptContent: string | ContentBlock[]): { status: 'prompted' } {
    const session = this.sessions.getSession(sessionId);
    if (session.promptState === 'prompted') {
      throw new Error(`Session "${sessionId}" already has an active prompt`);
    }
    const handle = this.lifecycle.getAgent(session.agentId);

    const blocks: ContentBlock[] = typeof promptContent === 'string'
      ? [{ type: 'text', text: promptContent }]
      : promptContent;

    session.promptState = 'prompted';
    session.eventQueue = [];
    this.resetChunkBuffer(session);

    // Register this session in the agent's dispatch table
    this.ensureDispatcher(handle, sessionId, session);

    // Fire the prompt — don't await. Completion/error becomes an event.
    handle.transport.request('session/prompt', {
      sessionId, prompt: blocks,
    }).then((result) => {
      const r = result as SessionPromptResult;
      this.sessions.touchSession(sessionId);
      this.flushChunkBuffer(session);
      this.pushEvent(session, { type: 'complete', stopReason: r.stopReason });
      session.promptState = 'idle';
      this.unregisterSession(handle, sessionId);
    }).catch((err) => {
      this.flushChunkBuffer(session);
      this.pushEvent(session, { type: 'error', message: err?.message ?? String(err) });
      session.promptState = 'idle';
      this.unregisterSession(handle, sessionId);
    });

    return { status: 'prompted' };
  }

  /**
   * Non-blocking poll. Returns all queued events (may be empty).
   */
  promptEvents(sessionId: SessionId): { events: PromptEvent[] } {
    const session = this.sessions.getSession(sessionId);
    const events = session.eventQueue.splice(0);
    return { events };
  }

  /**
   * Combined start + blocking wait. Sends the prompt and blocks until the
   * prompt completes, errors, or a permission_request requires operator
   * attention (to avoid deadlocking the caller).
   *
   * Event filtering:
   * - includeThoughts: include all non-tool, non-terminal updates — message
   *   chunks, thought chunks, plan entries, mode changes, etc. (default: false)
   * - includeTools: include tool_call / tool_call_update updates (default: false)
   *
   * Returns early (without a 'complete' event) if:
   * - A permission_request event arrives (operator policy) — the caller must
   *   handle it via grant_permission and call promptSync again.
   * - The timeout fires — the caller receives whatever events have been
   *   collected so far (may be empty).
   */
  promptSync(
    sessionId: SessionId,
    promptContent: string | ContentBlock[],
    timeoutMs?: number,
    includeThoughts = false,
    includeTools = false,
  ): Promise<{ events: PromptEvent[] }> {
    this.promptPolled(sessionId, promptContent);

    const session = this.sessions.getSession(sessionId);
    const collected: PromptEvent[] = [];

    return new Promise((resolve) => {
      let done = false;

      const finish = () => {
        done = true;
        if (timer) clearTimeout(timer);
        resolve({ events: collected });
      };

      const timer = timeoutMs != null
        ? setTimeout(() => {
            if (done) return;
            // Drain any remaining queued events before resolving
            for (const e of session.eventQueue.splice(0)) {
              if (shouldIncludeEvent(e, includeThoughts, includeTools)) collected.push(e);
            }
            finish();
          }, timeoutMs)
        : null;

      const consume = (events: PromptEvent[]) => {
        if (done) return;

        let terminal = false;
        for (const e of events) {
          if (shouldIncludeEvent(e, includeThoughts, includeTools)) collected.push(e);
          if (e.type === 'complete' || e.type === 'error' || e.type === 'permission_request') {
            terminal = true;
          }
        }

        if (terminal) { finish(); return; }

        // Re-register for more events
        session.waiters.push(consume);
      };

      // Drain any already-queued events (race with promptPolled)
      if (session.eventQueue.length > 0) {
        consume(session.eventQueue.splice(0));
      } else {
        session.waiters.push(consume);
      }
    });
  }

  /**
   * Grant a pending operator permission. The agent resumes and new events
   * continue flowing into the queue.
   */
  grantPermission(sessionId: SessionId, toolCallId: string, optionId: string): void {
    const session = this.sessions.getSession(sessionId);
    if (!session.pendingPermission) throw new Error(`No pending permission for session "${sessionId}"`);
    if (session.pendingPermission.toolCallId !== toolCallId) {
      throw new Error(`Pending permission is for "${session.pendingPermission.toolCallId}", not "${toolCallId}"`);
    }
    session.pendingPermission.resolve({ outcome: 'selected', optionId });
    session.pendingPermission = null;
  }

  cancel(sessionId: SessionId): void {
    const session = this.sessions.getSession(sessionId);
    const handle = this.lifecycle.getAgent(session.agentId);
    handle.transport.notify('session/cancel', { sessionId });
  }

  async setMode(sessionId: SessionId, modeId: string): Promise<void> {
    const session = this.sessions.getSession(sessionId);
    const handle = this.lifecycle.getAgent(session.agentId);
    await handle.transport.request('session/set_mode', { sessionId, modeId });
  }

  // ---- Global event stream ----

  /**
   * Block until any prompted session produces events. Returns events stamped
   * with sessionId and agentId. Supports optional Nagle-style coalescing.
   */
  events(timeoutMs?: number, nagleMs = 0): Promise<{ events: PromptEvent[] }> {
    // Drain all prompted sessions
    const allEvents: PromptEvent[] = [];
    for (const dispatch of this.dispatchers.values()) {
      for (const session of dispatch.sessions.values()) {
        allEvents.push(...session.eventQueue.splice(0));
      }
    }
    if (allEvents.length > 0) return Promise.resolve({ events: allEvents });

    // No prompted sessions? Return empty immediately.
    let any = false;
    for (const d of this.dispatchers.values()) { if (d.sessions.size > 0) { any = true; break; } }
    if (!any) return Promise.resolve({ events: [] });

    // Evict previous global waiter
    if (this.globalWaiter) this.flushGlobalWaiter();

    return new Promise((resolve) => {
      const wrappedResolve = (events: PromptEvent[]) => {
        if (timer) clearTimeout(timer);
        resolve({ events });
      };

      const timer = timeoutMs != null
        ? setTimeout(() => {
            if (this.globalWaiter?.resolve === wrappedResolve) this.flushGlobalWaiter();
          }, timeoutMs)
        : null;

      this.globalWaiter = { resolve: wrappedResolve, collected: [], nagleTimer: null, nagleMs };
    });
  }

  /**
   * Cleanup hook: if no prompted sessions remain, resolve the global waiter
   * with whatever events have been collected.
   */
  onSessionRemoved(): void {
    if (!this.globalWaiter) return;
    for (const d of this.dispatchers.values()) { if (d.sessions.size > 0) return; }
    this.flushGlobalWaiter();
  }

  private notifyGlobalWaiter(event: PromptEvent): void {
    if (!this.globalWaiter) return;
    this.globalWaiter.collected.push(event);

    if (this.globalWaiter.nagleMs <= 0) {
      this.flushGlobalWaiter();
      return;
    }
    // Nagle: reset timer on each event, flush after nagleMs of quiet
    if (this.globalWaiter.nagleTimer) clearTimeout(this.globalWaiter.nagleTimer);
    this.globalWaiter.nagleTimer = setTimeout(() => this.flushGlobalWaiter(), this.globalWaiter.nagleMs);
  }

  private flushGlobalWaiter(): void {
    if (!this.globalWaiter) return;
    const { resolve, collected, nagleTimer } = this.globalWaiter;
    this.globalWaiter = null;
    if (nagleTimer) clearTimeout(nagleTimer);
    resolve(collected);
  }

  // ---- Dispatcher management ----

  /**
   * Ensure the agent has a central dispatch handler installed, and register
   * the session in its dispatch table.
   */
  private ensureDispatcher(handle: AgentHandle, sessionId: SessionId, session: ActiveSession): void {
    let dispatch = this.dispatchers.get(handle.agentId);
    if (!dispatch) {
      // First prompted session on this agent — install central handlers
      const prevNotificationHandler = handle.transport['onNotification'] ?? null;
      const prevRequestHandler = handle.transport['onIncomingRequest'] ?? null;
      dispatch = { sessions: new Map(), prevNotificationHandler, prevRequestHandler };
      this.dispatchers.set(handle.agentId, dispatch);

      const d = dispatch; // stable reference for closures

      handle.transport.setNotificationHandler((method, params) => {
        if (method === 'session/update') {
          const notif = params as SessionUpdateNotification;
          const target = d.sessions.get(notif.sessionId);
          if (target) {
            this.pushEventConsolidated(target, { type: 'update', update: notif.update });
            this.updateAgentStatus(handle, notif.update);
            return;
          }
        }
        if (d.prevNotificationHandler) d.prevNotificationHandler(method, params);
      });

      handle.transport.setRequestHandler(async (method, params, id) => {
        if (method === 'session/request_permission') {
          const permParams = params as RequestPermissionParams;
          const target = d.sessions.get(permParams.sessionId);
          if (target) {
            const outcome = target.permissionPolicy === 'operator'
              ? await this.handleOperatorPermission(target, permParams)
              : await this.permissions.handle(target, handle, permParams, []);
            return { outcome };
          }
        }
        if (d.prevRequestHandler) {
          return d.prevRequestHandler(method, params, id);
        }
        throw new Error(`Unhandled agent request during prompt: ${method}`);
      });
    }

    dispatch.sessions.set(sessionId, session);
  }

  /**
   * Remove a session from the dispatch table. If no sessions remain,
   * restore the original handlers and tear down the dispatcher.
   */
  private unregisterSession(handle: AgentHandle, sessionId: SessionId): void {
    const dispatch = this.dispatchers.get(handle.agentId);
    if (!dispatch) return;

    dispatch.sessions.delete(sessionId);
    if (dispatch.sessions.size === 0) {
      if (dispatch.prevNotificationHandler) {
        handle.transport.setNotificationHandler(dispatch.prevNotificationHandler);
      }
      if (dispatch.prevRequestHandler) {
        handle.transport.setRequestHandler(dispatch.prevRequestHandler);
      }
      this.dispatchers.delete(handle.agentId);
    }
  }

  // ---- Internal helpers ----

  /**
   * Nagle-style consolidation: buffer text chunk events and flush as batches.
   * Non-chunk events flush any pending buffer first, then push immediately.
   */
  private pushEventConsolidated(session: ActiveSession, event: BarePromptEvent): void {
    if (event.type !== 'update') {
      // Non-update events (permission_request, complete, error) — flush and push
      this.flushChunkBuffer(session);
      this.pushEvent(session, event);
      return;
    }

    const update = event.update;
    if (!('sessionUpdate' in update)) {
      this.flushChunkBuffer(session);
      this.pushEvent(session, event);
      return;
    }

    const updateType = update.sessionUpdate;
    const isChunk = updateType === 'agent_message_chunk' || updateType === 'agent_thought_chunk';

    if (!isChunk || this.config.promptConsolidateMs === 0) {
      // Non-chunk update or consolidation disabled — flush and push
      this.flushChunkBuffer(session);
      this.pushEvent(session, event);
      return;
    }

    // Extract text from the content block
    const text = update.content.type === 'text' ? update.content.text : '';
    if (!text) {
      // Non-text content block (image, etc.) — can't consolidate, flush and push
      this.flushChunkBuffer(session);
      this.pushEvent(session, event);
      return;
    }

    // If buffer has a different update type, flush first
    if (session.chunkBuffer && session.chunkBuffer.updateType !== updateType) {
      this.flushChunkBuffer(session);
    }

    // Append to buffer
    if (!session.chunkBuffer) {
      session.chunkBuffer = { text: '', updateType };
    }
    session.chunkBuffer.text += text;

    // Flush if text contains a newline
    if (session.chunkBuffer.text.includes('\n')) {
      this.flushChunkBuffer(session);
      return;
    }

    // Set/reset the Nagle timer
    if (session.chunkTimer) clearTimeout(session.chunkTimer);
    session.chunkTimer = setTimeout(() => {
      this.flushChunkBuffer(session);
    }, this.config.promptConsolidateMs);
  }

  /** Flush the accumulated chunk buffer as a single consolidated update event. */
  private flushChunkBuffer(session: ActiveSession): void {
    if (session.chunkTimer) {
      clearTimeout(session.chunkTimer);
      session.chunkTimer = null;
    }
    if (!session.chunkBuffer) return;

    const { text, updateType } = session.chunkBuffer;
    session.chunkBuffer = null;

    this.pushEvent(session, {
      type: 'update',
      update: {
        sessionUpdate: updateType as 'agent_message_chunk' | 'agent_thought_chunk',
        content: { type: 'text', text },
      },
    });
  }

  /** Reset chunk buffer state (called at prompt start). */
  private resetChunkBuffer(session: ActiveSession): void {
    if (session.chunkTimer) clearTimeout(session.chunkTimer);
    session.chunkTimer = null;
    session.chunkBuffer = null;
  }

  private pushEvent(session: ActiveSession, bare: BarePromptEvent): void {
    const event: PromptEvent = { ...bare, sessionId: session.sessionId, agentId: session.agentId };
    session.eventQueue.push(event);

    // Per-session waiter
    if (session.waiters.length > 0) {
      const waiter = session.waiters.shift()!;
      waiter(session.eventQueue.splice(0));
    }

    // Global waiter
    this.notifyGlobalWaiter(event);
  }

  private handleOperatorPermission(
    session: ActiveSession,
    params: RequestPermissionParams,
  ): Promise<RequestPermissionOutcome> {
    this.pushEvent(session, {
      type: 'permission_request',
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
      options: params.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    });

    return new Promise((resolve) => {
      session.pendingPermission = {
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title,
        options: params.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        resolve,
      };
    });
  }

  private updateAgentStatus(handle: AgentHandle, update: SessionUpdate): void {
    if (!('sessionUpdate' in update)) return;
    if (update.sessionUpdate === 'tool_call') {
      handle.status = { text: `Tool: ${update.title}`, updatedAt: Date.now() };
    } else if (update.sessionUpdate === 'agent_message_chunk') {
      handle.status = { text: 'Responding...', updatedAt: Date.now() };
    } else if (update.sessionUpdate === 'plan') {
      const active = update.entries.find(e => e.status === 'in_progress');
      if (active) handle.status = { text: `Plan: ${active.content}`, updatedAt: Date.now() };
    }
  }
}

/**
 * Filter helper for promptSync.
 * - Terminal events (complete, error, permission_request) always pass.
 * - Tool events (tool_call, tool_call_update) require includeTools.
 * - Everything else is a "thought" and requires includeThoughts.
 */
function shouldIncludeEvent(event: PromptEvent, includeThoughts: boolean, includeTools: boolean): boolean {
  if (event.type !== 'update') return true;
  const u = event.update;
  if (!('sessionUpdate' in u)) return includeThoughts;
  if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') return includeTools;
  return includeThoughts;
}
