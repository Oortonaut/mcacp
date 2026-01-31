import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/sessions/index.js';
import type { SessionFile } from '../src/sessions/index.js';
import type { McacpConfig } from '../src/types/config.js';
import type { LifecycleManager, AgentHandle } from '../src/acp/lifecycle.js';

function makeConfig(sessionDir: string): McacpConfig {
  return {
    registries: ['https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'],
    agent_servers: {},
    defaultAutoReapMs: 300000,
    defaultPermissionPolicy: 'elicit',
    sessionDir,
    installDir: './agents',
    heartbeatTimeoutMs: 60000,
    clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
  };
}

function makeMockHandle(agentId: string): AgentHandle {
  return {
    agentId,
    transport: {
      request: vi.fn().mockResolvedValue({ sessionId: `session-${Date.now()}` }),
    } as any,
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
      const handle = handles.get(agentId);
      if (!handle) throw new Error(`Agent "${agentId}" is not running.`);
      return handle;
    }),
    touchActivity: vi.fn(),
  } as unknown as LifecycleManager;
}

describe('SessionManager', () => {
  let tempDir: string;
  let config: McacpConfig;
  let handles: Map<string, AgentHandle>;
  let lifecycle: LifecycleManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcacp-test-'));
    config = makeConfig(tempDir);
    handles = new Map();
    const handle = makeMockHandle('agent-1');
    handles.set('agent-1', handle);
    lifecycle = makeMockLifecycle(handles);
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('newSession creates an active session and saves a file', async () => {
    const mgr = new SessionManager(config, lifecycle);
    const handle = handles.get('agent-1')!;
    const sessionId = 'test-session-1';
    (handle.transport.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId });

    const result = await mgr.newSession('agent-1', '/tmp/work');

    expect(result.sessionId).toBe(sessionId);

    // Session should be retrievable
    const session = mgr.getSession(sessionId);
    expect(session.agentId).toBe('agent-1');
    expect(session.permissionPolicy).toBe('elicit'); // default
    expect(session.pendingPermission).toBeNull();

    // Session file should exist on disk
    const filePath = join(tempDir, 'agent-1', `${sessionId}.json`);
    expect(existsSync(filePath)).toBe(true);

    const saved: SessionFile = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved.sessionId).toBe(sessionId);
    expect(saved.agentId).toBe('agent-1');
    expect(saved.cwd).toBe('/tmp/work');
    expect(saved.permissionPolicy).toBe('elicit');
    expect(saved.createdAt).toBeDefined();
    expect(saved.lastActiveAt).toBeDefined();
    expect(saved.closedAt).toBeUndefined();

    // Lifecycle touch should have been called
    expect(lifecycle.touchActivity).toHaveBeenCalledWith('agent-1');

    // Agent handle should track the session
    expect(handle.activeSessions.has(sessionId)).toBe(true);
  });

  it('getSession throws for unknown session', () => {
    const mgr = new SessionManager(config, lifecycle);

    expect(() => mgr.getSession('nonexistent')).toThrow(
      'Session "nonexistent" is not active',
    );
  });

  it('closeSession removes from active and saves closedAt', async () => {
    const mgr = new SessionManager(config, lifecycle);
    const handle = handles.get('agent-1')!;
    const sessionId = 'close-test-session';
    (handle.transport.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId });

    await mgr.newSession('agent-1', '/tmp/work');

    // Close the session
    mgr.closeSession(sessionId);

    // Should no longer be active
    expect(() => mgr.getSession(sessionId)).toThrow(
      `Session "${sessionId}" is not active`,
    );

    // File should have closedAt set
    const filePath = join(tempDir, 'agent-1', `${sessionId}.json`);
    const saved: SessionFile = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved.closedAt).toBeDefined();
    expect(saved.lastActiveAt).toBeDefined();

    // Agent handle should no longer track the session
    expect(handle.activeSessions.has(sessionId)).toBe(false);
  });

  it('closeAllForAgent removes all sessions for that agent', async () => {
    const mgr = new SessionManager(config, lifecycle);
    const handle = handles.get('agent-1')!;

    // Create two sessions
    (handle.transport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-a' });
    await mgr.newSession('agent-1', '/tmp/a');

    (handle.transport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-b' });
    await mgr.newSession('agent-1', '/tmp/b');

    // Both should be active
    expect(mgr.getSession('sess-a').agentId).toBe('agent-1');
    expect(mgr.getSession('sess-b').agentId).toBe('agent-1');

    // Close all for agent-1
    mgr.closeAllForAgent('agent-1');

    // Both should be gone
    expect(() => mgr.getSession('sess-a')).toThrow();
    expect(() => mgr.getSession('sess-b')).toThrow();
  });

  it('listSessions reads from disk', async () => {
    const mgr = new SessionManager(config, lifecycle);
    const handle = handles.get('agent-1')!;

    (handle.transport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'list-sess-1' });
    await mgr.newSession('agent-1', '/tmp/work1');

    (handle.transport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'list-sess-2' });
    await mgr.newSession('agent-1', '/tmp/work2');

    // A new SessionManager reading the same disk directory should see saved sessions
    const mgr2 = new SessionManager(config, lifecycle);
    const sessions = mgr2.listSessions('agent-1');

    expect(sessions.length).toBe(2);
    const ids = sessions.map(s => s.sessionId).sort();
    expect(ids).toEqual(['list-sess-1', 'list-sess-2']);
  });

  it('listSessions returns empty array when session dir does not exist', () => {
    const missingConfig = makeConfig(join(tempDir, 'nonexistent-dir'));
    const mgr = new SessionManager(missingConfig, lifecycle);

    const sessions = mgr.listSessions();
    expect(sessions).toEqual([]);
  });

  it('listSessions without agentId returns all agents sessions', async () => {
    // Add a second agent
    const handle2 = makeMockHandle('agent-2');
    handles.set('agent-2', handle2);

    const mgr = new SessionManager(config, lifecycle);
    const handle1 = handles.get('agent-1')!;

    (handle1.transport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'a1-sess' });
    await mgr.newSession('agent-1', '/tmp/work');

    (handle2.transport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'a2-sess' });
    await mgr.newSession('agent-2', '/tmp/work');

    const mgr2 = new SessionManager(config, lifecycle);
    const sessions = mgr2.listSessions();

    expect(sessions.length).toBe(2);
    const agentIds = sessions.map(s => s.agentId).sort();
    expect(agentIds).toEqual(['agent-1', 'agent-2']);
  });
});
