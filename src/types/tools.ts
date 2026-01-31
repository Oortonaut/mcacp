import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core type: every MCP tool exposed by MCACP is described by a ToolDefinition
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
}

// ---------------------------------------------------------------------------
// Shared / helper schemas
// ---------------------------------------------------------------------------

/**
 * Configuration for an MCP server that can be forwarded to a sub-agent.
 *
 * Two variants:
 *  - stdio: launch a local process (command + optional args / env)
 *  - http:  connect to a remote server over HTTP/SSE (url + optional headers)
 */
export const McpServerConfigSchema = z.union([
  z.object({
    name: z.string().describe('Unique display name for this MCP server.'),
    command: z.string().describe('Executable to launch (stdio transport).'),
    args: z.array(z.string()).optional().describe('Command-line arguments.'),
    env: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional()
      .describe('Extra environment variables passed to the process.'),
  }),
  z.object({
    type: z.literal('http'),
    name: z.string().describe('Unique display name for this MCP server.'),
    url: z.string().url().describe('Base URL of the HTTP/SSE MCP server.'),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional()
      .describe('Extra HTTP headers sent with every request.'),
  }),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * A single content block inside a structured prompt.
 *
 * - text:          plain or markdown text
 * - resource_link: reference to an external resource by URI
 */
export const ContentBlockInputSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string().describe('The text content of this block.'),
  }),
  z.object({
    type: z.literal('resource_link'),
    uri: z.string().describe('URI pointing to the linked resource.'),
    mimeType: z.string().optional().describe('MIME type of the resource (e.g. "text/plain").'),
  }),
]);

export type ContentBlockInput = z.infer<typeof ContentBlockInputSchema>;

/**
 * Client capability flags passed during initialize.
 */
export const ClientCapabilitiesSchema = z
  .object({
    fs: z
      .object({
        readTextFile: z
          .boolean()
          .optional()
          .describe('Client can read text files on behalf of the agent.'),
        writeTextFile: z
          .boolean()
          .optional()
          .describe('Client can write text files on behalf of the agent.'),
      })
      .optional()
      .describe('Filesystem capabilities offered by the client.'),
    terminal: z
      .boolean()
      .optional()
      .describe('Client can execute terminal commands on behalf of the agent.'),
  })
  .optional();

/** Use ClientCapabilities from acp.ts to avoid duplicate export. */
type ClientCapabilitiesInput = z.infer<typeof ClientCapabilitiesSchema>;

/**
 * Client identification passed during initialize.
 */
export const ClientInfoSchema = z.object({
  name: z.string().describe('Machine-readable name of the client application.'),
  version: z.string().describe('Semantic version of the client application.'),
  title: z
    .string()
    .optional()
    .describe('Human-readable display title of the client.'),
});

export type ClientInfo = z.infer<typeof ClientInfoSchema>;

// ---------------------------------------------------------------------------
// Input schemas - one per tool
// ---------------------------------------------------------------------------

// ---- Registry tools -------------------------------------------------------

export const ListInstalledAgentsInputSchema = z
  .object({})
  .describe('No parameters required.');

export const RegistrySearchInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Free-text search query. When omitted all available agents are returned.',
    ),
  showIncompatible: z
    .boolean()
    .default(false)
    .describe(
      'When true, results include agents that are not compatible with the current MCACP version. Defaults to false.',
    ),
});

export const AgentInstallInputSchema = z.object({
  agentId: z
    .string()
    .describe('Fully-qualified agent identifier (e.g. "vendor/agent-name").'),
  version: z
    .string()
    .optional()
    .describe(
      'Specific version to install. When omitted the latest compatible version is used.',
    ),
});

export const AgentUninstallInputSchema = z.object({
  agentId: z
    .string()
    .describe('Identifier of the installed agent to remove.'),
});

export const AgentCheckUpgradesInputSchema = z
  .object({})
  .describe('No parameters required.');

// ---- Lifecycle tools ------------------------------------------------------

