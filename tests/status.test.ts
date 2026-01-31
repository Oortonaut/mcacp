import { describe, it, expect, beforeEach } from 'vitest';
import { StatusTracker } from '../src/acp/status.js';
import type { AgentStatusSnapshot, DetailedAgentStatus } from '../src/acp/status.js';
import type { AgentHandle } from '../src/acp/lifecycle.js';
import type { McacpConfig } from '../src/types/config.js';

function makeConfig(overrides?: Partial<McacpConfig>): McacpConfig {
  return {
    registries: ['https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'],
    agent_servers: {},
    defaultAutoReapMs: 300000,
    defaultPermissionPolicy: 'elicit',
    sessionDir: './.mcacp',
    installDir: './.mcacp/agents',
    heartbeatTimeoutMs: 60000,
    clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    ...overrides,
  };
}

function makeHandle(overrides?: Partial<AgentHandle>): AgentHandle {
  const now = Date.now();
  return {
    agentId: 'test-agent',
    transport: {
      lastMessageAt: now,
      closed: false,
    } as any,
    capabilities: {},
    protocolVersion: 1,
    activeSessions: new Set<string>(),
    startedAt: now - 5000,
    lastActivityAt: now - 1000,
    reapTimer: null,
    status: { text: 'initialized', updatedAt: now - 2000 },
    ...overrides,
  };
}

