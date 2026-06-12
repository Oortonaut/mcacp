# MCACP Configuration Guide

## Config File Locations

MCACP loads config from multiple scopes, merged in priority order (highest wins):

| Scope | Locations | Use for |
|-------|-----------|---------|
| **Host** | `/etc/mcacp/config.json` (Linux/Mac), `%PROGRAMDATA%/mcacp/config.json` (Windows) | System-wide defaults |
| **Project** | `./mcacp.json`, `./.mcacprc.json` | Project-specific agent settings |
| **User** | `~/.config/mcacp/config.json` (Linux/Mac), `%APPDATA%/mcacp/config.json` (Windows), `~/mcacp.json` | Personal agent configs |
| **Explicit** | `--config /path/to/file` | Override everything |

All scopes accept `mcacp.json`, `.mcacprc.json`, or `config.json`. Config files merge:
`agent_servers` entries combine across scopes (user overrides project overrides host).
All other fields use the highest-priority value.

## Config Schema

```json
{
  "agent_servers": {
    "my-agent": {
      "command": "/path/to/agent",
      "args": ["acp"],
      "env": { "API_KEY": "sk-..." },
      "autoReapMs": 300000,
      "permissionPolicy": "operator"
    }
  },
  "registries": [
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
  ],
  "defaultAutoReapMs": 300000,
  "defaultPermissionPolicy": "elicit",
  "sessionDir": "./.mcacp",
  "installDir": "./.mcacp/agents",
  "promptConsolidateMs": 5000,
  "promptTimeoutMs": 0,
  "heartbeatTimeoutMs": 60000,
  "clientInfo": {
    "name": "mcacp",
    "version": "0.1.0",
    "title": "MCACP Bridge"
  }
}
```

**Note:** `cwd` is not a config-level field — it's set per-session via `new_session` / `load_session`.

## agent_servers

The `agent_servers` key matches the Zed and JetBrains ACP config format:

```json
{
  "agent_servers": {
    "Display Name": {
      "command": "executable",
      "args": ["arg1", "arg2"],
      "env": { "KEY": "value" }
    }
  }
}
```

**Core fields** (same as Zed/JetBrains):
- `command` (string) — executable to launch
- `args` (string[]) — command-line arguments
- `env` (object) — environment variables

**MCACP extensions** (optional):
- `autoReapMs` (number) — auto-shutdown after inactivity (ms). 0 = disabled.
- `permissionPolicy` (`elicit` | `allow_all` | `deny_all` | `operator`) — per-agent default
- `installPath` (string) — custom binary install location

## Registering Local Agents

To add a local or custom ACP agent, add it to `agent_servers` in your config:

```json
{
  "agent_servers": {
    "my-private-agent": {
      "command": "npx",
      "args": ["-y", "@myorg/agent@latest"],
      "env": { "AGENT_TOKEN": "..." }
    },
    "goose": {
      "command": "goose",
      "args": ["acp"]
    }
  }
}
```

Then call `reload_config` to pick up changes without restarting.

## Importing from Editors

Use the `discover_agents` tool to scan for agents configured in:

- **Zed**: `~/.config/zed/settings.json` → `agent_servers`
- **JetBrains**: `~/.jetbrains/acp.json` → `agent_servers`

The tool returns discovered agents with `command`, `args`, `env`, and `source`.
Copy the entries you want into your `mcacp.json` `agent_servers` and call `reload_config`.

### Zed config location
- Linux/Mac: `~/.config/zed/settings.json`
- Windows: `%APPDATA%/Zed/settings.json`

### JetBrains config location
- All platforms: `~/.jetbrains/acp.json`

## Registry

