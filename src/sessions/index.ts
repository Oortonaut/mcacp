import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, sep, dirname } from 'node:path';
import type { McacpConfig, PermissionPolicy } from '../types/config.js';
import type { SessionId, SessionNewResult, SessionLoadResult, McpServer, SessionUpdate, StopReason } from '../types/acp.js';
import type { AgentHandle } from '../acp/lifecycle.js';
import { LifecycleManager } from '../acp/lifecycle.js';

export interface SessionFile {
  sessionId: SessionId;
  agentId: string;
  cwd: string;
  permissionPolicy: PermissionPolicy;
  createdAt: string;
  lastActiveAt: string;
  closedAt?: string;
  metadata?: Record<string, unknown>;
}

export type PromptState = 'idle' | 'prompted';

export type BarePromptEvent =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'permission_request'; toolCallId: string; title: string; options: Array<{ optionId: string; name: string; kind: string }> }
  | { type: 'complete'; stopReason: StopReason }
  | { type: 'error'; message: string };

export type PromptEvent = BarePromptEvent & {
  sessionId: SessionId;
  agentId: string;
};

export interface ActiveSession {
  sessionId: SessionId;
  agentId: string;
  permissionPolicy: PermissionPolicy;
  pendingPermission: PendingPermission | null;
  promptState: PromptState;
  eventQueue: PromptEvent[];
  waiters: Array<(events: PromptEvent[]) => void>;
  /** Accumulated text for Nagle-style chunk consolidation */
  chunkBuffer: { text: string; updateType: string } | null;
  /** Pending flush timer for chunk consolidation */
  chunkTimer: ReturnType<typeof setTimeout> | null;
}

export interface PendingPermission {
  toolCallId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  resolve: (outcome: { selected: { optionId: string } } | { cancelled: Record<string, never> }) => void;
}

export class SessionManager {
  private activeSessions = new Map<SessionId, ActiveSession>();

  constructor(
    private config: McacpConfig,
    private lifecycle: LifecycleManager,
  ) {}

  async newSession(
    agentId: string, cwd: string, mcpServers?: McpServer[], permissionPolicy?: PermissionPolicy,
  ): Promise<{ sessionId: SessionId; modes?: SessionNewResult['modes'] }> {
    const handle = this.lifecycle.getAgent(agentId);
    const policy = permissionPolicy ?? this.config.defaultPermissionPolicy;
    const result = await handle.transport.request('session/new', {
      cwd, mcpServers: mcpServers ?? [],
    }) as SessionNewResult;

    this.activeSessions.set(result.sessionId, {
      sessionId: result.sessionId, agentId, permissionPolicy: policy, pendingPermission: null,
      promptState: 'idle', eventQueue: [], waiters: [],
      chunkBuffer: null, chunkTimer: null,
    });
    handle.activeSessions.add(result.sessionId);
    this.saveSessionFile({
      sessionId: result.sessionId, agentId, cwd, permissionPolicy: policy,
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    });
    this.lifecycle.touchActivity(agentId);
    return { sessionId: result.sessionId, modes: result.modes };
  }

  async loadSession(
    agentId: string, sessionId: SessionId, cwd: string, mcpServers?: McpServer[],
  ): Promise<{ sessionId: SessionId; modes?: SessionLoadResult['modes'] }> {
    const handle = this.lifecycle.getAgent(agentId);
    if (!handle.capabilities.loadSession) {
      throw new Error(`Agent "${agentId}" does not support loading sessions`);
    }
    const result = await handle.transport.request('session/load', {
      sessionId, cwd, mcpServers: mcpServers ?? [],
    }) as SessionLoadResult;

    const file = this.readSessionFile(agentId, sessionId);
    const policy = file?.permissionPolicy ?? this.config.defaultPermissionPolicy;
    this.activeSessions.set(sessionId, {
      sessionId, agentId, permissionPolicy: policy, pendingPermission: null,
      promptState: 'idle', eventQueue: [], waiters: [],
      chunkBuffer: null, chunkTimer: null,
    });
    handle.activeSessions.add(sessionId);
    this.saveSessionFile({
      sessionId, agentId, cwd, permissionPolicy: policy,
      createdAt: file?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
    this.lifecycle.touchActivity(agentId);
    return { sessionId, modes: result.modes };
  }

  listSessions(agentId: string): SessionFile[] {
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9._@/-]/g, '_');
    const sessionsDir = resolve(this.config.sessionDir, safeAgentId, 'sessions');
    if (!existsSync(sessionsDir)) return [];
    const results: SessionFile[] = [];
    try {
      for (const f of readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
        try { results.push(JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'))); } catch {}
      }
    } catch {}
    return results;
  }

  closeSession(sessionId: SessionId): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" is not active`);
    const handle = this.lifecycle.getAgent(session.agentId);
    handle.activeSessions.delete(sessionId);
    this.activeSessions.delete(sessionId);
    const file = this.readSessionFile(session.agentId, sessionId);
    if (file) {
      file.closedAt = new Date().toISOString();
      file.lastActiveAt = new Date().toISOString();
      this.saveSessionFile(file);
    }
  }

  getSession(sessionId: SessionId): ActiveSession {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" is not active`);
    return session;
  }

  touchSession(sessionId: SessionId): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const file = this.readSessionFile(session.agentId, sessionId);
    if (file) { file.lastActiveAt = new Date().toISOString(); this.saveSessionFile(file); }
    this.lifecycle.touchActivity(session.agentId);
  }

  closeAllForAgent(agentId: string): void {
    for (const [id, session] of this.activeSessions) {
      if (session.agentId === agentId) {
        this.activeSessions.delete(id);
        // Mark session file as closed
        const file = this.readSessionFile(agentId, id);
        if (file) {
          file.closedAt = new Date().toISOString();
          file.lastActiveAt = new Date().toISOString();
          this.saveSessionFile(file);
        }
      }
    }
    // Also clean up on the agent handle
    try {
      const handle = this.lifecycle.getAgent(agentId);
      handle.activeSessions.clear();
    } catch {
      // Agent may already be shut down
    }
  }

  private sessionFilePath(agentId: string, sessionId: SessionId): string {
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9._@/-]/g, '_');
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = resolve(this.config.sessionDir, safeAgentId, 'sessions', `${safeSessionId}.json`);
    const sessionRoot = resolve(this.config.sessionDir);
    if (!filePath.startsWith(sessionRoot + sep)) {
      throw new Error('Invalid agentId or sessionId: path traversal detected');
    }
    return filePath;
  }

  private saveSessionFile(file: SessionFile): void {
    const filePath = this.sessionFilePath(file.agentId, file.sessionId);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(file, null, 2));
  }

  private readSessionFile(agentId: string, sessionId: SessionId): SessionFile | null {
    const path = this.sessionFilePath(agentId, sessionId);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
  }
}
