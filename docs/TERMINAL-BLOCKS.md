# Terminal Command Blocks

## Contract

`CommandBlock` is an **immutable semantic layer** beside the raw PTY stream.
The byte stream remains the visual source of truth (xterm + scheduler).

| Field | Notes |
|-------|--------|
| id, sessionId, paneId, workspaceId | Correlation |
| missionId | Optional |
| command | **Always redacted** before persistence/UI |
| cwd | Absolute, OSC-validated |
| projectRoot, shell, gitBranch | Attribution |
| startedAt / endedAt / durationMs / exitCode / status | Lifecycle |
| outputRange | Optional stream sequence bounds |
| redaction | denylist + secretHits |
| idempotencyKey | SHA-256, insert dedupe |

## Ownership

| Component | Process | Role |
|-----------|---------|------|
| `Osc133Scanner` | main | Tolerant parse of OSC 133 / 7 / 9;9 |
| `CommandBlockTracker` | main | `tapSessionData` consumer; in-memory blocks |
| `CommandBlockStore` | main / project runtime | SQLite persistence (migration 014) |
| `command-redaction` | main | Fail-closed scrub + denylist |
| Shell scripts | `resources/shell-integration/` | Optional zsh/bash/fish emitters |

## Feature flag

- `feature.terminal.commandBlocks` (channel: `dev`, **default on**, kill switch supported)

## Error flow

- Shells without integration → no events, terminal unchanged.
- Corrupt/control-bearing OSC → ignored; partial sequences buffered ≤ 4 KiB.
- Unsafe cwd from OSC → rejected (`isSafeOscCwd`).
- Secret-like input → redacted or `[DENYLISTED]` before store.

## Limits

- Max command length 16 384.
- Max blocks per session in tracker (default 200).
- Store prune keeps latest N finished rows (default 5 000).

## Migration

Project runtime migration `014-mission-events-command-blocks` creates `command_blocks`.
Additive only. Rollback: leave table empty + flag off (no destructive drop in prod).

## Security

- Never log raw command lines with secrets.
- Shell emitters percent-escape OSC delimiters/control bytes before emission;
  the main scanner rejects decoded control-bearing command/cwd payloads.
- Denylist: `history`, `env`, `printenv`, export of secret env names.
- Re-execution (future) must reuse the same PTY write policy / ownership.

## Metrics

- Recognition rate: sessions with ≥1 finished block / sessions with integration.
- Secret hits count on insert.
- Tracker disabled time (flag off).

## How to test

```bash
npx vitest run \
  src/shared/command-block.test.ts \
  src/main/terminal/shell-integration-osc133.test.ts \
  src/main/terminal/command-redaction.test.ts \
  src/main/terminal/command-block-store.test.ts \
  src/main/terminal/command-block-tracker.test.ts
```

Enable flag in `~/.nexus/feature-flags.json` (dev channel) for dogfood:

```json
{
  "schemaVersion": 1,
  "overrides": [{ "id": "feature.terminal.commandBlocks", "enabled": true }]
}
```

Source shell integration when `NEXUS_SHELL_INTEGRATION=1`.
