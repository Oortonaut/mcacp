import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { McacpConfigSchema, type McacpConfig } from '../types/config.js';

const CONFIG_FILENAMES = ['mcacp.json', '.mcacprc.json'];

export function loadConfig(explicitPath?: string): McacpConfig {
  if (explicitPath) {
    try {
      const raw = JSON.parse(readFileSync(explicitPath, 'utf-8'));
      return McacpConfigSchema.parse(raw);
    } catch (err) {
      throw new Error(`Failed to load config from "${explicitPath}": ${err instanceof Error ? err.message : err}`);
    }
  }

  const searchDirs = [process.cwd()];
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) searchDirs.push(home);

  for (const dir of searchDirs) {
    for (const filename of CONFIG_FILENAMES) {
      const filepath = resolve(dir, filename);
      if (existsSync(filepath)) {
        try {
          const raw = JSON.parse(readFileSync(filepath, 'utf-8'));
          return McacpConfigSchema.parse(raw);
        } catch (err) {
          throw new Error(`Failed to load config from "${filepath}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  return McacpConfigSchema.parse({});
}

export function getAgentConfig(config: McacpConfig, agentId: string) {
  const agentOverride = config.agents[agentId];
  return {
    autoReapMs: agentOverride?.autoReapMs ?? config.defaultAutoReapMs,
    permissionPolicy: agentOverride?.permissionPolicy ?? config.defaultPermissionPolicy,
    installPath: agentOverride?.installPath,
    command: agentOverride?.command,
    args: agentOverride?.args,
    env: agentOverride?.env,
  };
}

export type { McacpConfig } from '../types/config.js';
