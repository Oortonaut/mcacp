# MCACP -- MCP-to-ACP Bridge

MCACP is an MCP server that lets any MCP-capable agent (Claude, Cursor, Windsurf, etc.) orchestrate [ACP](https://agentclientprotocol.com/) coding agents as sub-agents. It exposes 18 MCP tools that map one-to-one onto the ACP lifecycle: searching registries, installing agents, spawning and initializing agent processes, managing sessions, sending prompts, handling permissions, and monitoring status. The bridge spawns each ACP agent as a child process, communicates over JSON-RPC 2.0 on stdio, and provides the agent with filesystem and terminal capabilities on the host machine.

## Quick Start

### Prerequisites

- Node.js >= 20

### Install

```bash
npm install
npm run build
```

### Run as an MCP server (stdio)

Add MCACP to your MCP client configuration. For example, in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcacp": {
      "command": "node",
      "args": ["path/to/mcacp/dist/index.js"]
    }
  }
}
```

Or run directly during development:

```bash
npm run dev
```

### Minimal configuration

Create `mcacp.json` in the working directory (or your home directory):

```json
{
  "registries": [
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
  ],
  "defaultPermissionPolicy": "operator",
  "installDir": "./agents",
  "sessionDir": "./sessions"
}
```

All fields are optional. MCACP ships with sensible defaults and will run with an empty config or no config file at all.

## Configuration

MCACP looks for configuration in this order:

1. Explicit path passed programmatically to `createServer(path)`
2. `mcacp.json` or `.mcacprc.json` in the current working directory
3. `mcacp.json` or `.mcacprc.json` in the user's home directory
4. Built-in defaults (no file required)

### Full schema

```jsonc
{
  // URLs to fetch agent registry listings from.
  // Default: ["https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"]
  "registries": ["https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"],

  // Per-agent configuration overrides, keyed by agent ID.
  "agents": {
    "vendor/my-agent": {
      "autoReapMs": 600000,          // Inactivity timeout before auto-shutdown (0 = disabled). Default: 300000
      "permissionPolicy": "allow_all", // Per-agent default. Default: "elicit"
      "installPath": "/custom/path",  // Override install location
      "command": "my-agent-binary",    // Override launch command (skips registry lookup)
      "args": ["--flag"],              // Override command arguments
      "env": { "KEY": "value" }        // Additional environment variables
    }
  },

  // Default inactivity timeout (ms) before idle agents are auto-reaped.
  // Default: 300000 (5 minutes). Set to 0 to disable.
  "defaultAutoReapMs": 300000,

  // Default permission policy for new sessions.
  // One of: "elicit", "allow_all", "deny_all", "operator"
  // Default: "elicit"
  "defaultPermissionPolicy": "elicit",

  // Directory for session persistence files.
  // Default: "./sessions"
  "sessionDir": "./sessions",

  // Directory for installed agent binaries and metadata.
  // Default: "./agents"
  "installDir": "./agents",

  // Agent considered unresponsive after this many ms without a message.
  // Default: 60000 (1 minute)
  "heartbeatTimeoutMs": 60000,

  // Client identity sent to agents during the ACP initialize handshake.
  "clientInfo": {
    "name": "mcacp",            // Default: "mcacp"
    "version": "0.1.0",         // Default: "0.1.0"
    "title": "MCACP Bridge"     // Default: "MCACP Bridge"
  }
}
```

## Tools Reference

MCACP exposes 18 MCP tools, organized into five categories.

### Registry (5 tools)

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_installed_agents` | List all locally installed ACP agents with id, name, version, and description. | _(none)_ |
| `registry_search` | Search configured registries for available agents. | `query?` string, `showIncompatible?` boolean (default `false`) |
| `agent_install` | Install an agent from the registry. | `agentId` string, `version?` string |
| `agent_uninstall` | Remove a locally installed agent. | `agentId` string |
| `agent_check_upgrades` | Check all installed agents for available version upgrades. | _(none)_ |

