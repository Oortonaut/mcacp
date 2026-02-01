import { AcpTransport } from './transport.js';
import type {
  InitializeParams, InitializeResult, AgentCapabilities, Implementation, SessionId,
} from '../types/acp.js';
import type { McacpConfig } from '../types/config.js';
import { getAgentConfig } from '../config/index.js';

export interface InstalledAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  distribution: 'npx' | 'binary' | 'local' | 'import';
  installedAt: string;
  registryUrl?: string;
  /** Where this agent was registered from */
  source?: string;
}

export interface AgentHandle {
  agentId: string;
  transport: AcpTransport;
  capabilities: AgentCapabilities;
  agentInfo?: Implementation;
  protocolVersion: number;
  activeSessions: Set<SessionId>;
  startedAt: number;
  lastActivityAt: number;
  reapTimer: ReturnType<typeof setTimeout> | null;
  status: { text: string; updatedAt: number };
}

export class LifecycleManager {
  private agents = new Map<string, AgentHandle>();
  private installedAgents: Map<string, InstalledAgent>;

  constructor(
    private config: McacpConfig,
    installedAgents: Map<string, InstalledAgent>,
  ) {
    this.installedAgents = installedAgents;
  }

  async initialize(
    agentId: string,
    protocolVersion?: number,
    clientInfo?: Implementation,
    clientCapabilities?: InitializeParams['clientCapabilities'],
    envOverrides?: Record<string, string>,
  ): Promise<{ protocolVersion: number; agentInfo?: Implementation; agentCapabilities: AgentCapabilities }> {
    if (this.agents.has(agentId)) {
      throw new Error(`Agent "${agentId}" is already running`);
    }

    const installed = this.installedAgents.get(agentId);
    const agentConfig = getAgentConfig(this.config, agentId);
    const command = agentConfig.command ?? installed?.command;
    const args = agentConfig.args ?? installed?.args ?? [];
    const baseEnv = agentConfig.env ?? installed?.env;
    const env = envOverrides ? { ...baseEnv, ...envOverrides } : baseEnv;

    if (!command) {
      throw new Error(`Agent "${agentId}" not installed and no command configured`);
    }

    const transport = new AcpTransport({ command, args, env, requestTimeoutMs: 60_000 });
    transport.start();

    transport.on('framingError', (line: string, err: unknown) => {
      process.stderr.write(`[mcacp:${agentId}] Framing error: ${err instanceof Error ? err.message : err}\n`);
      process.stderr.write(`[mcacp:${agentId}]   raw: ${line.slice(0, 200)}\n`);
    });
    transport.on('invalidMessage', (msg: unknown) => {
      process.stderr.write(`[mcacp:${agentId}] Invalid JSON-RPC message: ${JSON.stringify(msg).slice(0, 200)}\n`);
    });
    transport.on('stderr', (data: string) => {
      process.stderr.write(`[mcacp:${agentId}] ${data}`);
    });

    try {
      const params: InitializeParams = {
        protocolVersion: protocolVersion ?? 1,
        clientCapabilities: clientCapabilities ?? {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: clientInfo ?? {
          name: this.config.clientInfo.name,
          version: this.config.clientInfo.version,
          title: this.config.clientInfo.title,
        },
      };

      const result = await transport.request('initialize', params) as InitializeResult;

      const handle: AgentHandle = {
        agentId,
        transport,
        capabilities: result.agentCapabilities,
        agentInfo: result.agentInfo,
        protocolVersion: result.protocolVersion,
        activeSessions: new Set(),
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        reapTimer: null,
        status: { text: 'initialized', updatedAt: Date.now() },
      };

      const reapMs = agentConfig.autoReapMs;
      if (reapMs > 0) {
        this.resetReapTimer(handle, reapMs);
      }

      transport.on('exit', () => {
        this.agents.delete(agentId);
      });

      this.agents.set(agentId, handle);

      return {
        protocolVersion: result.protocolVersion,
        agentInfo: result.agentInfo,
        agentCapabilities: result.agentCapabilities,
      };
    } catch (err) {
      await transport.close();
      throw err;
    }
  }

  async shutdown(agentId: string): Promise<void> {
    const handle = this.agents.get(agentId);
    if (!handle) return; // Already shut down (e.g. by reap timer racing with manual shutdown)
    if (handle.reapTimer) {
      clearTimeout(handle.reapTimer);
      handle.reapTimer = null;
    }
    this.agents.delete(agentId);
    handle.activeSessions.clear();
    await handle.transport.close();
  }

  getAgent(agentId: string): AgentHandle {
    const handle = this.agents.get(agentId);
    if (!handle) throw new Error(`Agent "${agentId}" is not running. Call initialize first.`);
    return handle;
  }

  isRunning(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  getAllAgents(): AgentHandle[] {
    return Array.from(this.agents.values());
  }

  touchActivity(agentId: string): void {
    const handle = this.agents.get(agentId);
    if (!handle) return;
    handle.lastActivityAt = Date.now();
    const reapMs = getAgentConfig(this.config, agentId).autoReapMs;
    if (reapMs > 0) this.resetReapTimer(handle, reapMs);
  }

  updateInstalledAgents(installed: Map<string, InstalledAgent>): void {
    this.installedAgents = installed;
  }

  private resetReapTimer(handle: AgentHandle, reapMs: number): void {
    if (handle.reapTimer) clearTimeout(handle.reapTimer);
    handle.reapTimer = setTimeout(async () => {
      handle.status = { text: 'auto-reaped (inactivity)', updatedAt: Date.now() };
      await this.shutdown(handle.agentId).catch(() => {});
    }, reapMs);
    if (handle.reapTimer.unref) handle.reapTimer.unref();
  }
}
