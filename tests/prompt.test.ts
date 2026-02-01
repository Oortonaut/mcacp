import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptHandler } from '../src/sessions/prompt.js';
import type { LifecycleManager, AgentHandle } from '../src/acp/lifecycle.js';
import type { SessionManager, ActiveSession, PromptEvent } from '../src/sessions/index.js';
import type { PermissionEngine } from '../src/permissions/index.js';
import type { McacpConfig } from '../src/types/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<McacpConfig>): McacpConfig {
  return {
    registries: ['https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'],
    agent_servers: {},
    defaultAutoReapMs: 300000,
    defaultPermissionPolicy: 'elicit',
    sessionDir: './.mcacp',
    installDir: './.mcacp/agents',
    promptConsolidateMs: 0, // disable Nagle for most tests
    heartbeatTimeoutMs: 60000,
    clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    ...overrides,
  };
}

function makeSession(sessionId: string, agentId: string): ActiveSession {
  return {
    sessionId,
    agentId,
    permissionPolicy: 'allow_all',
    pendingPermission: null,
    promptState: 'idle' as const,
    eventQueue: [],
    waiters: [],
    chunkBuffer: null,
    chunkTimer: null,
  };
}

/**
 * Build a mock transport whose `request` call can be externally resolved.
 * Returns the transport mock and a control object to resolve/reject the
 * "session/prompt" call at will.
 */
function makeMockTransport() {
  let promptResolve: ((v: unknown) => void) | null = null;
  let promptReject: ((e: Error) => void) | null = null;
  const promptPromise = new Promise<unknown>((res, rej) => {
    promptResolve = res;
    promptReject = rej;
  });

  const transport = {
    request: vi.fn().mockReturnValue(promptPromise),
    notify: vi.fn(),
    setNotificationHandler: vi.fn(),
    setRequestHandler: vi.fn(),
    onNotification: null as any,
    onIncomingRequest: null as any,
  };

  return {
    transport,
    resolvePrompt: (stopReason = 'end_turn') => promptResolve!({ stopReason }),
    rejectPrompt: (msg: string) => promptReject!(new Error(msg)),
  };
}

function makeHandle(agentId: string, transport: ReturnType<typeof makeMockTransport>['transport']): AgentHandle {
  return {
    agentId,
    transport: transport as any,
    capabilities: {},
    protocolVersion: 1,
    activeSessions: new Set<string>(),
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    reapTimer: null,
    status: { text: 'initialized', updatedAt: Date.now() },
  };
}

function makeMockLifecycle(handles: Map<string, AgentHandle>): LifecycleManager {
  return {
    getAgent: vi.fn((agentId: string) => {
      const h = handles.get(agentId);
      if (!h) throw new Error(`Agent "${agentId}" is not running.`);
      return h;
    }),
    touchActivity: vi.fn(),
  } as unknown as LifecycleManager;
}