### Lifecycle (2 tools)

| Tool | Description | Parameters |
|------|-------------|------------|
| `initialize` | Spawn an agent process and perform the ACP initialize handshake. Must be called before creating sessions. | `agentId` string, `protocolVersion?` number, `clientInfo?` `{name, version, title?}`, `clientCapabilities?` `{fs?: {readTextFile?, writeTextFile?}, terminal?}` |
| `shutdown` | Gracefully shut down a running agent, closing all its sessions. | `agentId` string |

### Session (4 tools)

| Tool | Description | Parameters |
|------|-------------|------------|
| `new_session` | Create a new ACP session on an initialized agent. Returns the session ID. | `agentId` string, `cwd` string, `mcpServers?` McpServerConfig[], `permissionPolicy?` enum |
| `load_session` | Resume a previously created session. Agent must support session loading. | `agentId` string, `sessionId` string, `cwd` string, `mcpServers?` McpServerConfig[] |
| `list_sessions` | List stored sessions. Does not require the agent to be running. | `agentId?` string |
| `close_session` | Close an active session. Session file preserved for future `load_session`. | `sessionId` string |

**McpServerConfig** is one of:

```jsonc
// stdio transport
{ "name": "server-name", "command": "cmd", "args": ["..."] }

// HTTP transport
{ "type": "http", "name": "server-name", "url": "https://..." }
```

### Interaction (4 tools)

| Tool | Description | Parameters |
|------|-------------|------------|
| `prompt` | Send a prompt to an active session. Blocks until completion or pending permission (operator policy). Returns `{stopReason, updates, pendingPermission?}`. | `sessionId` string, `prompt` string \| ContentBlock[] |
| `grant_permission` | Respond to a pending permission request (operator policy). Resumes the agent. | `sessionId` string, `toolCallId` string, `optionId` string |
| `cancel` | Cancel an in-progress prompt. | `sessionId` string |
| `set_mode` | Switch the operating mode of a session (agent-defined modes). | `sessionId` string, `modeId` string |

**ContentBlock** is one of:

```jsonc
{ "type": "text", "text": "..." }
{ "type": "resource_link", "uri": "file:///...", "mimeType?": "text/plain" }
```

### Status (3 tools)

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_running_agents` | List all spawned agent processes with status, heartbeat, and active sessions. | _(none)_ |
| `get_agent_status` | Get detailed status of a running agent including protocol version and capabilities. | `agentId` string |
| `set_agent_status` | Set an explicit status text for a running agent (for operator-level monitoring). | `agentId` string, `status` string |

## Permission Policies

Each session is created with a permission policy that controls how the bridge responds when an ACP agent requests permission to perform a sensitive action (e.g., writing a file, running a command).

### `allow_all`

Every permission request is automatically approved. The bridge selects the first `allow_once` or `allow_always` option. Suitable for trusted agents in sandboxed environments.

### `deny_all`

Every permission request is automatically denied. The bridge selects the first `reject_once` or `reject_always` option. Useful for read-only or audit scenarios.

### `elicit`

Permission requests are forwarded to the MCP client as elicitation prompts (if the client supports MCP elicitation). The user sees the agent's request and chooses an option interactively. Falls back to `allow_all` if the client does not support elicitation.

### `operator`

Permission requests are surfaced as structured data in the `prompt` tool's return value. The orchestrating agent (or automation layer) inspects the `pendingPermission` field and calls `grant_permission` to approve or deny. This is the recommended policy for agent-to-agent orchestration.

**Operator flow:**

```
Orchestrator                   MCACP                      ACP Agent
    |                            |                            |
    |-- prompt(sessionId, ...) ->|                            |
    |                            |-- session/prompt --------->|
    |                            |                            |
    |                            |<- request_permission ------|
    |                            |   {toolCallId, options}    |
    |                            |                            |
    |<- {pendingPermission: ...} |        (prompt blocks)     |
    |                            |                            |
    |-- grant_permission ------->|                            |
    |   {toolCallId, optionId}   |-- permission outcome ----->|
    |                            |                            |
    |                            |<- prompt result ----------|
    |<- {stopReason, updates}    |                            |
