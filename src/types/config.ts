import { z } from 'zod';

export const PermissionPolicySchema = z.enum(['elicit', 'allow_all', 'deny_all', 'operator']);
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const AgentConfigSchema = z.object({
  /** Auto-reap timeout in milliseconds. 0 = disabled. Default: 300000 (5 min) */
  autoReapMs: z.number().min(0).default(300000),
  /** Default permission policy for new sessions with this agent */
  permissionPolicy: PermissionPolicySchema.default('elicit'),
  /** Custom install path override */
  installPath: z.string().optional(),
  /** Custom command override (skip registry lookup) */
  command: z.string().optional(),
  /** Custom args override */
  args: z.array(z.string()).optional(),
  /** Environment variables */
  env: z.record(z.string()).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const McacpConfigSchema = z.object({
  /** Registry URLs to fetch agent listings from */
  registries: z.array(z.string().url()).default(
    ['https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'],
  ),
  /** Per-agent configuration overrides */
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  /** Default auto-reap timeout in ms */
  defaultAutoReapMs: z.number().min(0).default(300000),
  /** Default permission policy */
  defaultPermissionPolicy: PermissionPolicySchema.default('elicit'),
  /** Directory for session persistence files */
  sessionDir: z.string().default('./sessions'),
  /** Directory for installed agent binaries */
  installDir: z.string().default('./agents'),
  /** Heartbeat timeout in ms — agent considered unresponsive after this */
  heartbeatTimeoutMs: z.number().min(0).default(60000),
  /** MCACP client info sent during ACP initialize */
  clientInfo: z.object({
    name: z.string().default('mcacp'),
    version: z.string().default('0.1.0'),
    title: z.string().default('MCACP Bridge'),
  }).default({}),
});
export type McacpConfig = z.infer<typeof McacpConfigSchema>;
