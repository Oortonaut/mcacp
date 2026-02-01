import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifecycleManager } from '../src/acp/lifecycle.js';
import type { InstalledAgent } from '../src/acp/lifecycle.js';
import type { McacpConfig } from '../src/types/config.js';

// ---------------------------------------------------------------------------
// Mock AcpTransport — avoid real subprocess spawning entirely
// ---------------------------------------------------------------------------

const mockTransportInstances: Array<{
  options: any;
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  lastMessageAt: number;
  closed: boolean;
}> = [];

vi.mock('../src/acp/transport.js', () => {
  return {
    AcpTransport: vi.fn().mockImplementation((options: any) => {
      const instance = {
        options,
        start: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
        request: vi.fn().mockResolvedValue({
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: 'TestAgent', version: '1.0.0' },
        }),
        on: vi.fn(),
        setNotificationHandler: vi.fn(),
        setRequestHandler: vi.fn(),
        lastMessageAt: Date.now(),
        closed: false,
      };
      mockTransportInstances.push(instance);
      return instance;
    }),
  };
});

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
    promptConsolidateMs: 0,
    heartbeatTimeoutMs: 60000,
    clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    ...overrides,
  };
}

function makeInstalledAgent(overrides?: Partial<InstalledAgent>): InstalledAgent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    version: '1.0.0',
    description: 'A test agent',
    command: 'node',
    args: ['agent.js'],
    env: { AGENT_MODE: 'test', LOG_LEVEL: 'info' },
    distribution: 'local' as const,
    installedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LifecycleManager', () => {
  beforeEach(() => {
    mockTransportInstances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Env merging on initialize
  // -----------------------------------------------------------------------
  describe('env merging', () => {
    it('uses config env when no overrides given', async () => {
      const config = makeConfig({
        agent_servers: {
          'my-agent': {
            command: 'node',
            args: ['agent.js'],
            env: { CONFIG_KEY: 'config-val', SHARED: 'from-config' },
          },
        },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');

      expect(mockTransportInstances).toHaveLength(1);
      const transportOpts = mockTransportInstances[0].options;

      expect(transportOpts.env).toEqual({ CONFIG_KEY: 'config-val', SHARED: 'from-config' });

      await lm.shutdown('my-agent');
    });

    it('uses installed agent env when no config env and no overrides', async () => {
      const config = makeConfig(); // no agent_servers entry
      const installed = new Map<string, InstalledAgent>();
      installed.set('my-agent', makeInstalledAgent({
        id: 'my-agent',
        env: { INSTALLED_KEY: 'installed-val' },
      }));
      const lm = new LifecycleManager(config, installed);

      await lm.initialize('my-agent');

      const transportOpts = mockTransportInstances[0].options;
      expect(transportOpts.env).toEqual({ INSTALLED_KEY: 'installed-val' });

      await lm.shutdown('my-agent');
    });

    it('runtime env overrides merge on top of config env', async () => {
      const config = makeConfig({
        agent_servers: {
          'my-agent': {
            command: 'node',
            args: ['agent.js'],
            env: { CONFIG_KEY: 'config-val', SHARED: 'from-config' },
          },
        },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent', undefined, undefined, undefined, {
        RUNTIME_KEY: 'runtime-val',
        SHARED: 'from-runtime',
      });

      const transportOpts = mockTransportInstances[0].options;
      const env = transportOpts.env;

      // Config key still present
      expect(env.CONFIG_KEY).toBe('config-val');
      // Runtime override wins on shared key
      expect(env.SHARED).toBe('from-runtime');
      // Runtime-only key present
      expect(env.RUNTIME_KEY).toBe('runtime-val');

      await lm.shutdown('my-agent');
    });

    it('runtime env overrides specific config keys', async () => {
      const config = makeConfig({
        agent_servers: {
          'my-agent': {
            command: 'node',
            args: ['agent.js'],
            env: { A: '1', B: '2', C: '3' },
          },
        },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent', undefined, undefined, undefined, { B: 'overridden' });

      const env = mockTransportInstances[0].options.env;

      expect(env.A).toBe('1');
      expect(env.B).toBe('overridden');
      expect(env.C).toBe('3');

      await lm.shutdown('my-agent');
    });

    it('passes undefined env when neither config nor installed have env', async () => {
      const config = makeConfig({
        agent_servers: {
          'no-env-agent': { command: 'node', args: ['agent.js'] },
        },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('no-env-agent');

      const env = mockTransportInstances[0].options.env;

      // baseEnv is undefined, no overrides => env is undefined
      expect(env).toBeUndefined();

      await lm.shutdown('no-env-agent');
    });

    it('runtime overrides spread over undefined base env', async () => {
      const config = makeConfig({
        agent_servers: {
          'no-base-agent': { command: 'node', args: ['agent.js'] },
          // No env defined
        },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('no-base-agent', undefined, undefined, undefined, {
        ONLY_RUNTIME: 'val',
      });

      const env = mockTransportInstances[0].options.env;

      // { ...undefined, ...{ ONLY_RUNTIME: 'val' } } => { ONLY_RUNTIME: 'val' }
      expect(env.ONLY_RUNTIME).toBe('val');

      await lm.shutdown('no-base-agent');
    });

    it('config env takes priority over installed env', async () => {
      const config = makeConfig({
        agent_servers: {
          'my-agent': {
            command: 'node',
            env: { SOURCE: 'config' },
          },
        },
      });
      const installed = new Map<string, InstalledAgent>();
      installed.set('my-agent', makeInstalledAgent({
        id: 'my-agent',
        env: { SOURCE: 'installed' },
      }));
      const lm = new LifecycleManager(config, installed);

      await lm.initialize('my-agent');

      const env = mockTransportInstances[0].options.env;

      // getAgentConfig returns config entry env, which takes priority via ??
      expect(env.SOURCE).toBe('config');

      await lm.shutdown('my-agent');
    });
  });

  // -----------------------------------------------------------------------
  // General lifecycle
  // -----------------------------------------------------------------------
  describe('initialize', () => {
    it('throws if agent is already running', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');

      await expect(lm.initialize('my-agent')).rejects.toThrow(
        'Agent "my-agent" is already running',
      );

      await lm.shutdown('my-agent');
    });

    it('throws if agent has no command configured or installed', async () => {
      const config = makeConfig();
      const lm = new LifecycleManager(config, new Map());

      await expect(lm.initialize('nonexistent')).rejects.toThrow(
        'Agent "nonexistent" not installed and no command configured',
      );
    });

    it('returns protocolVersion and capabilities from agent', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      const result = await lm.initialize('my-agent');

      expect(result.protocolVersion).toBe(1);
      expect(result.agentCapabilities).toEqual({ loadSession: true });
      expect(result.agentInfo).toEqual({ name: 'TestAgent', version: '1.0.0' });

      await lm.shutdown('my-agent');
    });

    it('falls back to installed agent command when config has none', async () => {
      const config = makeConfig(); // no agent_servers
      const installed = new Map<string, InstalledAgent>();
      installed.set('my-agent', makeInstalledAgent({
        id: 'my-agent',
        command: '/usr/bin/my-agent',
        args: ['--serve'],
      }));
      const lm = new LifecycleManager(config, installed);

      await lm.initialize('my-agent');

      const transportOpts = mockTransportInstances[0].options;
      expect(transportOpts.command).toBe('/usr/bin/my-agent');
      expect(transportOpts.args).toEqual(['--serve']);

      await lm.shutdown('my-agent');
    });

    it('starts the transport', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');

      expect(mockTransportInstances[0].start).toHaveBeenCalledOnce();

      await lm.shutdown('my-agent');
    });

    it('sends initialize request on the transport', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');

      expect(mockTransportInstances[0].request).toHaveBeenCalledWith(
        'initialize',
        expect.objectContaining({
          protocolVersion: 1,
          clientCapabilities: expect.any(Object),
        }),
      );

      await lm.shutdown('my-agent');
    });

    it('closes transport if initialize request fails', async () => {
      const config = makeConfig({
        agent_servers: { 'fail-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      // Make the first transport instance's request fail
      // Need to setup the mock before calling initialize
      const { AcpTransport } = await import('../src/acp/transport.js');
      const mockAcpTransport = vi.mocked(AcpTransport);
      mockAcpTransport.mockImplementationOnce((options: any) => {
        const instance = {
          options,
          start: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
          request: vi.fn().mockRejectedValue(new Error('Agent rejected init')),
          on: vi.fn(),
          setNotificationHandler: vi.fn(),
          setRequestHandler: vi.fn(),
          lastMessageAt: Date.now(),
          closed: false,
        };
        mockTransportInstances.push(instance);
        return instance as any;
      });

      await expect(lm.initialize('fail-agent')).rejects.toThrow('Agent rejected init');

      // Transport should have been closed on error
      const transport = mockTransportInstances[mockTransportInstances.length - 1];
      expect(transport.close).toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('removes agent from running set', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');
      expect(lm.isRunning('my-agent')).toBe(true);

      await lm.shutdown('my-agent');
      expect(lm.isRunning('my-agent')).toBe(false);
    });

    it('is idempotent (no error on double shutdown)', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');
      await lm.shutdown('my-agent');
      // Second shutdown should not throw
      await lm.shutdown('my-agent');
    });

    it('closes the transport', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');
      const transport = mockTransportInstances[0];

      await lm.shutdown('my-agent');

      expect(transport.close).toHaveBeenCalled();
    });
  });

  describe('getAgent', () => {
    it('returns the agent handle', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');
      const handle = lm.getAgent('my-agent');

      expect(handle.agentId).toBe('my-agent');
      expect(handle.protocolVersion).toBe(1);

      await lm.shutdown('my-agent');
    });

    it('throws if agent is not running', () => {
      const config = makeConfig();
      const lm = new LifecycleManager(config, new Map());

      expect(() => lm.getAgent('nonexistent')).toThrow(
        'Agent "nonexistent" is not running. Call initialize first.',
      );
    });
  });

  describe('getAllAgents', () => {
    it('returns empty array when no agents running', () => {
      const config = makeConfig();
      const lm = new LifecycleManager(config, new Map());

      expect(lm.getAllAgents()).toEqual([]);
    });

    it('returns all running agents', async () => {
      const config = makeConfig({
        agent_servers: {
          'agent-a': { command: 'node' },
          'agent-b': { command: 'node' },
        },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('agent-a');
      await lm.initialize('agent-b');

      const all = lm.getAllAgents();
      expect(all).toHaveLength(2);
      const ids = all.map(h => h.agentId).sort();
      expect(ids).toEqual(['agent-a', 'agent-b']);

      await lm.shutdown('agent-a');
      await lm.shutdown('agent-b');
    });
  });

  describe('isRunning', () => {
    it('returns false for unknown agent', () => {
      const config = makeConfig();
      const lm = new LifecycleManager(config, new Map());

      expect(lm.isRunning('unknown')).toBe(false);
    });

    it('returns true for initialized agent', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');
      expect(lm.isRunning('my-agent')).toBe(true);

      await lm.shutdown('my-agent');
    });
  });

  describe('touchActivity', () => {
    it('updates lastActivityAt on the handle', async () => {
      const config = makeConfig({
        agent_servers: { 'my-agent': { command: 'node' } },
      });
      const lm = new LifecycleManager(config, new Map());

      await lm.initialize('my-agent');
      const handle = lm.getAgent('my-agent');
      const before = handle.lastActivityAt;

      // Small delay to ensure timestamp difference
      await new Promise(r => setTimeout(r, 10));
      lm.touchActivity('my-agent');

      expect(handle.lastActivityAt).toBeGreaterThanOrEqual(before);

      await lm.shutdown('my-agent');
    });

    it('does nothing for non-running agents (no error)', () => {
      const config = makeConfig();
      const lm = new LifecycleManager(config, new Map());

      // Should not throw
      lm.touchActivity('nonexistent');
    });
  });

  describe('updateInstalledAgents', () => {
    it('updates the installed agents map', async () => {
      const config = makeConfig();
      const installed = new Map<string, InstalledAgent>();
      const lm = new LifecycleManager(config, installed);

      // Agent not installed initially
      await expect(lm.initialize('new-agent')).rejects.toThrow('not installed');

      // Update with the new agent
      const updated = new Map<string, InstalledAgent>();
      updated.set('new-agent', makeInstalledAgent({
        id: 'new-agent',
        command: '/usr/bin/new-agent',
      }));
      lm.updateInstalledAgents(updated);

      // Now it should work
      await lm.initialize('new-agent');
      expect(lm.isRunning('new-agent')).toBe(true);

      await lm.shutdown('new-agent');
    });
  });
});