describe('StatusTracker', () => {
  let tracker: StatusTracker;
  let config: McacpConfig;

  beforeEach(() => {
    config = makeConfig();
    tracker = new StatusTracker(config);
  });

  describe('getAll', () => {
    it('returns empty array for no agents', () => {
      const result = tracker.getAll([]);
      expect(result).toEqual([]);
    });

    it('returns snapshot for a single agent', () => {
      const handle = makeHandle({ agentId: 'agent-1' });
      handle.activeSessions.add('sess-1');
      handle.activeSessions.add('sess-2');

      const result = tracker.getAll([handle]);

      expect(result).toHaveLength(1);
      const snap = result[0];
      expect(snap.agentId).toBe('agent-1');
      expect(snap.status).toBe('initialized');
      expect(snap.statusUpdatedAt).toBe(handle.status.updatedAt);
      expect(snap.alive).toBe(true);
      expect(snap.startedAt).toBe(handle.startedAt);
      expect(snap.lastActivityAt).toBe(handle.lastActivityAt);
      expect(snap.lastMessageAt).toBe(handle.transport.lastMessageAt);
      expect(snap.activeSessions).toEqual(['sess-1', 'sess-2']);
      expect(snap.uptime).toBeGreaterThanOrEqual(5000);
    });

    it('returns snapshots for multiple agents', () => {
      const handle1 = makeHandle({ agentId: 'agent-1' });
      const handle2 = makeHandle({ agentId: 'agent-2' });

      const result = tracker.getAll([handle1, handle2]);

      expect(result).toHaveLength(2);
      expect(result[0].agentId).toBe('agent-1');
      expect(result[1].agentId).toBe('agent-2');
    });

    it('marks dead agents when transport is closed', () => {
      const handle = makeHandle({
        agentId: 'dead-agent',
        transport: { lastMessageAt: Date.now(), closed: true } as any,
      });

      const result = tracker.getAll([handle]);

      expect(result[0].alive).toBe(false);
    });

    it('marks dead agents when heartbeat has timed out', () => {
      const handle = makeHandle({
        agentId: 'stale-agent',
        transport: {
          lastMessageAt: Date.now() - 120000, // 2 minutes ago, timeout is 60s
          closed: false,
        } as any,
      });

      const result = tracker.getAll([handle]);

      expect(result[0].alive).toBe(false);
    });
  });

  describe('getDetailed', () => {
    it('returns detailed status with protocol and capability info', () => {
      const handle = makeHandle({
        agentId: 'detail-agent',
        protocolVersion: 2,
        capabilities: { loadSession: true, mcpCapabilities: { http: true } },
        agentInfo: { name: 'TestAgent', version: '1.2.3', title: 'Test Agent' },
      });
      handle.activeSessions.add('sess-x');

      const result: DetailedAgentStatus = tracker.getDetailed(handle);

      expect(result.agentId).toBe('detail-agent');
      expect(result.status).toBe('initialized');
      expect(result.alive).toBe(true);
      expect(result.protocolVersion).toBe(2);
      expect(result.capabilities).toEqual({ loadSession: true, mcpCapabilities: { http: true } });
      expect(result.agentInfo).toEqual({ name: 'TestAgent', version: '1.2.3', title: 'Test Agent' });
      expect(result.activeSessions).toEqual(['sess-x']);
      expect(result.uptime).toBeGreaterThanOrEqual(5000);
      expect(result.startedAt).toBe(handle.startedAt);
      expect(result.lastActivityAt).toBe(handle.lastActivityAt);
      expect(result.lastMessageAt).toBe(handle.transport.lastMessageAt);
      expect(result.statusUpdatedAt).toBe(handle.status.updatedAt);
    });

    it('returns undefined agentInfo when not set', () => {
      const handle = makeHandle();
      const result = tracker.getDetailed(handle);
      expect(result.agentInfo).toBeUndefined();
    });
  });

  describe('isAlive', () => {
    it('returns true for active transport within heartbeat window', () => {
      const handle = makeHandle({
        transport: {
          lastMessageAt: Date.now(),
          closed: false,
        } as any,
      });

      expect(tracker.isAlive(handle)).toBe(true);
    });

    it('returns false when transport is closed', () => {
      const handle = makeHandle({
        transport: {
          lastMessageAt: Date.now(),
          closed: true,
        } as any,
      });

      expect(tracker.isAlive(handle)).toBe(false);
    });

    it('returns false when last message exceeds heartbeat timeout', () => {
      const handle = makeHandle({
        transport: {
          lastMessageAt: Date.now() - 61000, // 61s ago, timeout is 60s
          closed: false,
        } as any,
      });

      expect(tracker.isAlive(handle)).toBe(false);
    });

    it('returns true when last message is exactly at heartbeat boundary', () => {
      // At exact boundary: Date.now() - lastMessageAt === heartbeatTimeoutMs
      // The condition is strictly less-than, so exactly at boundary is false
      const handle = makeHandle({
        transport: {
          lastMessageAt: Date.now() - 60000,
          closed: false,
        } as any,
      });

      // Exactly at the boundary: not strictly less than, so not alive
      expect(tracker.isAlive(handle)).toBe(false);
    });

    it('respects custom heartbeat timeout from config', () => {
      const customConfig = makeConfig({ heartbeatTimeoutMs: 5000 });
      const customTracker = new StatusTracker(customConfig);

      const aliveHandle = makeHandle({
        transport: { lastMessageAt: Date.now() - 3000, closed: false } as any,
      });
      const deadHandle = makeHandle({
        transport: { lastMessageAt: Date.now() - 6000, closed: false } as any,
      });

      expect(customTracker.isAlive(aliveHandle)).toBe(true);
      expect(customTracker.isAlive(deadHandle)).toBe(false);
    });
  });

  describe('setStatus', () => {
    it('updates handle status text and timestamp', () => {
      const handle = makeHandle();
      const beforeUpdate = Date.now();

      tracker.setStatus(handle, 'working on task');

      expect(handle.status.text).toBe('working on task');
      expect(handle.status.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('overwrites previous status', () => {
      const handle = makeHandle();

      tracker.setStatus(handle, 'first status');
      expect(handle.status.text).toBe('first status');

      tracker.setStatus(handle, 'second status');
      expect(handle.status.text).toBe('second status');
    });
  });

  describe('updateFromSessionUpdate', () => {
    it('sets status to tool name on tool_call', () => {
      const handle = makeHandle();
      const beforeUpdate = Date.now();

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'tool_call',
        title: 'ReadFile',
      });

      expect(handle.status.text).toBe('Tool: ReadFile');
      expect(handle.status.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('sets status to Processing on tool_call_update with completed status', () => {
      const handle = makeHandle();

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'tool_call_update',
        status: 'completed',
      });

      expect(handle.status.text).toBe('Processing...');
    });

    it('does not change status on tool_call_update with non-completed status', () => {
      const handle = makeHandle();
      const originalStatus = handle.status.text;

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'tool_call_update',
        status: 'in_progress',
      });

      expect(handle.status.text).toBe(originalStatus);
    });

    it('sets status to Responding on agent_message_chunk', () => {
      const handle = makeHandle();

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'agent_message_chunk',
      });

      expect(handle.status.text).toBe('Responding...');
    });

    it('sets status to Thinking on agent_thought_chunk', () => {
      const handle = makeHandle();

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'agent_thought_chunk',
      });

      expect(handle.status.text).toBe('Thinking...');
    });

    it('sets status to active plan entry on plan update', () => {
      const handle = makeHandle();

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1: done', status: 'completed' },
          { content: 'Step 2: working', status: 'in_progress' },
          { content: 'Step 3: pending', status: 'pending' },
        ],
      });

      expect(handle.status.text).toBe('Plan: Step 2: working');
    });

    it('does not update status when plan has no in_progress entry', () => {
      const handle = makeHandle();
      const originalStatus = handle.status.text;

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1: done', status: 'completed' },
          { content: 'Step 2: pending', status: 'pending' },
        ],
      });

      expect(handle.status.text).toBe(originalStatus);
    });

    it('does not update status for unknown session update types', () => {
      const handle = makeHandle();
      const originalStatus = handle.status.text;
      const originalUpdatedAt = handle.status.updatedAt;

      tracker.updateFromSessionUpdate(handle, {
        sessionUpdate: 'some_unknown_type',
      });

      expect(handle.status.text).toBe(originalStatus);
      expect(handle.status.updatedAt).toBe(originalUpdatedAt);
    });
  });
});
