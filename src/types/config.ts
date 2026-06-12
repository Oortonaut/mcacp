import { z } from 'zod';

export const PermissionPolicySchema = z.enum(['elicit', 'allow_all', 'deny_all', 'operator']);
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/** Per-agent config — matches the Zed/JetBrains agent_servers schema at its core. */
export const AgentServerSchema = z.object({
  /** Executable command to run */
  command: z.string().optional(),
  /** Command-line arguments */
  args: z.array(z.string()).optional(),
  /** Environment variables */
  env: z.record(z.string()).optional(),
  // -- MCACP extensions (not in editor configs) --
  /** Auto-reap timeout in milliseconds. 0 = disabled. */
  autoReapMs: z.number().min(0).optional(),
  /** Default permission policy for new sessions with this agent */
  permissionPolicy: PermissionPolicySchema.optional(),
  /** Custom install path override */
  installPath: z.string().optional(),
});
export type AgentServer = z.infer<typeof AgentServerSchema>;

export const McacpConfigSchema = z.object({
  /** Registry URLs to fetch agent listings from */
  registries: z.array(z.string().url()).default(
    ['https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'],
  ),
  /** Per-agent configuration — same key as Zed and JetBrains */
  agent_servers: z.record(z.string(), AgentServerSchema).default({}),
  /** Default auto-reap timeout in ms */
  defaultAutoReapMs: z.number().min(0).default(300000),
  /** Default permission policy */
  defaultPermissionPolicy: PermissionPolicySchema.default('elicit'),
  /** Directory for session persistence files */
  sessionDir: z.string().default('./.mcacp'),
  /** Directory for installed agent binaries */
  installDir: z.string().default('./.mcacp/agents'),
  /** Nagle timeout (ms) for batching text chunk events. 0 = disabled (push every chunk immediately). */
  promptConsolidateMs: z.number().min(0).default(5000),
  /**
   * Timeout (ms) for an in-flight `session/prompt` request. 0 = unlimited (the
   * default). Prompts are long-running by nature; a non-zero value risks
   * abandoning a prompt while the agent is still working, which orphans the
   * agent and stalls subsequent prompts on the same session.
   */
  promptTimeoutMs: z.number().min(0).default(0),
  /** Heartbeat timeout in ms — agent considered unresponsive after this */
  heartbeatTimeoutMs: z.number().min(0).default(60000),
  /** Whether to expose feedback collection tools (give_feedback, list_feedback) */
  collectFeedback: z.boolean().default(false),
  /** Path to the feedback markdown file */
  feedbackFile: z.string().default('./.mcacp/feedback.md'),
  /** MCACP client info sent during ACP initialize */
  clientInfo: z.object({
    name: z.string().default('mcacp'),
    version: z.string().default('0.1.0'),
    title: z.string().default('MCACP Bridge'),
  }).default({}),
});
export type McacpConfig = z.infer<typeof McacpConfigSchema>;