export const InitializeInputSchema = z.object({
  agentId: z
    .string()
    .describe('Identifier of the installed agent to initialize.'),
  protocolVersion: z
    .number()
    .int()
    .optional()
    .describe(
      'ACP protocol version to negotiate. When omitted the latest supported version is used.',
    ),
  clientInfo: ClientInfoSchema.optional().describe(
    'Information about the calling client. Forwarded to the agent during the ACP handshake.',
  ),
  clientCapabilities: ClientCapabilitiesSchema.describe(
    'Capability flags describing what the client environment can do on behalf of the agent.',
  ),
});

export const ShutdownInputSchema = z.object({
  agentId: z
    .string()
    .describe('Identifier of the running agent to shut down.'),
});

// ---- Session tools --------------------------------------------------------

export const NewSessionInputSchema = z.object({
  agentId: z
    .string()
    .describe(
      'Identifier of the running agent that will own this session.',
    ),
  cwd: z
    .string()
    .describe('Absolute path to the working directory for the session.'),
  mcpServers: z
    .array(McpServerConfigSchema)
    .optional()
    .describe('MCP servers to make available inside this session.'),
  permissionPolicy: z
    .enum(['elicit', 'allow_all', 'deny_all', 'operator'])
    .optional()
    .describe(
      'How permission requests from the agent are handled. ' +
        '"elicit" prompts the user interactively; ' +
        '"allow_all" auto-approves every request; ' +
        '"deny_all" auto-denies every request; ' +
        '"operator" returns permission requests as updates for programmatic handling via grant_permission.',
    ),
});

export const LoadSessionInputSchema = z.object({
  agentId: z
    .string()
    .describe(
      'Identifier of the running agent that owns the session.',
    ),
  sessionId: z
    .string()
    .describe(
      'Unique identifier of the previously-created session to reload.',
    ),
  cwd: z
    .string()
    .describe(
      'Absolute path to the working directory for the resumed session.',
    ),
  mcpServers: z
    .array(McpServerConfigSchema)
    .optional()
    .describe(
      'MCP servers to make available inside the reloaded session.',
    ),
});

export const ListSessionsInputSchema = z.object({
  agentId: z
    .string()
    .optional()
    .describe(
      'When provided, only sessions belonging to this agent are returned.',
    ),
});

export const CloseSessionInputSchema = z.object({
  sessionId: z
    .string()
    .describe(
      'Identifier of the active session to close. The session file is preserved for later reloading.',
    ),
});

// ---- Interaction tools ----------------------------------------------------

export const PromptInputSchema = z.object({
  sessionId: z
    .string()
    .describe(
      'Identifier of the active session to send the prompt to.',
    ),
  prompt: z
    .union([z.string(), z.array(ContentBlockInputSchema)])
    .describe(
      'The user prompt. Supply a plain string for simple text (it will be wrapped in a text content block automatically), ' +
        'or an array of ContentBlockInput objects for structured multi-block prompts.',
    ),
});

export const GrantPermissionInputSchema = z.object({
  sessionId: z
    .string()
    .describe(
      'Identifier of the session that raised the permission request.',
    ),
  toolCallId: z
    .string()
    .describe(
      'The tool_call_id from the permission-request update that this response addresses.',
    ),
  optionId: z
    .string()
    .describe(
      'The chosen option identifier (e.g. "allow", "deny", "allow_always") as listed in the permission request.',
    ),
});

export const CancelInputSchema = z.object({
  sessionId: z
    .string()
    .describe(
      'Identifier of the session whose in-progress prompt should be cancelled.',
    ),
});

export const SetModeInputSchema = z.object({
  sessionId: z
    .string()
    .describe('Identifier of the active session.'),
  modeId: z
    .string()
    .describe(
      'Identifier of the operating mode to switch to (agent-defined).',
    ),
});

// ---- Status / monitoring tools --------------------------------------------

export const ListRunningAgentsInputSchema = z
  .object({})
  .describe('No parameters required.');

export const GetAgentStatusInputSchema = z.object({
  agentId: z
    .string()
    .describe('Identifier of the running agent to query.'),
});

