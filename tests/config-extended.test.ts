import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as fs from 'node:fs';
import { loadConfig, getAgentConfig } from '../src/config/index.js';
import type { McacpConfig } from '../src/types/config.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  };
});

const mockedFs = vi.mocked(fs);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a McacpConfig with predictable defaults. */
function defaultConfig(): McacpConfig {
  return loadConfig(); // relies on mocked existsSync returning false
}

describe('loadConfig defaults', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false);
  });

  it('returns sensible defaults when no config files exist', () => {
    const config = loadConfig();

    expect(config.registries).toEqual([
      'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    ]);
    expect(config.defaultPermissionPolicy).toBe('elicit');
    expect(config.defaultAutoReapMs).toBe(300000);
    expect(config.sessionDir).toBe('./.mcacp');
    expect(config.installDir).toBe('./.mcacp/agents');
    expect(config.agent_servers).toEqual({});
    expect(config.heartbeatTimeoutMs).toBe(60000);
    expect(config.promptConsolidateMs).toBe(5000);
    expect(config.clientInfo).toEqual({
      name: 'mcacp',
      version: '0.1.0',
      title: 'MCACP Bridge',
    });
  });

  it('all default fields have expected types', () => {
    const config = loadConfig();

    expect(typeof config.defaultAutoReapMs).toBe('number');
    expect(typeof config.defaultPermissionPolicy).toBe('string');
    expect(typeof config.sessionDir).toBe('string');
    expect(typeof config.installDir).toBe('string');
    expect(typeof config.heartbeatTimeoutMs).toBe('number');
    expect(typeof config.promptConsolidateMs).toBe('number');
    expect(Array.isArray(config.registries)).toBe(true);
    expect(typeof config.agent_servers).toBe('object');
    expect(typeof config.clientInfo).toBe('object');
  });
});

describe('loadConfig merging', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false);
  });

  it('explicit path overrides defaults', () => {
    // existsSync returns true only for the explicit config path
    mockedFs.existsSync.mockImplementation((p: any) => {
      return String(p) === '/my/config.json';
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({
      defaultPermissionPolicy: 'allow_all',
      defaultAutoReapMs: 60000,
    }));

    const config = loadConfig('/my/config.json');

    expect(config.defaultPermissionPolicy).toBe('allow_all');
    expect(config.defaultAutoReapMs).toBe(60000);
    // Other defaults should still be present
    expect(config.sessionDir).toBe('./.mcacp');
    expect(config.installDir).toBe('./.mcacp/agents');
  });

  it('agent_servers entries merge across layers', () => {
    // Simulate two layers: first call finds a "host" config, second finds "project"
    let callCount = 0;
    mockedFs.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      // Host config
      if (path.includes('ProgramData') && path.endsWith('mcacp.json')) return true;
      if (path === '/etc/mcacp/mcacp.json') return true;
      // Explicit path
      if (path === '/explicit/config.json') return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes('ProgramData') || path === '/etc/mcacp/mcacp.json') {
        return JSON.stringify({
          agent_servers: {
            'host-agent': { command: '/usr/bin/host-agent' },
            'shared-agent': { command: '/usr/bin/shared-old' },
          },
        });
      }
      if (path === '/explicit/config.json') {
        return JSON.stringify({
          agent_servers: {
            'explicit-agent': { command: '/usr/bin/explicit-agent' },
            'shared-agent': { command: '/usr/bin/shared-new' },
          },
        });
      }
      return '{}';
    });

    const config = loadConfig('/explicit/config.json');

    // Both agents should be present
    expect(config.agent_servers['host-agent']).toBeDefined();
    expect(config.agent_servers['explicit-agent']).toBeDefined();
    // Explicit scope wins on conflict
    expect(config.agent_servers['shared-agent']?.command).toBe('/usr/bin/shared-new');
  });

  it('throws on invalid JSON in config file', () => {
    mockedFs.existsSync.mockImplementation((p: any) => {
      return String(p) === '/bad/config.json';
    });
    mockedFs.readFileSync.mockReturnValue('not valid json{{{');

    expect(() => loadConfig('/bad/config.json')).toThrow('Failed to parse config');
  });

  it('throws on schema-invalid config content', () => {
    mockedFs.existsSync.mockImplementation((p: any) => {
      return String(p) === '/invalid/config.json';
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({
      defaultAutoReapMs: -100, // min(0) violation
    }));

    expect(() => loadConfig('/invalid/config.json')).toThrow('Invalid config');
  });
});

