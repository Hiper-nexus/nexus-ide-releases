# MCP Hub

## Contract

Config-plane hub for multi-source MCP servers (stdio, streamable-http, sse-legacy).
**Does not** bypass `mcp-dispatch` effect policy, schema validation, allowlist, or audit.

## Ownership

- Core: `src/main/mcp-hub/mcp-hub-core.ts`
- Runtime tool calls: existing `mcp-dispatch.ts` / `mcp-server.ts`
- Flag: `feature.mcp.hub`

## Error flow

Flag off → writes throw. Drift report is non-destructive. Backup required before overwrite.

## Limits

≤ 64 servers; tools ≤ 512/server; secrets masked in UI projection.

## Migration / rollback

Timestamped `.bak` next to config file; `rollbackFromBackup`.

## Security

Secrets masked; OAuth/PKCE transport wiring deferred (PARCIAL) — no cloud tokens without need.

## Metrics

Drift count; backup success; health status per server.

## How to test

```bash
npx vitest run src/main/mcp-hub/mcp-hub-core.test.ts src/main/orch/mcp-dispatch-security.test.ts
```