Configured via `registries` array. Default:
```
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

Use `registry_search` to browse, `agent_install` to install from registry.
Registry-installed agents are stored in `installDir` (default: `./.mcacp/agents/`).

## Interaction Patterns

MCACP exposes two patterns for sending prompts and consuming results:

### Synchronous: `prompt_sync`

A single blocking call that sends the prompt and waits for the full response.

```
prompt_sync(sessionId, prompt, timeoutMs?, includeThoughts?, includeTools?)
```

Returns all collected events once the prompt completes, errors, or a `permission_request`
arrives (operator policy). The `includeThoughts` and `includeTools` flags control which
intermediate events are returned:

| Flag | Default | Includes |
|------|---------|----------|
| `includeThoughts` | `false` | All non-tool, non-terminal updates: message chunks, thought chunks, plan entries, mode changes |
| `includeTools` | `false` | `tool_call` and `tool_call_update` events |

Terminal events (`complete`, `error`) and `permission_request` events are always returned.

**Early return conditions:**
- **`permission_request`** — the caller must handle it via `grant_permission`, then call `prompt_sync` again to continue.
- **Timeout** — returns whatever events have been collected (may be empty).

### Asynchronous: `prompt_polled` + `prompt_events`

Fire-and-forget start, then poll for events at your own pace.

```
prompt_polled(sessionId, prompt)   → { status: "prompted" }
prompt_events(sessionId)           → { events: [...] }
```

Use `events(timeoutMs?, nagleMs?)` to block across all prompted sessions simultaneously.

## Permission Policies

| Policy | Behavior |
|--------|----------|
| `elicit` | Translates to MCP elicitation — asks the MCP client interactively |
| `allow_all` | Auto-approves all permission requests |
| `deny_all` | Auto-denies all permission requests |
| `operator` | Surfaces as `permission_request` events — the calling agent decides |

Set per-agent via `agent_servers[id].permissionPolicy` or globally via `defaultPermissionPolicy`.

**Note on operator policy with `prompt_sync`:** Since the caller is blocked waiting for completion,
a `permission_request` causes `prompt_sync` to return early so the caller can respond via
`grant_permission` and then resume with another `prompt_sync` call. The `elicit`, `allow_all`, and
`deny_all` policies are handled internally and do not cause early returns.

## Event Consolidation

MCACP uses Nagle-style batching for text chunk events (`agent_message_chunk`, `agent_thought_chunk`).
Instead of forwarding every individual chunk, text is accumulated and flushed as consolidated batches.

Flush triggers:
- The accumulated text contains a newline
- The consolidation timeout expires
- A non-chunk event arrives (tool_call, complete, error, permission_request)

Configure via `promptConsolidateMs` (default: `5000`ms). Set to `0` to disable consolidation and push every chunk immediately.

## Prompt Timeout

`promptTimeoutMs` (default: `0`) bounds how long an in-flight `session/prompt` may run before MCACP gives up on it.

A `session/prompt` is long-running by nature — it stays open for the entire duration of the agent's work, which for a large refactor or build can be many minutes. The default of `0` means **unlimited**: the prompt is bounded only by the agent's own response, an explicit `cancel`, or the agent process exiting.

Set a non-zero value only if you want a hard ceiling. When the timeout fires, MCACP sends `session/cancel` to the agent (so it doesn't keep running an orphaned task) and emits an `error` event for the prompt. Setting this too low is the classic cause of "the agent times out on long tasks and then stalls on retry" — the underlying request is killed while the agent is still busy, and the next prompt queues behind work that never completes.

> Note: this is distinct from the per-call `timeoutMs` argument on `promptSync` / `prompt_events` / `events`, which only controls how long *your* call waits for events — it never cancels the underlying prompt.

## Session Storage

Sessions are persisted as JSON files under `sessionDir` (default: `./.mcacp`).
Each agent gets its own subdirectory with a `sessions` folder:

```
.mcacp/<agent-name>/sessions/<sessionId>.json
```

For example, an agent named `my-agent` with session `abc123` would be stored at:
```
.mcacp/my-agent/sessions/abc123.json
```

Installed agent binaries live in `.mcacp/agents/`.
Sessions survive restarts and can be resumed with `load_session`.
