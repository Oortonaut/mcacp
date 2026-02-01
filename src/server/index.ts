import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, discoverEditorAgents } from '../config/index.js';
import { RegistryManager } from '../registry/index.js';
import { LifecycleManager } from '../acp/lifecycle.js';
import { SessionManager } from '../sessions/index.js';
import { PromptHandler } from '../sessions/prompt.js';
import { PermissionEngine } from '../permissions/index.js';
import { AgentRequestHandler } from '../acp/agent-requests.js';
import { appendFeedback, readFeedback } from '../feedback/index.js';
import type { ContentBlock, McpServer as AcpMcpServer } from '../types/acp.js';

export async function createServer(configPath?: string) {
  const config = loadConfig(configPath);
  const registry = new RegistryManager(config);
  const lifecycle = new LifecycleManager(config, registry.getInstalled());
  const sessions = new SessionManager(config, lifecycle);
  const permissions = new PermissionEngine();
  const promptHandler = new PromptHandler(lifecycle, sessions, permissions, config);
  const agentRequests = new AgentRequestHandler();

  const server = new McpServer({ name: 'mcacp', version: '0.1.2' });

  permissions.setElicitationSender(async (message, schema) => {
    const result = await server.server.elicitInput({
      message,
      requestedSchema: schema as ElicitRequestFormParams['requestedSchema'],
    });
    return {
      action: result.action,
      content: result.content as Record<string, unknown> | undefined,
    };
  });

  // ---- Registry tools ----

  server.tool(
    'list_installed_agents',
    'List all locally installed ACP agents with their id, name, version, and description.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(registry.listInstalled(), null, 2) }],
    }),
  );

  server.tool(
    'registry_search',
    'Search configured ACP agent registries for available agents.',
    {
      query: z.string().optional().describe('Search string to match against name, description, authors'),
      showIncompatible: z.boolean().default(false).describe('Include platform-incompatible agents'),
    },
    async ({ query, showIncompatible }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await registry.search(query, showIncompatible), null, 2) }],
    }),
  );

  server.tool(
    'agent_install',
    'Install an ACP agent from the registry.',
    {
      agentId: z.string().describe('Registry ID of the agent'),
      version: z.string().optional().describe('Specific version (default: latest)'),
    },
    async ({ agentId, version }) => {
      const installed = await registry.install(agentId, version);
      lifecycle.updateInstalledAgents(registry.getInstalled());
      return { content: [{ type: 'text' as const, text: JSON.stringify(installed, null, 2) }] };
    },
  );

  server.tool(
    'agent_uninstall',
    'Remove a locally installed ACP agent.',
    { agentId: z.string().describe('ID of the agent to uninstall') },
    async ({ agentId }) => {
      registry.uninstall(agentId);
      lifecycle.updateInstalledAgents(registry.getInstalled());
      return { content: [{ type: 'text' as const, text: `Uninstalled ${agentId}` }] };
    },
  );

  server.tool(
    'agent_check_upgrades',
    'Check all installed agents for available version upgrades.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await registry.checkUpgrades(), null, 2) }],
    }),
  );

  server.tool(
    'discover_agents',
    'Scan editor configs (Zed settings.json, JetBrains acp.json) for ACP agents. Returns agents with command/args/env and source. To import, add them to agent_servers in your mcacp.json and call reload_config.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(discoverEditorAgents(), null, 2) }],
    }),
  );

  server.tool(
    'reload_config',
    'Reload configuration from disk. Use after editing mcacp.json to pick up new agent_servers entries or changed settings. Returns the new config.',
    {},
    async () => {
      const newConfig = loadConfig(configPath);
      // Propagate to all managers
      Object.assign(config, newConfig);
      lifecycle.updateInstalledAgents(registry.getInstalled());
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        agent_servers: Object.keys(newConfig.agent_servers),
        registries: newConfig.registries,
        defaultPermissionPolicy: newConfig.defaultPermissionPolicy,
        reloaded: true,
      }, null, 2) }] };
    },
  );

  // ---- Lifecycle tools ----

  server.tool(
    'initialize',
    'Spawn an ACP agent process and perform the initialize handshake. Must be called before creating sessions.',
    {
      agentId: z.string().describe('ID of the installed agent to initialize'),
      protocolVersion: z.number().optional().describe('Protocol version to negotiate'),
      clientInfo: z.object({
        name: z.string(), version: z.string(), title: z.string().optional(),
      }).optional().describe('Calling client info'),
      clientCapabilities: z.object({
        fs: z.object({
          readTextFile: z.boolean().optional(), writeTextFile: z.boolean().optional(),
        }).optional(),
        terminal: z.boolean().optional(),
      }).optional().describe('Client capabilities'),
      env: z.record(z.string()).optional().describe('Environment variable overrides. Merged on top of config/installed env.'),
    },
    async ({ agentId, protocolVersion, clientInfo, clientCapabilities, env }) => {
      const result = await lifecycle.initialize(agentId, protocolVersion, clientInfo, clientCapabilities, env);
      const handle = lifecycle.getAgent(agentId);
      handle.transport.setRequestHandler(async (method, params) => {
        if (method === 'session/request_permission') {
          throw new Error('Permission requests should be handled during prompt');
        }
        return agentRequests.dispatch(method, params);
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'shutdown',
    'Gracefully shut down a running ACP agent, closing all sessions.',
    { agentId: z.string().describe('ID of the agent to shut down') },
    async ({ agentId }) => {
      sessions.closeAllForAgent(agentId);
      promptHandler.onSessionRemoved();
      await lifecycle.shutdown(agentId);
      return { content: [{ type: 'text' as const, text: `Shut down ${agentId}` }] };
    },
  );

  // ---- Session tools ----

  server.tool(
    'new_session',
    "Create a new ACP session on an initialized agent. Returns the agent's session ID.",
    {
      agentId: z.string().describe('ID of the initialized agent'),
      cwd: z.string().describe('Working directory for the session'),
      mcpServers: z.array(z.union([
        z.object({ name: z.string(), command: z.string(), args: z.array(z.string()).optional() }),
        z.object({ type: z.literal('http'), name: z.string(), url: z.string() }),
      ])).optional().describe('MCP servers to make available to the agent'),
      permissionPolicy: z.enum(['elicit', 'allow_all', 'deny_all', 'operator']).optional()
        .describe('Permission policy: elicit, allow_all, deny_all, or operator'),
    },
    async ({ agentId, cwd, mcpServers, permissionPolicy }) => {
      const result = await sessions.newSession(agentId, cwd, mcpServers as AcpMcpServer[] | undefined, permissionPolicy);
      agentRequests.registerSession(result.sessionId, cwd);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'load_session',
    'Resume a previously created session. Agent must support session loading.',
    {
      agentId: z.string().describe('ID of the initialized agent'),
      sessionId: z.string().describe('Session ID to resume'),
      cwd: z.string().describe('Working directory'),
      mcpServers: z.array(z.union([
        z.object({ name: z.string(), command: z.string(), args: z.array(z.string()).optional() }),
        z.object({ type: z.literal('http'), name: z.string(), url: z.string() }),
      ])).optional(),
    },
    async ({ agentId, sessionId, cwd, mcpServers }) => {
      const result = await sessions.loadSession(agentId, sessionId, cwd, mcpServers as AcpMcpServer[] | undefined);
      agentRequests.registerSession(result.sessionId, cwd);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'list_sessions',
    'List stored sessions. Does not require the agent to be running.',
    { agentId: z.string().describe('Agent ID to list sessions for') },
    async ({ agentId }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(sessions.listSessions(agentId), null, 2) }],
    }),
  );

  server.tool(
    'close_session',
    'Close an active session. Session file preserved for future load_session.',
    { sessionId: z.string().describe('Session ID to close') },
    async ({ sessionId }) => {
      agentRequests.unregisterSession(sessionId);
      sessions.closeSession(sessionId);
      promptHandler.onSessionRemoved();
      return { content: [{ type: 'text' as const, text: `Closed session ${sessionId}` }] };
    },
  );

  // ---- Interaction tools ----

  server.tool(
    'prompt_polled',
    'Send a prompt to an active ACP session. Returns immediately with { status: "prompted" }. Use prompt_events to poll for events. Pair with prompt_events for the async pattern; use prompt_sync for the blocking pattern.',
    {
      sessionId: z.string().describe('Active session ID'),
      prompt: z.union([
        z.string(),
        z.array(z.union([
          z.object({ type: z.literal('text'), text: z.string() }),
          z.object({ type: z.literal('resource_link'), uri: z.string(), mimeType: z.string().optional() }),
        ])),
      ]).describe('Prompt text or content blocks'),
    },
    async ({ sessionId, prompt: p }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(
        promptHandler.promptPolled(sessionId, p as string | ContentBlock[]), null, 2,
      ) }],
    }),
  );

  server.tool(
    'prompt_events',
    'Non-blocking poll for prompt events. Returns all queued events (updates, permission requests, completion). May return empty array if no new events.',
    { sessionId: z.string().describe('Active session ID') },
    async ({ sessionId }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(
        promptHandler.promptEvents(sessionId), null, 2,
      ) }],
    }),
  );

  server.tool(
    'prompt_sync',
    'Send a prompt and block until it completes, errors, or a permission_request needs operator attention. Returns all collected events at once. Returns early (without a complete event) on permission_request or timeout. For the async pattern, use prompt_polled + prompt_events instead.',
    {
      sessionId: z.string().describe('Active session ID'),
      prompt: z.union([
        z.string(),
        z.array(z.union([
          z.object({ type: z.literal('text'), text: z.string() }),
          z.object({ type: z.literal('resource_link'), uri: z.string(), mimeType: z.string().optional() }),
        ])),
      ]).describe('Prompt text or content blocks'),
      timeoutMs: z.number().optional().describe('Max wait time in ms. Returns collected events on timeout (may be empty).'),
      includeThoughts: z.boolean().default(false).describe('Include non-tool, non-terminal updates (message chunks, thought chunks, plan, mode changes, etc.)'),
      includeTools: z.boolean().default(false).describe('Include tool_call and tool_call_update updates in returned events'),
    },
    async ({ sessionId, prompt: p, timeoutMs, includeThoughts, includeTools }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(
        await promptHandler.promptSync(sessionId, p as string | ContentBlock[], timeoutMs, includeThoughts, includeTools), null, 2,
      ) }],
    }),
  );

  server.tool(
    'events',
    'Block until any prompted session produces events. Returns events stamped with sessionId and agentId. Supports optional Nagle-style coalescing to batch events across sessions.',
    {
      timeoutMs: z.number().optional().describe('Max wait time in ms. Returns empty on timeout.'),
      nagleMs: z.number().optional().describe('Coalescing window in ms. Batches events arriving within this window. Default: 0 (immediate).'),
    },
    async ({ timeoutMs, nagleMs }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(
        await promptHandler.events(timeoutMs, nagleMs), null, 2,
      ) }],
    }),
  );

  server.tool(
    'grant_permission',
    'Respond to a pending permission request (operator policy). The agent resumes; new events flow to the queue.',
    {
      sessionId: z.string().describe('Session with pending permission'),
      toolCallId: z.string().describe('Tool call ID requesting permission'),
      optionId: z.string().describe('Permission option to select'),
    },
    async ({ sessionId, toolCallId, optionId }) => {
      promptHandler.grantPermission(sessionId, toolCallId, optionId);
      return { content: [{ type: 'text' as const, text: `Permission granted: ${optionId}` }] };
    },
  );

  server.tool(
    'request_permission',
    'Send an MCP elicitation to the outer host asking for a permission decision. Does not require a running agent or session.',
    {
      title: z.string().describe('Human-readable description of the action requesting permission'),
      options: z.array(z.object({
        optionId: z.string(),
        name: z.string(),
      })).optional().describe('Permission choices (defaults to Allow / Reject)'),
    },
    async ({ title, options }) => {
      const choices = options ?? [
        { optionId: 'allow', name: 'Allow' },
        { optionId: 'reject', name: 'Reject' },
      ];
      const result = await server.server.elicitInput({
        message: `Agent requests permission: ${title}`,
        requestedSchema: {
          type: 'object' as const,
          properties: {
            decision: {
              type: 'string' as const,
              title: 'Permission',
              description: `Agent wants to: ${title}`,
              enum: choices.map(o => o.optionId),
              enumNames: choices.map(o => o.name),
            },
          },
          required: ['decision'],
        } as ElicitRequestFormParams['requestedSchema'],
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        action: result.action,
        decision: result.content?.decision ?? null,
      }, null, 2) }] };
    },
  );

  server.tool(
    'cancel',
    'Cancel an in-progress prompt.',
    { sessionId: z.string().describe('Session to cancel') },
    async ({ sessionId }) => {
      promptHandler.cancel(sessionId);
      return { content: [{ type: 'text' as const, text: `Cancelled prompt on ${sessionId}` }] };
    },
  );

  server.tool(
    'set_mode',
    'Switch the operating mode of a session.',
    { sessionId: z.string().describe('Session ID'), modeId: z.string().describe('Mode to switch to') },
    async ({ sessionId, modeId }) => {
      await promptHandler.setMode(sessionId, modeId);
      return { content: [{ type: 'text' as const, text: `Switched to mode ${modeId}` }] };
    },
  );

  // ---- Status tools ----

  server.tool(
    'list_running_agents',
    'List all spawned ACP agent processes with status, heartbeat, and active sessions.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(lifecycle.getAllAgents().map(h => ({
        agentId: h.agentId, status: h.status.text, statusUpdatedAt: h.status.updatedAt,
        startedAt: h.startedAt, lastActivityAt: h.lastActivityAt,
        lastMessageAt: h.transport.lastMessageAt,
        activeSessions: Array.from(h.activeSessions),
        capabilities: h.capabilities, agentInfo: h.agentInfo,
      })), null, 2) }],
    }),
  );

  server.tool(
    'get_agent_status',
    'Get detailed status of a running ACP agent.',
    { agentId: z.string().describe('Agent to query') },
    async ({ agentId }) => {
      const h = lifecycle.getAgent(agentId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        agentId: h.agentId, status: h.status.text, statusUpdatedAt: h.status.updatedAt,
        startedAt: h.startedAt, lastActivityAt: h.lastActivityAt,
        lastMessageAt: h.transport.lastMessageAt, activeSessions: Array.from(h.activeSessions),
        protocolVersion: h.protocolVersion, capabilities: h.capabilities, agentInfo: h.agentInfo,
      }, null, 2) }] };
    },
  );

  server.tool(
    'set_agent_status',
    'Set an explicit status text for a running agent.',
    { agentId: z.string().describe('Agent ID'), status: z.string().describe('Status text') },
    async ({ agentId, status }) => {
      lifecycle.getAgent(agentId).status = { text: status, updatedAt: Date.now() };
      return { content: [{ type: 'text' as const, text: `Status set for ${agentId}: ${status}` }] };
    },
  );

  // ---- Feedback tools ----

  if (config.collectFeedback) {

  server.tool(
    'give_feedback',
    'Write structured feedback. Appends a timestamped markdown entry to the feedback file.',
    {
      message: z.string().describe('The feedback message'),
      category: z.enum(['bug', 'feature', 'improvement', 'question', 'other']).describe('Feedback category'),
      sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Feedback sentiment'),
      agentId: z.string().optional().describe('ID of the agent this feedback is about'),
      toolName: z.string().optional().describe('Name of the tool this feedback is about'),
      taskId: z.string().optional().describe('ID of the task this feedback is about'),
    },
    async ({ message, category, sentiment, agentId, toolName, taskId }) => {
      const timestamp = appendFeedback(config.feedbackFile, {
        message, category, sentiment, agentId, toolName, taskId,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ recorded: true, timestamp }, null, 2) }] };
    },
  );

  server.tool(
    'list_feedback',
    'Read all recorded feedback from the feedback markdown file.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: readFeedback(config.feedbackFile) }],
    }),
  );

  } // collectFeedback

  // ---- Resources ----

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const docsDir = resolve(__dirname, '../../docs');

  server.resource(
    'configuration-guide',
    'docs://configuration.md',
    { description: 'MCACP configuration guide — config file locations, schema, permission policies, and editor import' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: readFileSync(resolve(docsDir, 'configuration.md'), 'utf-8'),
      }],
    }),
  );

  return {
    server,
    async start() {
      const transport = new StdioServerTransport();
      transport.onerror = (error) => {
        if (error instanceof SyntaxError) {
          // Not JSON — framing-level problem, other side isn't speaking the protocol
          process.stderr.write(`[mcacp] Framing error: ${error.message}\n`);
        } else {
          // Valid JSON but not a valid JSON-RPC message
          process.stderr.write(`[mcacp] Invalid JSON-RPC message: ${error.message}\n`);
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error', data: error.message },
          }) + '\n');
        }
      };
      await server.connect(transport);
    },
  };
}
