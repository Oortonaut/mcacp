import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { RegistryManager } from '../src/registry/index.js';
import type { RegistryEntry } from '../src/registry/index.js';
import type { McacpConfig } from '../src/types/config.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '[]'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

const mockedFs = vi.mocked(fs);

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

function makeConfig(overrides?: Partial<McacpConfig>): McacpConfig {
  return {
    registries: [REGISTRY_URL],
    agents: {},
    defaultAutoReapMs: 300000,
    defaultPermissionPolicy: 'elicit',
    sessionDir: './sessions',
    installDir: './test-agents',
    heartbeatTimeoutMs: 60000,
    clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
    ...overrides,
  };
}

const sampleEntries: RegistryEntry[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    version: '1.0.0',
    description: 'Anthropic coding agent',
    authors: ['Anthropic'],
    license: 'MIT',
    distribution: {
      npx: { package: '@anthropic/claude-code@1.0.0' },
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    version: '2.0.0',
    description: 'OpenAI coding agent',
    authors: ['OpenAI'],
    license: 'MIT',
    distribution: {
      binary: {
        'linux-x86_64': {
          archive: 'https://example.com/codex-linux.tar.gz',
          cmd: 'codex',
        },
        'darwin-aarch64': {
          archive: 'https://example.com/codex-darwin.tar.gz',
          cmd: 'codex',
        },
      },
    },
  },
  {
    id: 'aider',
    name: 'Aider',
    version: '3.0.0',
    description: 'AI pair programming tool',
    authors: ['Paul Gauthier'],
    license: 'Apache-2.0',
    distribution: {
      npx: { package: 'aider@3.0.0' },
    },
  },
];

describe('RegistryManager', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Reset fs mocks to defaults
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockReturnValue('[]');
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('listInstalled returns empty array initially', () => {
    const manager = new RegistryManager(makeConfig());
    const installed = manager.listInstalled();

    expect(installed).toEqual([]);
  });

  it('install throws for unknown agent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleEntries,
    }) as any;

    const manager = new RegistryManager(makeConfig());

    await expect(manager.install('nonexistent-agent')).rejects.toThrow(
      'Agent "nonexistent-agent" not found in any registry',
    );
  });

  it('search returns results filtered by query', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleEntries,
    }) as any;

    const manager = new RegistryManager(makeConfig());
    const results = await manager.search('claude');

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('claude-code');
    expect(results[0].name).toBe('Claude Code');
    expect(results[0].compatible).toBe(true); // npx is always compatible
  });

  it('search returns all compatible entries when no query given', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleEntries,
    }) as any;

    const manager = new RegistryManager(makeConfig());
    const results = await manager.search();

    // npx agents are always compatible; binary agents depend on platform
    const npxResults = results.filter(r => r.distribution.npx);
    expect(npxResults.length).toBe(2); // claude-code and aider
    for (const r of npxResults) {
      expect(r.compatible).toBe(true);
    }
  });

  it('search filters by description text', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleEntries,
    }) as any;

    const manager = new RegistryManager(makeConfig());
    const results = await manager.search('pair programming');

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('aider');
  });
});
