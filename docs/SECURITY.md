# Security

## Contract

Fail-closed for permissions, MCP, filesystem, secrets, agents, and side effects.
All external input validated with Zod at process boundaries.

## Ownership

| Surface | Module |
|---------|--------|
| MCP effects | `mcp-effect-policy.ts`, `mcp-dispatch.ts` |
| PTY env / ownership | `pty-manager.ts` |
| Workspace paths | `renderer-workspace-scope.ts`, `workspace-path` |
| Audit + redaction | `jarvis/audit-log.ts`, `command-redaction.ts` |
| Autonomy | `autonomy/autonomy-profiles.ts` |
| Browser | `browser/url-policy.ts` |

## Error flow

- Invalid schema → reject, no side effects.
- Path escape → throw / deny.
- Audit write failure → policy-defined block for effectful tools (`effectMayHaveCommitted` when handler already ran).
- Unknown MCP tool → never executes.

## Limits

- Max redaction depth/size (audit-log constants).
- Command history max length / denylist.
- Editor max ~1.5 MB.
- Mission event payload ≤ 64 KiB.

## Migration / rollback

Additive SQLite migrations only. Feature flags kill-switch new paths.

## Metrics

Secrets redacted count; denied path escapes; MCP denials.

## How to test

```bash
npx vitest run src/main/orch/mcp-dispatch-security.test.ts \
  src/main/terminal/command-redaction.test.ts \
  src/main/persistence/renderer-workspace-scope.test.ts \
  src/main/autonomy/autonomy-profiles.test.ts
```
