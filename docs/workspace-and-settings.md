# Onboarding, Settings Hub & Provider Routing

How NexusIDE handles startup, configuration and the multi-CLI
provider model.

## Startup flow

1. **Launch screen** (`LaunchScreen.tsx`) — the first surface when no workspace
   is open: "Novo workspace" (folder picker), open by path, and a **recent
   workspaces** list. Persisted in `~/.nexus/workspaces.json`.
2. **Inside the workspace** — the active workspace root becomes the cwd of every
   new pane/agent. The bar shows the workspace name + "trocar" and a
   **＋ Missão** button.
3. **Mission wizard** (`MissionWizard.tsx`) — walks through these steps:
   - **Modo**: `LIVRE` (solo agents) or `SQUAD` (orchestrated preset).
   - LIVRE → `Panes` (count) → `Providers` (per-pane CLI) → launch.
   - SQUAD → `Squad` (pick preset) → `Revisar` → launches the squad's
     orchestrator, which then delegates via the embedded MCP tools.

## Settings hub (`SettingsDrawer.tsx`)

Reached via **⚙** in the bar or **⚙ Configurações** on the launch screen.
Left rail = **MÓDULOS** (Terminal, Voice, Providers, Squads, Marketplace)
+ **CATALOG** (Agents, Skills, MCPs, Tools, Plugins, Hooks, Rules, Atalhos).

### Providers / CLIs + Keys (`ProvidersPanel.tsx`)

The central config hub, per adapter:

- **enable/disable** the CLI (a disabled provider cannot spawn);
- **binary path** override (absolute path bypasses the PATH check);
- **default model** and **extra args**;
- **upstream routing** (see below);
- **API key** stored in the **macOS Keychain** via Electron `safeStorage` —
  never plaintext, never on any IPC snapshot (the UI only sees a masked
  preview like `sk-…4a2f`). Set / clear / **test-connection**. If the OS
  keychain is unavailable (e.g. an unsigned dev build) the key is kept for the
  session only and the UI says so — it never falls back to plaintext on disk.

Config lives in `~/.nexus/providers.json` (non-secret); secrets live encrypted
in `~/.nexus/secrets.enc` (safeStorage blobs).

## Provider routing — ai-launcher port

`launcher-provider-manager.ts` is a TypeScript port of the provider/account
core of the user's `~/ai-launcher` dispatcher (bash, v1.11.0). It reproduces
the launcher's canonical provider table and its Anthropic-compatible env
routing so a single Claude-compatible CLI can be pointed at another upstream:

| Upstream | Base URL | Token |
|---|---|---|
| anthropic (nativo) | — | CLI's own auth |
| glm (Z.ai) | `https://api.z.ai/api/anthropic` | required |
| sakana (Fugu) | `https://api.sakana.ai/v1` | required |
| deepseek | `https://api.deepseek.com/anthropic` | required |
| openrouter | `https://openrouter.ai/api` | required |
| ollama / lmstudio / litellm | localhost | none |

When a routable CLI is pointed at a non-native upstream, the spawn injects
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (never `API_KEY` for third
parties) plus the provider's extra env (e.g. GLM's `API_TIMEOUT_MS`,
`ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.6`), exactly like the launcher's
`provider_setup_env`. The token comes from the Keychain; env flows into the
xterm PTY via the provider spawn overrides.

**Staged for the next slice** (full ai-launcher parity, 2-3 day estimate):
multi-account snapshot/switch of the native Claude Keychain credential and the
5h rate-limit-window auto-switch. The routing table + env builder (~70% of the
reusable logic) and per-provider keys are shipped here.