describe('getAgentConfig', () => {
  it('returns merged agent config with per-agent overrides', () => {
    const config: McacpConfig = {
      registries: ['https://example.com/registry.json'],
      agent_servers: {
        'my-agent': {
          autoReapMs: 60000,
          permissionPolicy: 'allow_all',
          command: '/usr/bin/my-agent',
          args: ['--mode', 'fast'],
          env: { DEBUG: '1' },
          installPath: '/opt/agents/my-agent',
        },
      },
      defaultAutoReapMs: 300000,
      defaultPermissionPolicy: 'elicit',
      sessionDir: './.mcacp',
      installDir: './.mcacp/agents',
      promptConsolidateMs: 5000,
      heartbeatTimeoutMs: 60000,
      clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    };

    const result = getAgentConfig(config, 'my-agent');

    expect(result.autoReapMs).toBe(60000);
    expect(result.permissionPolicy).toBe('allow_all');
    expect(result.command).toBe('/usr/bin/my-agent');
    expect(result.args).toEqual(['--mode', 'fast']);
    expect(result.env).toEqual({ DEBUG: '1' });
    expect(result.installPath).toBe('/opt/agents/my-agent');
  });

  it('falls back to global defaults for unknown agents', () => {
    const config: McacpConfig = {
      registries: ['https://example.com/registry.json'],
      agent_servers: {},
      defaultAutoReapMs: 300000,
      defaultPermissionPolicy: 'elicit',
      sessionDir: './.mcacp',
      installDir: './.mcacp/agents',
      promptConsolidateMs: 5000,
      heartbeatTimeoutMs: 60000,
      clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    };

    const result = getAgentConfig(config, 'unknown-agent');

    expect(result.autoReapMs).toBe(300000);
    expect(result.permissionPolicy).toBe('elicit');
    expect(result.command).toBeUndefined();
    expect(result.args).toBeUndefined();
    expect(result.env).toBeUndefined();
    expect(result.installPath).toBeUndefined();
  });

  it('partial agent config inherits defaults for missing fields', () => {
    const config: McacpConfig = {
      registries: ['https://example.com/registry.json'],
      agent_servers: {
        'partial-agent': {
          command: '/usr/bin/partial',
          // No autoReapMs, permissionPolicy, args, env, installPath
        },
      },
      defaultAutoReapMs: 120000,
      defaultPermissionPolicy: 'deny_all',
      sessionDir: './.mcacp',
      installDir: './.mcacp/agents',
      promptConsolidateMs: 5000,
      heartbeatTimeoutMs: 60000,
      clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    };

    const result = getAgentConfig(config, 'partial-agent');

    // Specified field
    expect(result.command).toBe('/usr/bin/partial');
    // Falls back to defaults
    expect(result.autoReapMs).toBe(120000);
    expect(result.permissionPolicy).toBe('deny_all');
    // Not specified anywhere
    expect(result.args).toBeUndefined();
    expect(result.env).toBeUndefined();
    expect(result.installPath).toBeUndefined();
  });

  it('agent-specific autoReapMs=0 disables reaping (not inherited)', () => {
    const config: McacpConfig = {
      registries: ['https://example.com/registry.json'],
      agent_servers: {
        'no-reap-agent': { autoReapMs: 0 },
      },
      defaultAutoReapMs: 300000,
      defaultPermissionPolicy: 'elicit',
      sessionDir: './.mcacp',
      installDir: './.mcacp/agents',
      promptConsolidateMs: 5000,
      heartbeatTimeoutMs: 60000,
      clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    };

    const result = getAgentConfig(config, 'no-reap-agent');

    // Should use the agent-specific value, not the default
    expect(result.autoReapMs).toBe(0);
  });

  it('each permission policy is accepted as valid', () => {
    const policies = ['elicit', 'allow_all', 'deny_all', 'operator'] as const;

    for (const policy of policies) {
      const config: McacpConfig = {
        registries: ['https://example.com/registry.json'],
        agent_servers: {
          'policy-agent': { permissionPolicy: policy },
        },
        defaultAutoReapMs: 300000,
        defaultPermissionPolicy: 'elicit',
        sessionDir: './.mcacp',
        installDir: './.mcacp/agents',
        promptConsolidateMs: 5000,
        heartbeatTimeoutMs: 60000,
        clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
      };

      const result = getAgentConfig(config, 'policy-agent');
      expect(result.permissionPolicy).toBe(policy);
    }
  });
});
