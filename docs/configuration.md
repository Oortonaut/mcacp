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
  "sessionDir": "./sessions",
  "installDir": "./agents",
  "heartbeatTimeoutMs": 60000,
  "clientInfo": {
    "name": "mcacp",
    "version": "0.1.0",
    "title": "MCACP Bridge"
  }
}
```

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
Registry-installed agents are stored in `installDir` (default: `./agents/`).

## Permission Policies

| Policy | Behavior |
|--------|----------|
| `elicit` | Translates to MCP elicitation — asks the MCP client interactively |
| `allow_all` | Auto-approves all permission requests |
| `deny_all` | Auto-denies all permission requests |
| `operator` | Surfaces as `permission_request` events — the calling agent decides |

Set per-agent via `agent_servers[id].permissionPolicy` or globally via `defaultPermissionPolicy`.

## Session Storage

Sessions are persisted as JSON files in `sessionDir` (default: `./sessions/`).
One file per session at `{sessionDir}/{agentId}/{sessionId}.json`.
Sessions survive restarts and can be resumed with `load_session`.
