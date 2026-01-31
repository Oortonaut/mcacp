import type { AgentHandle } from './lifecycle.js';
import type { McacpConfig } from '../types/config.js';

export interface AgentStatusSnapshot {
  agentId: string;
  status: string;
  statusUpdatedAt: number;
  alive: boolean;
  startedAt: number;
  lastActivityAt: number;
  lastMessageAt: number;
  activeSessions: string[];
  uptime: number;
}

export interface DetailedAgentStatus extends AgentStatusSnapshot {
  protocolVersion: number;
  capabilities: Record<string, unknown>;
  agentInfo?: { name: string; version: string; title?: string };
}

export class StatusTracker {
  constructor(private config: McacpConfig) {}

  getAll(agents: AgentHandle[]): AgentStatusSnapshot[] {
    const now = Date.now();
    return agents.map(h => ({
      agentId: h.agentId,
      status: h.status.text,
      statusUpdatedAt: h.status.updatedAt,
      alive: this.isAlive(h),
      startedAt: h.startedAt,
      lastActivityAt: h.lastActivityAt,
      lastMessageAt: h.transport.lastMessageAt,
      activeSessions: Array.from(h.activeSessions),
      uptime: now - h.startedAt,
    }));
  }

  getDetailed(handle: AgentHandle): DetailedAgentStatus {
    const now = Date.now();
    return {
      agentId: handle.agentId,
      status: handle.status.text,
      statusUpdatedAt: handle.status.updatedAt,
      alive: this.isAlive(handle),
      startedAt: handle.startedAt,
      lastActivityAt: handle.lastActivityAt,
      lastMessageAt: handle.transport.lastMessageAt,
      activeSessions: Array.from(handle.activeSessions),
      uptime: now - handle.startedAt,
      protocolVersion: handle.protocolVersion,
      capabilities: handle.capabilities as unknown as Record<string, unknown>,
      agentInfo: handle.agentInfo,
    };
  }

  isAlive(handle: AgentHandle): boolean {
    if (handle.transport.closed) return false;
    return Date.now() - handle.transport.lastMessageAt < this.config.heartbeatTimeoutMs;
  }

  setStatus(handle: AgentHandle, text: string): void {
    handle.status = { text, updatedAt: Date.now() };
  }

  updateFromSessionUpdate(handle: AgentHandle, update: Record<string, unknown>): void {
    const type = update.sessionUpdate as string;
    switch (type) {
      case 'tool_call':
        handle.status = { text: `Tool: ${update.title}`, updatedAt: Date.now() };
        break;
      case 'tool_call_update':
        if (update.status === 'completed') {
          handle.status = { text: 'Processing...', updatedAt: Date.now() };
        }
        break;
      case 'agent_message_chunk':
        handle.status = { text: 'Responding...', updatedAt: Date.now() };
        break;
      case 'agent_thought_chunk':
        handle.status = { text: 'Thinking...', updatedAt: Date.now() };
        break;
      case 'plan': {
        const entries = update.entries as Array<{ content: string; status: string }>;
        const active = entries?.find(e => e.status === 'in_progress');
        if (active) handle.status = { text: `Plan: ${active.content}`, updatedAt: Date.now() };
        break;
      }
    }
  }
}