function makeMockSessionManager(sessions: Map<string, ActiveSession>): SessionManager {
  return {
    getSession: vi.fn((sessionId: string) => {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session "${sessionId}" is not active`);
      return s;
    }),
    touchSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeMockPermissions(): PermissionEngine {
  return {
    handle: vi.fn().mockResolvedValue({ selected: { optionId: 'allow-1' } }),
  } as unknown as PermissionEngine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptHandler', () => {
  let config: McacpConfig;
  let sessions: Map<string, ActiveSession>;
  let handles: Map<string, AgentHandle>;
  let transport: ReturnType<typeof makeMockTransport>;
  let handler: PromptHandler;

  beforeEach(() => {
    config = makeConfig();
    sessions = new Map();
    handles = new Map();
    transport = makeMockTransport();

    const session = makeSession('sess-1', 'agent-1');
    sessions.set('sess-1', session);

    const handle = makeHandle('agent-1', transport.transport);
    handles.set('agent-1', handle);

    const lifecycle = makeMockLifecycle(handles);
    const sessionMgr = makeMockSessionManager(sessions);
    const permissions = makeMockPermissions();

    handler = new PromptHandler(lifecycle, sessionMgr, permissions, config);
  });

  // -----------------------------------------------------------------------
  // promptPolled
  // -----------------------------------------------------------------------
  describe('promptPolled', () => {
    it('returns { status: "prompted" } immediately', () => {
      const result = handler.promptPolled('sess-1', 'Hello');

      expect(result).toEqual({ status: 'prompted' });
    });

    it('sets session promptState to prompted', () => {
      handler.promptPolled('sess-1', 'Hello');

      const session = sessions.get('sess-1')!;
      expect(session.promptState).toBe('prompted');
    });

    it('fires session/prompt on the transport', () => {
      handler.promptPolled('sess-1', 'Hello');

      expect(transport.transport.request).toHaveBeenCalledWith('session/prompt', {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'Hello' }],
      });
    });

    it('accepts ContentBlock[] as prompt content', () => {
      const blocks = [{ type: 'text' as const, text: 'Hi' }];
      handler.promptPolled('sess-1', blocks);

      expect(transport.transport.request).toHaveBeenCalledWith('session/prompt', {
        sessionId: 'sess-1',
        prompt: blocks,
      });
    });

    it('throws if session already has an active prompt', () => {
      handler.promptPolled('sess-1', 'First');

      expect(() => handler.promptPolled('sess-1', 'Second')).toThrow(
        'Session "sess-1" already has an active prompt',
      );
    });

    it('pushes a complete event when transport resolves', async () => {
      handler.promptPolled('sess-1', 'Hello');
      transport.resolvePrompt('end_turn');

      // Allow microtask to run the .then() handler
      await new Promise(r => setTimeout(r, 20));

      const session = sessions.get('sess-1')!;
      expect(session.promptState).toBe('idle');

      const events = session.eventQueue;
      const complete = events.find(e => e.type === 'complete');
      expect(complete).toBeDefined();
      expect(complete!.type === 'complete' && complete!.stopReason).toBe('end_turn');
    });

    it('pushes an error event when transport rejects', async () => {
      handler.promptPolled('sess-1', 'Hello');
      transport.rejectPrompt('Agent crashed');

      await new Promise(r => setTimeout(r, 20));

      const session = sessions.get('sess-1')!;
      expect(session.promptState).toBe('idle');

      const events = session.eventQueue;
      const errorEvt = events.find(e => e.type === 'error');
      expect(errorEvt).toBeDefined();
      expect(errorEvt!.type === 'error' && errorEvt!.message).toBe('Agent crashed');
    });
  });

  // -----------------------------------------------------------------------
  // promptEvents (non-blocking poll)
  // -----------------------------------------------------------------------
  describe('promptEvents', () => {
    it('returns empty array when nothing queued', () => {
      const result = handler.promptEvents('sess-1');
      expect(result).toEqual({ events: [] });
    });

    it('drains the event queue', () => {
      const session = sessions.get('sess-1')!;
      const fakeEvent: PromptEvent = {
        type: 'complete', stopReason: 'end_turn',
        sessionId: 'sess-1', agentId: 'agent-1',
      };
      session.eventQueue.push(fakeEvent);

      const result = handler.promptEvents('sess-1');

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toBe(fakeEvent);
      // Queue should be empty now
      expect(session.eventQueue).toHaveLength(0);
    });

    it('returns all queued events at once', () => {
      const session = sessions.get('sess-1')!;
      session.eventQueue.push(
        { type: 'error', message: 'oops', sessionId: 'sess-1', agentId: 'agent-1' },
        { type: 'complete', stopReason: 'end_turn', sessionId: 'sess-1', agentId: 'agent-1' },
      );

      const result = handler.promptEvents('sess-1');

      expect(result.events).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // promptSync
  // -----------------------------------------------------------------------
  describe('promptSync', () => {
    it('collects events until complete', async () => {
      const promise = handler.promptSync('sess-1', 'Hello');

      // The session/prompt request was fired by promptPolled inside promptSync.
      // Resolve it to trigger the 'complete' event.
      transport.resolvePrompt('end_turn');

      const result = await promise;

      // The complete event should always be included (terminal event).
      const complete = result.events.find(e => e.type === 'complete');
      expect(complete).toBeDefined();
    });

    it('collects events until error', async () => {
      const promise = handler.promptSync('sess-1', 'Hello');

      transport.rejectPrompt('Something went wrong');

      const result = await promise;

      const errorEvt = result.events.find(e => e.type === 'error');
      expect(errorEvt).toBeDefined();
      expect(errorEvt!.type === 'error' && errorEvt!.message).toBe('Something went wrong');
    });

    it('returns early on permission_request', async () => {
      // Use operator policy so permission_request flows through handleOperatorPermission
      const session = sessions.get('sess-1')!;
      session.permissionPolicy = 'operator';

      // We need a transport whose request we control granularly.
      // The prompt itself won't complete — instead, a permission_request will be pushed.
      const promise = handler.promptSync('sess-1', 'Hello');

      // Simulate the dispatcher receiving a session/request_permission incoming request.
      // This happens through the transport's request handler that ensureDispatcher installs.
      // We can push a permission_request event directly into the session event queue
      // and notify the waiter, which is what the internal pushEvent does.
      const permEvent: PromptEvent = {
        type: 'permission_request',
        toolCallId: 'tc-1',
        title: 'Read file',
        options: [{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' }],
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      // Trigger through the waiter mechanism: the session has a waiter registered by promptSync.
      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([permEvent]);
      }

      const result = await promise;

      // Should return early with the permission_request event.
      expect(result.events.some(e => e.type === 'permission_request')).toBe(true);
    });

    it('resolves with collected events on timeout', async () => {
      // Use a short timeout
      const promise = handler.promptSync('sess-1', 'Hello', 50);

      // Do NOT resolve the transport — let the timeout fire.
      const result = await promise;

      // Should resolve (not hang) with whatever was collected (may be empty).
      expect(result).toHaveProperty('events');
      expect(Array.isArray(result.events)).toBe(true);
    });

    it('timeout drains remaining queued events before resolving', async () => {
      const promise = handler.promptSync('sess-1', 'Hello', 50);

      // Push an event into the queue after the waiter has been registered
      // but that won't trigger the waiter (directly into eventQueue).
      const session = sessions.get('sess-1')!;

      // Wait a tiny bit then push an event directly into the queue
      await new Promise(r => setTimeout(r, 10));
      session.eventQueue.push({
        type: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      });

      const result = await promise;

      // The timeout handler drains session.eventQueue — it should pick up our event
      // if includeThoughts is true. Default is false, so the update won't be in collected.
      // But the drain should have happened (eventQueue should be empty).
      expect(session.eventQueue).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Event filtering (shouldIncludeEvent logic via promptSync)
  // -----------------------------------------------------------------------
  describe('event filtering', () => {
    it('always includes terminal events (complete, error, permission_request)', async () => {
      // includeThoughts=false, includeTools=false (defaults)
      const promise = handler.promptSync('sess-1', 'Hello', undefined, false, false);

      transport.resolvePrompt('end_turn');
      const result = await promise;

      // complete is terminal — always included
      expect(result.events.some(e => e.type === 'complete')).toBe(true);
    });

    it('filters out thought events when includeThoughts=false', async () => {
      const promise = handler.promptSync('sess-1', 'Hello', undefined, false, false);

      // Push a thought event through the waiter before resolving
      const session = sessions.get('sess-1')!;
      const thoughtEvent: PromptEvent = {
        type: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking...' } } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      // Feed through waiter
      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([thoughtEvent]);
      }

      // Now complete to end it
      transport.resolvePrompt('end_turn');
      const result = await promise;

      // The thought event should NOT be in collected
      const thoughtEvents = result.events.filter(
        e => e.type === 'update' && 'sessionUpdate' in e.update && e.update.sessionUpdate === 'agent_message_chunk',
      );
      expect(thoughtEvents).toHaveLength(0);
    });

    it('includes thought events when includeThoughts=true', async () => {
      const promise = handler.promptSync('sess-1', 'Hello', undefined, true, false);

      const session = sessions.get('sess-1')!;
      const thoughtEvent: PromptEvent = {
        type: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking...' } } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([thoughtEvent]);
      }

      transport.resolvePrompt('end_turn');
      const result = await promise;

      const thoughtEvents = result.events.filter(
        e => e.type === 'update' && 'sessionUpdate' in e.update && e.update.sessionUpdate === 'agent_message_chunk',
      );
      expect(thoughtEvents).toHaveLength(1);
    });

    it('filters out tool events when includeTools=false', async () => {
      const promise = handler.promptSync('sess-1', 'Hello', undefined, false, false);

      const session = sessions.get('sess-1')!;
      const toolEvent: PromptEvent = {
        type: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'ReadFile',
          status: 'completed',
        } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([toolEvent]);
      }

      transport.resolvePrompt('end_turn');
      const result = await promise;

      const toolEvents = result.events.filter(
        e => e.type === 'update' && 'sessionUpdate' in e.update && e.update.sessionUpdate === 'tool_call',
      );
      expect(toolEvents).toHaveLength(0);
    });

    it('includes tool events when includeTools=true', async () => {
      const promise = handler.promptSync('sess-1', 'Hello', undefined, false, true);

      const session = sessions.get('sess-1')!;
      const toolEvent: PromptEvent = {
        type: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'ReadFile',
          status: 'completed',
        } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([toolEvent]);
      }

      transport.resolvePrompt('end_turn');
      const result = await promise;

      const toolEvents = result.events.filter(
        e => e.type === 'update' && 'sessionUpdate' in e.update && e.update.sessionUpdate === 'tool_call',
      );
      expect(toolEvents).toHaveLength(1);
    });

    it('includes tool_call_update events when includeTools=true', async () => {
      const promise = handler.promptSync('sess-1', 'Hello', undefined, false, true);

      const session = sessions.get('sess-1')!;
      const toolUpdateEvent: PromptEvent = {
        type: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'in_progress',
        } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([toolUpdateEvent]);
      }

      transport.resolvePrompt('end_turn');
      const result = await promise;

      const toolUpdates = result.events.filter(
        e => e.type === 'update' && 'sessionUpdate' in e.update && e.update.sessionUpdate === 'tool_call_update',
      );
      expect(toolUpdates).toHaveLength(1);
    });

    it('filters non-sessionUpdate updates via includeThoughts', async () => {
      // A SessionUpdate that does NOT have a sessionUpdate property
      // (unlikely in practice but tests the shouldIncludeEvent branch)
      const promise = handler.promptSync('sess-1', 'Hello', undefined, false, false);

      const session = sessions.get('sess-1')!;
      const weirdEvent: PromptEvent = {
        type: 'update',
        update: { someOtherField: true } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([weirdEvent]);
      }

      transport.resolvePrompt('end_turn');
      const result = await promise;

      // Should be filtered out when includeThoughts=false
      const updateEvents = result.events.filter(e => e.type === 'update');
      expect(updateEvents).toHaveLength(0);
    });

    it('includes non-sessionUpdate updates when includeThoughts=true', async () => {
      const promise = handler.promptSync('sess-1', 'Hello', undefined, true, false);

      const session = sessions.get('sess-1')!;
      const weirdEvent: PromptEvent = {
        type: 'update',
        update: { someOtherField: true } as any,
        sessionId: 'sess-1',
        agentId: 'agent-1',
      };

      if (session.waiters.length > 0) {
        const waiter = session.waiters.shift()!;
        waiter([weirdEvent]);
      }

      transport.resolvePrompt('end_turn');
      const result = await promise;

      const updateEvents = result.events.filter(e => e.type === 'update');
      expect(updateEvents).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // grantPermission
  // -----------------------------------------------------------------------
  describe('grantPermission', () => {
    it('resolves the pending permission', () => {
      const session = sessions.get('sess-1')!;
      let resolved: any = null;
      session.pendingPermission = {
        toolCallId: 'tc-1',
        title: 'Read file',
        options: [{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' }],
        resolve: (v: any) => { resolved = v; },
      };

      handler.grantPermission('sess-1', 'tc-1', 'allow-1');

      expect(resolved).toEqual({ selected: { optionId: 'allow-1' } });
      expect(session.pendingPermission).toBeNull();
    });

    it('throws when no pending permission exists', () => {
      expect(() => handler.grantPermission('sess-1', 'tc-1', 'allow-1')).toThrow(
        'No pending permission for session "sess-1"',
      );
    });

    it('throws when toolCallId does not match', () => {
      const session = sessions.get('sess-1')!;
      session.pendingPermission = {
        toolCallId: 'tc-99',
        title: 'Other tool',
        options: [],
        resolve: vi.fn(),
      };

      expect(() => handler.grantPermission('sess-1', 'tc-1', 'allow-1')).toThrow(
        'Pending permission is for "tc-99", not "tc-1"',
      );
    });
  });

  // -----------------------------------------------------------------------
  // cancel
  // -----------------------------------------------------------------------
  describe('cancel', () => {
    it('sends session/cancel notification on the transport', () => {
      handler.cancel('sess-1');

      expect(transport.transport.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'sess-1' });
    });
  });

  // -----------------------------------------------------------------------
  // setMode
  // -----------------------------------------------------------------------
  describe('setMode', () => {
    it('sends session/set_mode request on the transport', async () => {
      transport.transport.request.mockResolvedValueOnce(undefined);
      await handler.setMode('sess-1', 'fast');

      expect(transport.transport.request).toHaveBeenCalledWith('session/set_mode', {
        sessionId: 'sess-1',
        modeId: 'fast',
      });
    });
  });
});
