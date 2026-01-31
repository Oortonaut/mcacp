import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionEngine } from '../src/permissions/index.js';
import type { ElicitationSender } from '../src/permissions/index.js';
import type { RequestPermissionParams } from '../src/types/acp.js';
import type { ActiveSession } from '../src/sessions/index.js';
import type { AgentHandle } from '../src/acp/lifecycle.js';

function makeSession(policy: 'allow_all' | 'deny_all' | 'elicit' | 'operator'): ActiveSession {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    permissionPolicy: policy,
    pendingPermission: null,
    promptState: 'idle',
    eventQueue: [],
    waiters: [],
  };
}

function makeParams(options: RequestPermissionParams['options']): RequestPermissionParams {
  return {
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'tc-1', title: 'Read file' },
    options,
  };
}

const mockHandle = {} as AgentHandle;
const emptyUpdates: never[] = [];

describe('PermissionEngine', () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine();
  });

  describe('allow_all policy', () => {
    it('picks first allow_once/allow_always option', async () => {
      const session = makeSession('allow_all');
      const params = makeParams([
        { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'allow-2', name: 'Allow Always', kind: 'allow_always' },
      ]);

      const result = await engine.handle(session, mockHandle, params, emptyUpdates);

      expect(result).toEqual({ selected: { optionId: 'allow-1' } });
    });

    it('picks first option if no allow/deny kinds present', async () => {
      const session = makeSession('allow_all');
      const params = makeParams([
        { optionId: 'reject-1', name: 'Reject Once', kind: 'reject_once' },
        { optionId: 'reject-2', name: 'Reject Always', kind: 'reject_always' },
      ]);

      const result = await engine.handle(session, mockHandle, params, emptyUpdates);

      expect(result).toEqual({ selected: { optionId: 'reject-1' } });
    });
  });

  describe('deny_all policy', () => {
    it('picks first reject_once/reject_always option', async () => {
      const session = makeSession('deny_all');
      const params = makeParams([
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'reject-1', name: 'Reject Once', kind: 'reject_once' },
        { optionId: 'reject-2', name: 'Reject Always', kind: 'reject_always' },
      ]);

      const result = await engine.handle(session, mockHandle, params, emptyUpdates);

      expect(result).toEqual({ selected: { optionId: 'reject-1' } });
    });

    it('returns cancelled if no reject options exist', async () => {
      const session = makeSession('deny_all');
      const params = makeParams([
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'allow-2', name: 'Allow Always', kind: 'allow_always' },
      ]);

      const result = await engine.handle(session, mockHandle, params, emptyUpdates);

      expect(result).toEqual({ cancelled: {} });
    });
  });

  describe('elicit policy', () => {
    it('falls back to allow_all when no elicitation sender is set', async () => {
      const session = makeSession('elicit');
      const params = makeParams([
        { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
      ]);

      const result = await engine.handle(session, mockHandle, params, emptyUpdates);

      expect(result).toEqual({ selected: { optionId: 'allow-1' } });
    });

    it('sends elicitation and returns selected option', async () => {
      const session = makeSession('elicit');
      const sender: ElicitationSender = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { decision: 'allow-1' },
      });
      engine.setElicitationSender(sender);

      const params = makeParams([
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'reject-1', name: 'Reject Once', kind: 'reject_once' },
      ]);

      const result = await engine.handle(session, mockHandle, params, emptyUpdates);

      expect(sender).toHaveBeenCalledOnce();
      expect(sender).toHaveBeenCalledWith(
        'Agent requests permission: Read file',
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            decision: expect.objectContaining({
              enum: ['allow-1', 'reject-1'],
            }),
          }),
        }),
      );
      expect(result).toEqual({ selected: { optionId: 'allow-1' } });
    });

    it('returns cancelled on decline', async () => {
      const session = makeSession('elicit');
      const sender: ElicitationSender = vi.fn().mockResolvedValue({
        action: 'decline',
      });
      engine.setElicitationSender(sender);

      const params = makeParams([
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
      ]);

      const result = await engine.handle(session, mockHandle, params, emptyUpdates);

      expect(result).toEqual({ cancelled: {} });
    });
  });

  describe('operator policy', () => {
    it('stores pending permission and resolves when granted', async () => {
      const session = makeSession('operator');
      const params = makeParams([
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'reject-1', name: 'Reject Once', kind: 'reject_once' },
      ]);

      const promise = engine.handle(session, mockHandle, params, emptyUpdates);

      // Verify the pending permission was stored on the session
      expect(session.pendingPermission).not.toBeNull();
      expect(session.pendingPermission!.toolCallId).toBe('tc-1');
      expect(session.pendingPermission!.title).toBe('Read file');
      expect(session.pendingPermission!.options).toEqual([
        { optionId: 'allow-1', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'reject-1', name: 'Reject Once', kind: 'reject_once' },
      ]);

      // Simulate operator granting permission
      session.pendingPermission!.resolve({ selected: { optionId: 'allow-1' } });

      const result = await promise;
      expect(result).toEqual({ selected: { optionId: 'allow-1' } });
    });
  });
});
