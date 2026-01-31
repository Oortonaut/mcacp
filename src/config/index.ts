import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { McacpConfigSchema, type McacpConfig, type AgentServer } from '../types/config.js';

const CONFIG_FILENAMES = ['mcacp.json', '.mcacprc.json'];

/** Discovered agent from an editor config. */
export interface DiscoveredAgent {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  source: string; // e.g. "zed", "jetbrains"
  configPath: string;
}

// ---- Config search paths per scope ----

function projectPaths(): string[] {
  return [process.cwd()];
}

function userPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    paths.push(join(appData, 'mcacp'));
  } else {
    paths.push(join(home, '.config', 'mcacp'));
  }
  paths.push(home); // legacy: ~/mcacp.json
  return paths;
}

function hostPaths(): string[] {
  if (platform() === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return [join(programData, 'mcacp')];
  }
  return ['/etc/mcacp'];
}

// ---- Config loading ----

function findConfigFile(dirs: string[]): string | null {
  for (const dir of dirs) {
    for (const filename of CONFIG_FILENAMES) {
      const filepath = resolve(dir, filename);
      if (existsSync(filepath)) return filepath;
    }
    // Also accept config.json in dedicated config dirs
    const configJson = resolve(dir, 'config.json');
    if (existsSync(configJson)) return configJson;
  }
  return null;
}

function loadRawConfig(filepath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse config "${filepath}": ${err instanceof Error ? err.message : err}`);
  }
}

/** Deep-merge config objects. Later values win. agent_servers entries merge per-key. */
function mergeConfigs(...configs: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) {
      if (key === 'agent_servers' && typeof value === 'object' && value !== null) {
        merged[key] = { ...(merged[key] as Record<string, unknown> ?? {}), ...value };
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Load config from multiple scopes: host < user < project < explicit.
 * agent_servers entries merge across scopes (project wins on conflict).
 */
export function loadConfig(explicitPath?: string): McacpConfig {
  const layers: Record<string, unknown>[] = [];

  // Host scope (lowest priority)
  const hostFile = findConfigFile(hostPaths());
  if (hostFile) layers.push(loadRawConfig(hostFile));

  // Project scope
  const projectFile = findConfigFile(projectPaths());
  if (projectFile) layers.push(loadRawConfig(projectFile));

  // User scope
  const userFile = findConfigFile(userPaths());
  if (userFile) layers.push(loadRawConfig(userFile));

  // Explicit path (highest priority)
  if (explicitPath) {
    layers.push(loadRawConfig(explicitPath));
  }

  const merged = layers.length > 0 ? mergeConfigs(...layers) : {};

  try {
    return McacpConfigSchema.parse(merged);
  } catch (err) {
    const sources = [hostFile, userFile, projectFile, explicitPath].filter(Boolean).join(', ');
    throw new Error(`Invalid config (sources: ${sources || 'defaults'}): ${err instanceof Error ? err.message : err}`);
  }
}

/** Resolve agent config by merging agent_servers entry with top-level defaults. */
export function getAgentConfig(config: McacpConfig, agentId: string) {
  const entry = config.agent_servers[agentId];
  return {
    autoReapMs: entry?.autoReapMs ?? config.defaultAutoReapMs,
    permissionPolicy: entry?.permissionPolicy ?? config.defaultPermissionPolicy,
    installPath: entry?.installPath,
    command: entry?.command,
    args: entry?.args,
    env: entry?.env,
  };
}

// ---- Editor config discovery ----

/** Known editor config locations. */
function editorConfigPaths(): Array<{ editor: string; path: string }> {
  const home = homedir();
  const results: Array<{ editor: string; path: string }> = [];

  // Zed
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    results.push({ editor: 'zed', path: join(appData, 'Zed', 'settings.json') });
  } else if (platform() === 'darwin') {
    results.push({ editor: 'zed', path: join(home, '.config', 'zed', 'settings.json') });
  } else {
    results.push({ editor: 'zed', path: join(home, '.config', 'zed', 'settings.json') });
  }

  // JetBrains
  results.push({ editor: 'jetbrains', path: join(home, '.jetbrains', 'acp.json') });

  return results;
}

/** Scan editor configs for agent_servers entries. */
export function discoverEditorAgents(): DiscoveredAgent[] {
  const discovered: DiscoveredAgent[] = [];

  for (const { editor, path: configPath } of editorConfigPaths()) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      const servers = raw?.agent_servers;
      if (!servers || typeof servers !== 'object') continue;

      for (const [name, entry] of Object.entries(servers)) {
        const e = entry as Record<string, unknown>;
        if (!e.command || typeof e.command !== 'string') continue;
        discovered.push({
          name,
          command: e.command,
          args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : undefined,
          env: e.env && typeof e.env === 'object' ? e.env as Record<string, string> : undefined,
          source: editor,
          configPath,
        });
      }
    } catch {
      // Skip unparseable configs
    }
  }

  return discovered;
}

export type { McacpConfig, AgentServer } from '../types/config.js';
