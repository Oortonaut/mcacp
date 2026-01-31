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

describe('loadConfig', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false);
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig();

    expect(config.registries).toEqual([
      'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    ]);
    expect(config.defaultPermissionPolicy).toBe('elicit');
    expect(config.defaultAutoReapMs).toBe(300000);
    expect(config.sessionDir).toBe('./sessions');
    expect(config.installDir).toBe('./agents');
    expect(config.agents).toEqual({});
    expect(config.clientInfo).toEqual({
      name: 'mcacp',
      version: '0.1.0',
      title: 'MCACP Bridge',
    });
  });
});

describe('getAgentConfig', () => {
  const baseConfig: McacpConfig = {
    registries: ['https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'],
    agents: {
      'my-agent': {
        autoReapMs: 60000,
        permissionPolicy: 'allow_all',
        command: '/usr/bin/my-agent',
        args: ['--mode', 'fast'],
        env: { DEBUG: '1' },
      },
    },
    defaultAutoReapMs: 300000,
    defaultPermissionPolicy: 'elicit',
    sessionDir: './sessions',
    installDir: './agents',
    heartbeatTimeoutMs: 60000,
    clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
  };

  it('returns merged agent config with overrides', () => {
    const result = getAgentConfig(baseConfig, 'my-agent');

    expect(result.autoReapMs).toBe(60000);
    expect(result.permissionPolicy).toBe('allow_all');
    expect(result.command).toBe('/usr/bin/my-agent');
    expect(result.args).toEqual(['--mode', 'fast']);
    expect(result.env).toEqual({ DEBUG: '1' });
    expect(result.installPath).toBeUndefined();
  });

  it('returns defaults when no agent-specific config exists', () => {
    const result = getAgentConfig(baseConfig, 'unknown-agent');

    expect(result.autoReapMs).toBe(300000);
    expect(result.permissionPolicy).toBe('elicit');
    expect(result.command).toBeUndefined();
    expect(result.args).toBeUndefined();
    expect(result.env).toBeUndefined();
    expect(result.installPath).toBeUndefined();
  });
});
