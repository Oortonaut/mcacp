# MCACP

**Bridge any MCP client to any ACP coding agent.**

MCACP is an [MCP](https://modelcontextprotocol.io/) server that speaks the [Agent Client Protocol](https://agentclientprotocol.com/) on behalf of your MCP host. It lets Claude Code, Zed, VS Code, or any MCP-compatible client spawn, manage, and interact with ACP coding agents — turning a single chat window into a multi-agent control plane.

```
MCP Client (Claude Code, Zed, VS Code, ...)
    |
    |  MCP (stdio)
    v
  MCACP
    |
    |  ACP (stdio, per agent)
    v
 Claude Code  ·  Gemini CLI  ·  Codex  ·  Auggie  ·  Copilot  ·  ...
```

## What can you do with this?

**Run any ACP agent from any MCP client.** You don't need a dedicated IDE plugin for each agent. Install Gemini from Claude Code. Run Codex from Zed. Mix and match.

**Compare agents side by side.** Give the same task to Claude Code ACP and Gemini CLI in parallel sessions and compare the results.

**Build agent-driven pipelines.** One agent writes code, another reviews it, a third runs the tests. MCACP handles the lifecycle and permission flow for all of them.

**Control permissions interactively.** On hosts that support MCP elicitation (Zed), permission requests pop up as interactive forms. On hosts that don't (Claude Code), they fall back to operator mode where the host agent decides.

**Resume where you left off.** Sessions persist to disk. Shut down, restart, `load_session` — the agent picks up where it stopped.

**Discover and install agents from chat.** Browse the ACP registry, install agents, check for upgrades — without leaving your conversation.

## Quick start

### Install

```bash
npm install -g mcacp
```

Or run directly:

```bash
npx mcacp
```

### Add to your MCP client

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "mcacp": {
      "command": "npx",
      "args": ["-y", "mcacp"]
    }
  }
}
```

**Zed** (`settings.json`):
```json
{
  "context_servers": {
    "mcacp": {
      "command": { "path": "npx", "args": ["-y", "mcacp"] }
    }
  }
}
```

Then from chat:

```
"Search for available agents"        →  registry_search
"Install the Gemini agent"           →  agent_install
"Initialize it and start a session"  →  initialize + new_session
"Ask it to refactor auth"            →  prompt_start + prompt
```

## MCP tools

MCACP exposes 22 tools organized into five groups.

### Registry

| Tool | Description |
|------|-------------|
| `list_installed_agents` | List locally installed agents |
| `registry_search` | Search the ACP agent registry |
| `agent_install` | Install an agent from the registry |
| `agent_uninstall` | Remove an installed agent |
| `agent_check_upgrades` | Check for available upgrades |
| `discover_agents` | Scan editor configs (Zed, JetBrains) for agents |
| `reload_config` | Reload `mcacp.json` from disk |

### Lifecycle

| Tool | Description |
|------|-------------|
| `initialize` | Spawn an agent process and perform the ACP handshake |
| `shutdown` | Gracefully shut down an agent |

### Sessions

| Tool | Description |
|------|-------------|
| `new_session` | Create a session with working directory and permission policy |
| `load_session` | Resume a persisted session |
| `list_sessions` | List stored sessions for an agent |
| `close_session` | Close a session (preserved for later resume) |

### Interaction

| Tool | Description |
|------|-------------|
| `prompt_start` | Send a prompt (returns immediately) |
| `prompt` | Block until events are available |
| `prompt_events` | Non-blocking poll for events |
| `grant_permission` | Resolve a pending permission request (operator mode) |
| `request_permission` | Send an MCP elicitation to the host for a permission decision |
| `cancel` | Cancel an in-progress prompt |
| `set_mode` | Switch agent operating mode |

### Status

| Tool | Description |
|------|-------------|
| `list_running_agents` | List all agents with status and sessions |
| `get_agent_status` | Detailed status of a running agent |
| `set_agent_status` | Set status text for an agent |

## Permission policies

Each session can use a different policy:

| Policy | Behavior |
|--------|----------|
| `allow_all` | Auto-approve all agent actions |
| `deny_all` | Block all tool use |
| `elicit` | Forward as MCP elicitations to the host; falls back to `operator` if unsupported |
| `operator` | Queue as events — the host agent decides via `grant_permission` |

### Operator flow

```
Orchestrator                   MCACP                      ACP Agent
    |                            |                            |
    |-- prompt(sessionId, ...) ->|                            |
    |                            |-- session/prompt --------->|
    |                            |<- request_permission ------|
    |<- {pendingPermission: ...} |                            |
    |                            |                            |
    |-- grant_permission ------->|                            |
    |   {toolCallId, optionId}   |-- permission outcome ----->|
    |                            |<- prompt result -----------|
    |<- {stopReason, updates}    |                            |
```

## Configuration

MCACP looks for `mcacp.json` in these locations (first found wins):

1. `--config` flag or `MCACP_CONFIG` env var
2. `.mcacp/mcacp.json` in the current directory
3. `~/.config/mcacp/mcacp.json`

```jsonc
{
  "registries": ["https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"],
  "defaultPermissionPolicy": "elicit",
  "agent_servers": {
    "my-custom-agent": {
      "command": "node",
      "args": ["my-agent.js"]
    }
  }
}
```

See [docs/configuration.md](docs/configuration.md) for the full schema.

## Building from source

```bash
git clone https://github.com/Oortonaut/mcacp.git
cd mcacp
npm install
npm run build
node dist/index.js
```

## License

[Apache-2.0](LICENSE)
