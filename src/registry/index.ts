import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { McacpConfig } from '../types/config.js';
import type { InstalledAgent } from '../acp/lifecycle.js';

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  authors: string[];
  license: string;
  icon?: string;
  distribution: {
    npx?: { package: string };
    binary?: Record<string, {
      archive: string;
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
}

interface RegistryCache {
  entries: RegistryEntry[];
  fetchedAt: number;
  url: string;
}

const CACHE_TTL_MS = 3600_000;

export class RegistryManager {
  private caches = new Map<string, RegistryCache>();
  private installed = new Map<string, InstalledAgent>();
  private agentsJsonPath: string;

  constructor(private config: McacpConfig) {
    this.agentsJsonPath = resolve(config.installDir, 'agents.json');
    this.loadInstalled();
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.config.registries.map(url => this.fetchRegistry(url)));
  }

  async search(query?: string, showIncompatible = false): Promise<(RegistryEntry & { compatible: boolean })[]> {
    await this.refreshAll();
    const platform = getPlatformKey();
    const seen = new Set<string>();
    const results: (RegistryEntry & { compatible: boolean })[] = [];

    for (const cache of this.caches.values()) {
      for (const entry of cache.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const compatible = isCompatible(entry, platform);
        if (!compatible && !showIncompatible) continue;
        if (query) {
          const q = query.toLowerCase();
          const matches = entry.id.toLowerCase().includes(q) ||
            entry.name.toLowerCase().includes(q) ||
            entry.description.toLowerCase().includes(q) ||
            entry.authors.some(a => a.toLowerCase().includes(q));
          if (!matches) continue;
        }
        results.push({ ...entry, compatible });
      }
    }
    return results;
  }

  async install(agentId: string, version?: string): Promise<InstalledAgent> {
    await this.refreshAll();
    const entry = this.findEntry(agentId);
    if (!entry) throw new Error(`Agent "${agentId}" not found in any registry`);
    const platform = getPlatformKey();

    if (entry.distribution.npx) {
      let pkg = entry.distribution.npx.package;
      if (version) {
        // Replace existing version suffix, or append if none present
        pkg = pkg.replace(/@[\d.]+[-\w.]*$/, '') + `@${version}`;
      }
      const inst: InstalledAgent = {
        id: entry.id, name: entry.name, version: version ?? entry.version,
        description: entry.description, command: 'npx', args: ['-y', pkg],
        distribution: 'npx', installedAt: new Date().toISOString(),
      };
      this.installed.set(entry.id, inst);
      this.saveInstalled();
      return inst;
    }

    if (entry.distribution.binary) {
      const bin = entry.distribution.binary[platform];
      if (!bin) throw new Error(`No binary for platform "${platform}". Available: ${Object.keys(entry.distribution.binary).join(', ')}`);
      const installDir = resolve(this.config.installDir, entry.id);
      mkdirSync(installDir, { recursive: true });
      const archivePath = join(installDir, 'archive.tar.gz');
      execFileSync('curl', ['-fsSL', '-o', archivePath, bin.archive], { cwd: installDir });
      execFileSync('tar', ['-xzf', archivePath, '-C', installDir], { cwd: installDir });
      try { rmSync(archivePath); } catch {}
      const inst: InstalledAgent = {
        id: entry.id, name: entry.name, version: entry.version,
        description: entry.description, command: resolve(installDir, bin.cmd),
        args: bin.args, env: bin.env, distribution: 'binary',
        installedAt: new Date().toISOString(),
      };
      this.installed.set(entry.id, inst);
      this.saveInstalled();
      return inst;
    }

    throw new Error(`Agent "${agentId}" has no installable distribution`);
  }

  uninstall(agentId: string): void {
    const inst = this.installed.get(agentId);
    if (!inst) throw new Error(`Agent "${agentId}" is not installed`);
    if (inst.distribution === 'binary') {
      try { rmSync(resolve(this.config.installDir, agentId), { recursive: true, force: true }); } catch {}
    }
    this.installed.delete(agentId);
    this.saveInstalled();
  }

  async checkUpgrades(): Promise<{ agentId: string; installed: string; available: string }[]> {
    await this.refreshAll();
    const upgrades: { agentId: string; installed: string; available: string }[] = [];
    for (const [id, inst] of this.installed) {
      const entry = this.findEntry(id);
      if (entry && entry.version !== inst.version) {
        upgrades.push({ agentId: id, installed: inst.version, available: entry.version });
      }
    }
    return upgrades;
  }

  getInstalled(): Map<string, InstalledAgent> { return this.installed; }
  listInstalled(): InstalledAgent[] { return Array.from(this.installed.values()); }

  private findEntry(agentId: string): RegistryEntry | undefined {
    for (const cache of this.caches.values()) {
      const entry = cache.entries.find(e => e.id === agentId);
      if (entry) return entry;
    }
    return undefined;
  }

  private async fetchRegistry(url: string): Promise<void> {
    const cached = this.caches.get(url);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as RegistryEntry[];
      this.caches.set(url, { entries: data, fetchedAt: Date.now(), url });
    } catch (err) {
      if (!cached) throw new Error(`Failed to fetch registry ${url}: ${err}`);
    }
  }

  private loadInstalled(): void {
    if (existsSync(this.agentsJsonPath)) {
      try {
        const data = JSON.parse(readFileSync(this.agentsJsonPath, 'utf-8'));
        if (Array.isArray(data)) for (const a of data) this.installed.set(a.id, a);
      } catch {}
    }
  }

  private saveInstalled(): void {
    mkdirSync(resolve(this.config.installDir), { recursive: true });
    writeFileSync(this.agentsJsonPath, JSON.stringify(Array.from(this.installed.values()), null, 2));
  }
}

function getPlatformKey(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  return `${os}-${arch}`;
}

function isCompatible(entry: RegistryEntry, platform: string): boolean {
  if (entry.distribution.npx) return true;
  return !!(entry.distribution.binary && entry.distribution.binary[platform]);
}