```

## Architecture

```
src/
  index.ts                 Entry point -- creates server and connects stdio transport
  server/index.ts          MCP server -- registers all 18 tools, wires managers together
  config/index.ts          Config loader -- searches cwd/home for mcacp.json, validates with Zod
  types/
    acp.ts                 Full ACP protocol type definitions (JSON-RPC, sessions, content, permissions)
    config.ts              Zod schemas for McacpConfig and AgentConfig
    tools.ts               Zod input schemas and ToolDefinition records for all 18 tools
  registry/index.ts        RegistryManager -- fetches remote registries, installs/uninstalls agents
  acp/
    transport.ts           AcpTransport -- spawns child process, JSON-RPC 2.0 over stdio
    lifecycle.ts           LifecycleManager -- initialize/shutdown agents, auto-reap on inactivity
    agent-requests.ts      AgentRequestHandler -- handles fs/ and terminal/ requests from agents
    status.ts              StatusTracker -- computes agent health, updates status from session events
  sessions/
    index.ts               SessionManager -- create/load/close sessions, persist to disk
    prompt.ts              PromptHandler -- sends prompts, collects updates, routes permissions
  permissions/index.ts     PermissionEngine -- implements all 4 permission policies
```

**Module wiring:**

```
MCP Client (Claude, Cursor, ...)
       |  stdio
       v
  [McpServer]  -- 18 tools registered
       |
       +---> RegistryManager     (registry_search, agent_install, ...)
       +---> LifecycleManager    (initialize, shutdown, list_running_agents, ...)
       |        +---> AcpTransport  (JSON-RPC 2.0 over child-process stdio)
       +---> SessionManager      (new_session, load_session, close_session, ...)
       +---> PromptHandler       (prompt, grant_permission, cancel, set_mode)
       +---> PermissionEngine    (policy dispatch for allow_all/deny_all/elicit/operator)
       +---> AgentRequestHandler (fs/read_text_file, fs/write_text_file, terminal/*)
```

The `AcpTransport` spawns each agent as a child process and speaks line-delimited JSON-RPC 2.0 over stdin/stdout. Incoming JSON-RPC requests from the agent (filesystem reads/writes, terminal commands, permission requests) are dispatched through `AgentRequestHandler` and `PermissionEngine` respectively.

## Example Workflow

A complete orchestration flow from an MCP client:

```
1. registry_search { query: "claude" }
   -> Returns list of available agents matching "claude"

2. agent_install { agentId: "anthropic/claude-code" }
   -> Downloads and registers the agent locally

3. initialize { agentId: "anthropic/claude-code" }
   -> Spawns the agent process, performs ACP handshake
   -> Returns { protocolVersion, agentCapabilities, agentInfo }

4. new_session {
     agentId: "anthropic/claude-code",
     cwd: "/home/user/my-project",
     permissionPolicy: "operator"
   }
   -> Returns { sessionId: "sess_abc123" }

5. prompt {
     sessionId: "sess_abc123",
     prompt: "Add input validation to the signup form"
   }
   -> Agent works, may return pendingPermission if it needs to write files
   -> Returns { stopReason: "end_turn", updates: [...], pendingPermission?: {...} }

6. (if pendingPermission returned)
   grant_permission {
     sessionId: "sess_abc123",
     toolCallId: "tc_xyz",
     optionId: "allow_once"
   }
   -> Agent resumes and completes the task

7. close_session { sessionId: "sess_abc123" }
   -> Session file preserved for later reload

8. shutdown { agentId: "anthropic/claude-code" }
   -> Agent process terminated
```

## License

MIT