export const SetAgentStatusInputSchema = z.object({
  agentId: z
    .string()
    .describe(
      'Identifier of the running agent whose status should be updated.',
    ),
  status: z
    .string()
    .describe(
      'Operator-defined status text to display for this agent (e.g. "idle", "working on X").',
    ),
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// ---- Registry tools -------------------------------------------------------

export const listInstalledAgents: ToolDefinition = {
  name: 'list_installed_agents',
  description:
    'List all locally installed ACP agents. Returns an array of objects, each containing the agent id, ' +
    "human-readable name, installed version, and a short description of the agent's capabilities.",
  inputSchema: ListInstalledAgentsInputSchema,
};

export const registrySearch: ToolDefinition = {
  name: 'registry_search',
  description:
    'Search all configured registries for available ACP agents. Provide an optional free-text query to ' +
    'filter results. By default only agents compatible with this MCACP version are shown; set ' +
    'showIncompatible to true to include all.',
  inputSchema: RegistrySearchInputSchema,
};

export const agentInstall: ToolDefinition = {
  name: 'agent_install',
  description:
    'Download and install an ACP agent from a configured registry. Specify the agent identifier and ' +
    'optionally pin a version. The agent is installed locally and becomes available for initialization.',
  inputSchema: AgentInstallInputSchema,
};

export const agentUninstall: ToolDefinition = {
  name: 'agent_uninstall',
  description:
    'Remove a locally installed ACP agent and all of its associated data. The agent must not be ' +
    'currently running; shut it down first if necessary.',
  inputSchema: AgentUninstallInputSchema,
};

export const agentCheckUpgrades: ToolDefinition = {
  name: 'agent_check_upgrades',
  description:
    'Check every installed agent against its source registry and report any available version upgrades. ' +
    'Returns a list of agents that have newer versions available along with current and latest version numbers.',
  inputSchema: AgentCheckUpgradesInputSchema,
};

// ---- Lifecycle tools ------------------------------------------------------

export const initialize: ToolDefinition = {
  name: 'initialize',
  description:
    'Spawn the agent process and perform the ACP initialize handshake. This must be called before ' +
    'creating sessions or sending prompts. Optionally pass client information and capability flags so ' +
    'the agent knows what the host environment supports.',
  inputSchema: InitializeInputSchema,
};

export const shutdown: ToolDefinition = {
  name: 'shutdown',
  description:
    'Gracefully shut down a running agent process. All active sessions owned by the agent are closed ' +
    'first. After shutdown the agent must be re-initialized before it can be used again.',
  inputSchema: ShutdownInputSchema,
};

// ---- Session tools --------------------------------------------------------

export const newSession: ToolDefinition = {
  name: 'new_session',
  description:
    'Create a new ACP session on a running agent. A session provides an isolated conversation context ' +
    'with its own working directory, MCP server set, and permission policy. Returns the new session identifier.',
  inputSchema: NewSessionInputSchema,
};

export const loadSession: ToolDefinition = {
  name: 'load_session',
  description:
    'Reload a previously created session from its persisted session file. The session resumes with its ' +
    'prior conversation history. You may supply a different working directory or MCP server set for the ' +
    'reloaded session.',
  inputSchema: LoadSessionInputSchema,
};

export const listSessions: ToolDefinition = {
  name: 'list_sessions',
  description:
    'List all stored ACP sessions. Optionally filter by agent identifier. Returns session metadata ' +
    'including session id, owning agent, creation time, and current status.',
  inputSchema: ListSessionsInputSchema,
};

export const closeSession: ToolDefinition = {
  name: 'close_session',
  description:
    'Close an active session. The session file is preserved on disk so the session can be reloaded later ' +
    'with load_session. Any in-progress prompt is cancelled before closing.',
  inputSchema: CloseSessionInputSchema,
};

// ---- Interaction tools ----------------------------------------------------

export const prompt: ToolDefinition = {
  name: 'prompt',
  description:
    'Send a user prompt to an active session and wait for the agent to finish responding. The prompt can ' +
    'be a plain string (automatically wrapped in a text content block) or a structured array of content ' +
    'blocks for multi-modal input. Returns an object with a stopReason string and an updates array ' +
    'containing all agent output events produced during this turn.',
  inputSchema: PromptInputSchema,
};

export const grantPermission: ToolDefinition = {
  name: 'grant_permission',
  description:
    'Respond to a pending permission request from an agent session that uses the "operator" permission ' +
    'policy. Supply the toolCallId from the permission-request update and the chosen optionId (e.g. ' +
    '"allow", "deny", "allow_always"). The agent resumes execution with the granted (or denied) permission.',
  inputSchema: GrantPermissionInputSchema,
};

export const cancel: ToolDefinition = {
  name: 'cancel',
  description:
    'Cancel an in-progress prompt on an active session. The agent is sent a cancellation signal and any ' +
    'partial results are discarded. The session remains open and ready for new prompts.',
  inputSchema: CancelInputSchema,
};

export const setMode: ToolDefinition = {
  name: 'set_mode',
  description:
    "Switch the operating mode of an active session. Modes are agent-defined and control the agent's " +
    'behavior profile (e.g. "plan" vs "execute", "code" vs "review"). The available mode identifiers ' +
    'depend on the specific agent.',
  inputSchema: SetModeInputSchema,
};

// ---- Status / monitoring tools --------------------------------------------

export const listRunningAgents: ToolDefinition = {
  name: 'list_running_agents',
  description:
    "List all currently spawned (running) agent processes. Returns an array with each agent's " +
    'identifier, process status, last heartbeat timestamp, and the identifiers of its active sessions.',
  inputSchema: ListRunningAgentsInputSchema,
};

export const getAgentStatus: ToolDefinition = {
  name: 'get_agent_status',
  description:
    'Retrieve detailed runtime status for a single running agent. Includes process health, uptime, ' +
    'memory usage, and per-session activity information such as the current prompt state and turn count.',
  inputSchema: GetAgentStatusInputSchema,
};

export const setAgentStatus: ToolDefinition = {
  name: 'set_agent_status',
  description:
    'Set an operator-defined status string on a running agent. This status is surfaced in monitoring ' +
    'views and can be used by the orchestrating agent to communicate high-level intent (e.g. "working ' +
    'on task X", "waiting for review").',
  inputSchema: SetAgentStatusInputSchema,
};

// ---------------------------------------------------------------------------
// Aggregate exports
// ---------------------------------------------------------------------------

/**
 * All MCACP tool definitions in a single array.
 * Useful for bulk registration with an MCP server.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  // Registry
  listInstalledAgents,
  registrySearch,
  agentInstall,
  agentUninstall,
  agentCheckUpgrades,
  // Lifecycle
  initialize,
  shutdown,
  // Session
  newSession,
  loadSession,
  listSessions,
  closeSession,
  // Interaction
  prompt,
  grantPermission,
  cancel,
  setMode,
  // Status / monitoring
  listRunningAgents,
  getAgentStatus,
  setAgentStatus,
];

/**
 * Record mapping every tool name to its Zod input schema.
 * Useful for runtime validation of incoming tool-call arguments.
 */
export const TOOL_SCHEMAS: Record<string, z.ZodType<any>> = {
  // Registry
  list_installed_agents: ListInstalledAgentsInputSchema,
  registry_search: RegistrySearchInputSchema,
  agent_install: AgentInstallInputSchema,
  agent_uninstall: AgentUninstallInputSchema,
  agent_check_upgrades: AgentCheckUpgradesInputSchema,
  // Lifecycle
  initialize: InitializeInputSchema,
  shutdown: ShutdownInputSchema,
  // Session
  new_session: NewSessionInputSchema,
  load_session: LoadSessionInputSchema,
  list_sessions: ListSessionsInputSchema,
  close_session: CloseSessionInputSchema,
  // Interaction
  prompt: PromptInputSchema,
  grant_permission: GrantPermissionInputSchema,
  cancel: CancelInputSchema,
  set_mode: SetModeInputSchema,
  // Status / monitoring
  list_running_agents: ListRunningAgentsInputSchema,
  get_agent_status: GetAgentStatusInputSchema,
  set_agent_status: SetAgentStatusInputSchema,
};
