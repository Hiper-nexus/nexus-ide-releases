# Adding a New CLI Adapter

NexusIDE supports any AI CLI tool declaratively — no recompile needed. Drop a
JSON file into `~/.nexus/plugins/adapters/` and the app hot-reloads it within
seconds.

## Quick start: example adapter

Create `~/.nexus/plugins/adapters/kimi.json`:

```json
{
  "kind": "cli-pty",
  "id": "kimi",
  "label": "Kimi (MoonShot)",
  "version": "1.0.0",
  "icon": "🌙",
  "bin": "kimi",
  "detect": "kimi --version",
  "install": {
    "method": "npm",
    "command": "npm install -g @moonshot-ai/kimi-cli"
  },
  "auth": {
    "method": "api_key",
    "envVarFallback": "MOONSHOT_API_KEY",
    "credentialStore": "env",
    "loginHint": "Set MOONSHOT_API_KEY in your environment."
  },
  "spawn": {
    "interactive": ["kimi"],
    "headless": ["kimi", "--message", "{{PROMPT}}"],
    "ptyRequired": true,
    "resumeArgs": [],
    "extraArgs": []
  },
  "env": {
    "static": {},
    "passthrough": ["MOONSHOT_API_KEY"],
    "ephemeralHome": false
  },
  "models": {
    "flag": "--model",
    "list": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    "default": "moonshot-v1-8k"
  },
  "promptInjection": {
    "method": "arg",
    "trailingNewline": false,
    "bracketedPaste": false
  },
  "stateParsing": {
    "idle": { "type": "timeout", "ms": 800 },
    "shellIntegration": false,
    "exitCodes": { "0": "ok", "1": "error" }
  },
  "quirks": {
    "altScreen": true,
    "requiresNoAutoUpdate": false,
    "mcpAutoload": false
  }
}
```

Save the file. NexusIDE detects it instantly via `fs.watch`. Click **+ Agent**
in the top bar to see "🌙 Kimi" appear in the adapter picker.

## Field reference

### Top-level

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"cli-pty"` | Spawns a real PTY (interactive TUI agent). |
| `id` | `string` (kebab-case) | Unique adapter id. Overrides builtin with same id. |
| `label` | `string` | Human-readable name shown in the UI. |
| `version` | `string` | Semver string. |
| `icon` | `string` | Single emoji shown before the label. |
| `bin` | `string` | The binary name (`claude`, `aider`, …). |
| `detect` | `string` | Command to check if CLI is installed (e.g. `"claude --version"`). |

### `install`

```json
{ "method": "npm", "command": "npm install -g my-cli" }
```

Methods: `brew`, `npm`, `pip`, `cargo`, `manual`.

### `auth`

```json
{
  "method": "api_key",
  "envVarFallback": "MY_API_KEY",
  "credentialStore": "env",
  "loginHint": "Set MY_API_KEY in your environment."
}
```

Auth methods: `oauth`, `api_key`, `device_code`, `subscription`, `none`.

### `spawn`

```json
{
  "interactive": ["mycli", "--model", "{{MODEL}}"],
  "headless": ["mycli", "--message", "{{PROMPT}}"],
  "ptyRequired": true,
  "resumeArgs": ["--resume"],
  "extraArgs": []
}
```

Supported placeholders: `{{MODEL}}`, `{{PROMPT}}`, `{{CWD}}`, `{{SESSION_ID}}`.

### `env`

```json
{
  "static": { "MY_FLAG": "1" },
  "passthrough": ["MY_API_KEY", "MY_BASE_URL"],
  "ephemeralHome": false
}
```

`passthrough` lists env vars from the **main process** to forward into **this
adapter's PTY only**. They never leak to plain shell panes. Only pass vars the
CLI genuinely needs.

### `models`

```json
{ "flag": "--model", "list": ["model-a", "model-b"], "default": "model-a" }
```

The user picks from `list` in the agent launcher dialog. The selected value
replaces `{{MODEL}}` in the spawn args.

### `stateParsing`

Use `"timeout"` for CLIs that use alt-screen TUIs (idle is assumed after N ms
of no output):

```json
{ "type": "timeout", "ms": 800 }
```

Use `"regex"` for line-mode CLIs where a stable prompt appears at idle:

```json
{ "type": "regex", "pattern": "^aider>" }
```

### `quirks`

| Field | Default | Description |
|-------|---------|-------------|
| `altScreen` | `false` | CLI uses the alternate screen buffer (full-screen TUI). |
| `requiresNoAutoUpdate` | `false` | Pass an `--no-auto-update` flag (e.g. grok). |
| `approvalFlag` | — | Flag for disabling interactive approval prompts. |
| `mcpAutoload` | `false` | CLI auto-connects to the NexusIDE MCP server. |

## Overriding a builtin adapter

User adapters with the same `id` as a builtin silently replace it. To tweak
Claude's model list without touching the app source, create:

`~/.nexus/plugins/adapters/claude.json`
```json
{
  "kind": "cli-pty",
  "id": "claude",
  "...": "copy all fields from builtin, change what you need"
}
```

## How hot-reload works

NexusIDE calls `fs.watch` on `~/.nexus/plugins/adapters/` at startup. Any
file change triggers a re-scan and re-validation. Invalid JSON or schema errors
are logged to the Electron console and the bad file is silently skipped. Valid
adapters immediately appear in the `+ Agent` picker without restarting the app.

## Security notes

- Adapters are **declarative only** — they specify argv arrays and env var
  names, they cannot execute arbitrary code.
- `env.passthrough` vars are injected **only** into that adapter's PTY. Plain
  shell panes never see them.
- Schema validation runs at load time; any adapter that fails Zod validation
  is rejected with a console error.
