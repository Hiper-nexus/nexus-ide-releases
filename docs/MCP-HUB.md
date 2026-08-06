# MCP Hub

## Contract

Config-plane hub for multi-source MCP servers (stdio, streamable-http, sse-legacy).
**Does not** bypass `mcp-dispatch` effect policy, schema validation, allowlist, or audit.

## Across Tools (observe + sync)

**Observe** (read-only matrix):

- Core: `src/main/mcp-hub/mcp-hub-observers.ts`
- Shared types: `src/shared/mcp-across-tools.ts`
- IPC: `product:mcpHub.observe` (no feature-flag gate)
- Cells: `present` | `absent` | `unknown` — never invented

**Sync fill-gaps** (writes, flag `feature.mcp.hub`):

- Core: `src/main/mcp-hub/mcp-hub-sync.ts`
- IPC: `product:mcpHub.syncPlan` · `product:mcpHub.syncApply`
- Apply input: `{ dryRun?, mode?, exportTools? }` — dry-run writes nothing;
  `exportTools` limits which tools receive fill-gaps (opt-in)
- Import observed servers → `.nexus/mcp-hub.json`
- Export hub gaps → Cursor / Claude Code / Codex / OpenCode / Cline
- Never deletes; timestamped `.bak` before each write; UI confirms via `askConfirm`
- Settings → MCPs: **Simular** (dry-run) + checkboxes por tool + Sync

Probes: Nexus hub, `~/.cursor/mcp.json`, `~/.claude.json` (+ Claude Desktop),
`~/.codex/config.toml`, `~/.config/opencode/opencode.json`, Cline
(`cline_mcp_settings.json` sob VS Code / Cursor / Insiders / `~/.cline` — first hit).

**Cline write-back:** format `{ mcpServers }` (+ `disabled: false`, `autoApprove: []`
nos gaps novos). Fail-closed: se nenhum settings existir, plano marca
`cline: config missing` e não cria o arquivo (evita escrever no host errado).

## Ownership

- Core: `src/main/mcp-hub/mcp-hub-core.ts`
- Observers: `src/main/mcp-hub/mcp-hub-observers.ts`
- Runtime tool calls: existing `mcp-dispatch.ts` / `mcp-server.ts`
- Flag: `feature.mcp.hub` (writes/save/drift-input still gated)

## Error flow

Flag off → writes throw. Drift report is non-destructive. Backup required before overwrite.

## Limits

≤ 64 servers; tools ≤ 512/server; secrets masked in UI projection.

## Migration / rollback

Timestamped `.bak` next to config file; `rollbackFromBackup`.

## Security

- UI projection masks secret-shaped env/headers (`maskServerForUi`).
- **Disk vault (2026-08-06):** secret env/header values are moved into the
  OS-backed secrets store (`safeStorage` / Keychain) as
  `__nexus_vault__:<key>` refs inside `.nexus/mcp-hub.json`. Load hydrates for
  runtime; save seals before write. Migration of legacy plaintext happens on
  first load when secure storage is available.
- **Mask / vault fail-closed:** UI `[REDACTED]` placeholders are never sealed
  into the vault (would destroy the real token). Vault refs shown to the UI
  are fully redacted (never partial `__…[REDACTED]`). Load migration write
  failures keep the in-memory hub (never empty-out on flag-off / disk error).
- Agent tools cannot read `.nexus/mcp-hub.json` (`agent-path-policy`).
- OAuth/PKCE transport wiring deferred (PARCIAL) — no cloud tokens without need.

## Metrics

Drift count; backup success; health status per server.

## How to test

```bash
npx vitest run src/main/mcp-hub/mcp-hub-core.test.ts src/main/mcp-hub/mcp-hub-sync.test.ts src/main/mcp-hub/mcp-hub-observers.test.ts
```
