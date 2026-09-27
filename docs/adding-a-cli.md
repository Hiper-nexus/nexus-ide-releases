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
  "label": "Kimi",
  "version": "1.0.0",
  "icon": "🌙",
  "bin": "kimi",
  "detect": "kimi --version",
  "install": {
    "method": "npm",
    "command": "npm install -g @moonshot-ai/kimi-code"
  },
  "auth": {
    "method": "api_key",
    "envVarFallback": "KIMI_MODEL_API_KEY",
    "credentialStore": "keychain",
    "loginHint": "Run `kimi login` for OAuth, or save a Moonshot API key in Nexus."
  },
  "spawn": {
    "interactive": ["kimi"],
    "headless": ["kimi", "-p", "{{PROMPT}}"],
    "ptyRequired": true,
    "resumeArgs": ["--continue"],
    "resumeIdArgs": ["--session"],
    "extraArgs": []
  },
  "env": {
    "static": {},
    "passthrough": ["KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY"],
    "ephemeralHome": false
  },
  "models": {
    "flag": "--model",
    "list": ["kimi-code/kimi-for-coding", "kimi-k2.7", "kimi-k2.6"],
    "default": "kimi-code/kimi-for-coding"
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
    "mcpAutoload": false,
    "nexusMcp": "kimi"
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

Methods: `brew`, `npm`, `pip`, `uv`, `cargo`, `manual`.

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
| `mcpAutoload` | `false` | Legacy/autoload path: Nexus passes its MCP config directly to the CLI. |
| `nexusMcp` | `none` | Per-session integration: `autoload`, `codex`, `agy`, `opencode`, `kimi`, `grok`, or `none`. `autoload` requires `mcpAutoload:true`. |

Existing custom adapters that declare only `mcpAutoload:true` remain
orchestrator-capable. New adapters should also declare the matching
`nexusMcp` value; inconsistent `nexusMcp:"autoload"` configurations are
rejected instead of being advertised without a working injection path.

The builtin Aider adapter intentionally uses `nexusMcp:"none"`: current Aider
does not expose an official MCP client integration. It remains usable as a
terminal/worker CLI, but is not advertised as a Nexus MCP orchestrator.

### OpenClaude (`openclaude`) notes

- **Package:** `@gitlawb/openclaude` (bin `openclaude`). Community Claude Code
  fork — config and credentials live in `~/.openclaude`, not `~/.claude`.
- **Install:** `npm install -g @gitlawb/openclaude@latest`.
- **Auth:** `openclaude auth login`, or `/provider` for OpenAI / OpenRouter /
  Ollama / GitHub Models. Env: `OPENAI_API_KEY`, `CLAUDE_CODE_USE_OPENAI=1`.
- **Headless:** `openclaude -p "{{PROMPT}}"`. Resume: `--continue` / `--resume`.
- **MCP:** `--mcp-config` like Claude. Nexus injects on the **real HOME** —
  never a Claude-layout ephemeral overlay (that would drop `~/.openclaude` auth).
- **Not** a verified Maestro. Worker / experimental MCP only until the
  read-only confinement probe exists for this binary.

### Kimi Code (`kimi`) notes

- **Package:** `@moonshot-ai/kimi-code` (bin `kimi`). Legacy
  [kimi-cli](https://github.com/MoonshotAI/kimi-cli) is winding down; use
  `kimi migrate` if upgrading from the old install.
- **Headless:** `kimi -y --output-format text -p "{{PROMPT}}"` — current
  Kimi Code has no `--print`/`--quiet` flags (those appear only in older
  kimi-cli docs). `-p` is already non-interactive; `-y` auto-approves tools
  so eval/workers do not hang on confirmations.
- **Interactive yolo:** `-y` / `--yolo`.
- **Resume:** `--continue` (latest in cwd), `--session` / `-S` (id or picker).
- **Do not** pass `--add-dir` by default — that expands FS beyond the Nexus
  checkout isolation.
- Analysis: `docs/analysis/2026-07-18-analise-senior-kimi-cli-vs-nexus.md`.

### MiniMax Code (`minimax-code`) notes

- **Package:** `@minimax-ai/code` (bin `mcode`), Node 22.19+ or 24–26.
- **Install:** `npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3 --registry=https://registry.npmjs.org/`.
  npm 12 blocks install scripts by default and the CLI needs the native
  `better-sqlite3`. Update with `mcode update`.
- **Auth:** `mcode login --region global` (or `--region cn`), or the CLI's own
  key via `mcode provider set-minimax-key`. Data dir `~/.minimax`
  (`MINIMAX_DATA_DIR` overrides it).
- **Interactive:** `mcode [-m provider/model] -- "<prompt>"`. No permission or
  effort flag in the TUI — both come from `~/.minimax/config.yaml`.
- **Headless:** `mcode exec --output-format text --model {{MODEL}} -- {{PROMPT}}`
  (`--permission smart|full|off`, `--effort`, `--timeout` also exist).
- **Resume:** `--session <id>` only; `--continue` would pick another pane's
  latest session in the same folder.
- **MCP:** worker-only in a PTY (`nexusMcp: none`). The Nexus MCP reaches it
  through the ACP preset (`mcode acp`).

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

## Model catalog (new models / free→paid without a release)

Besides adapter JSON, Nexus merges a **model catalog** that can add model ids
and mark availability/cost (`free` | `cheap` | `paid` | `api-only` | `deprecated`,
plus `costTier`). Sources, in order:

1. Bundled defaults in `src/main/adapters/model-catalog.ts`
2. Local overlay: `~/.nexus/model-catalog.json` (hot-reloaded)
3. Startup refresh → writes that local file from URL / path / bundled published JSON

**Publishable source of truth:** `resources/model-catalog.json`  
**Publish lane:** branch `catalog` (JSON only).

Default URL (GitHub raw — works when the repo is public or the machine has auth):

```
https://raw.githubusercontent.com/cleofasvolarehost/nexus-ide/catalog/resources/model-catalog.json
```

If that URL 404s (private repo), Nexus falls back to the same JSON **bundled**
from `resources/model-catalog.json` and seeds `~/.nexus/model-catalog.json`.

Override (HTTPS, `file://`, or absolute path):

```bash
# Remote
export NEXUS_MODEL_CATALOG_URL='https://example.com/model-catalog.json'

# Local file (dev / this machine)
export NEXUS_MODEL_CATALOG_URL="$PWD/resources/model-catalog.json"
# or: export NEXUS_MODEL_CATALOG_URL="file://$PWD/resources/model-catalog.json"
```

**Update when a model goes paid / a new Grok lands:**

1. Edit `resources/model-catalog.json` (set `availability: "api-only"` / add the new id).
2. Push to branch `catalog` (or copy into `~/.nexus/model-catalog.json`).
3. Restart Nexus — boot refresh reloads the overlay; `fs.watch` also picks up local edits.

## Security notes

- Adapters are **declarative only** — they specify argv arrays and env var
  names, they cannot execute arbitrary code.
- `env.passthrough` vars are injected **only** into that adapter's PTY. Plain
  shell panes never see them.
- Schema validation runs at load time; any adapter that fails Zod validation
  is rejected with a console error.
