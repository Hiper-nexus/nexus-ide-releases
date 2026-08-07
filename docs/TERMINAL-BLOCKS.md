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
| `CommandRefineryStore` | main / project runtime | Idempotent aggregate + ranked suggestions (migration 036) |
| `command-redaction` | main | Fail-closed scrub + denylist |
| Shell scripts | `resources/shell-integration/` | Optional zsh/bash/fish emitters |

## Command refinery

Every clean `success`/`failed` block updates `command_stats` exactly once via
its idempotency key. Redacted, denylisted, running, cancelled, and unknown
blocks remain in the audit history when appropriate but never become a
suggestion.

Ranking is deliberately hierarchical before it is numerical:

1. exact `cwd`;
2. another directory under the same recorded project root;
3. the remaining history in this checkout-scoped runtime.

Within each tier the score combines logarithmic frequency, success rate,
recency, and distinct-day breadth. Counts decay every 30 days. Dismissing a
row hides it until that exact command is observed again; the
dismiss count remains a negative signal and decays with the aggregate.

The renderer sends only a prefix and the owned pane/session coordinates. Main
derives `cwd`, project root, and project runtime from the live tracker. Running
a suggestion resolves the exact command in SQLite again, applies the existing
re-run deny policy, and writes through the PTY ownership boundary.

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
- Suggestion prefix is capped at 512 characters; result limit is capped at 20.
- Candidate reads are bounded per tier, so a large global history cannot crowd
  an exact-directory match out of the result set.

## Migration

Project runtime migration `014-mission-events-command-blocks` creates
`command_blocks`. Migration `036-command-refinery` adds `command_stats`
(`WITHOUT ROWID`), the distinct-day set, and an idempotent observation journal.
On the first refinery read, Main re-runs every legacy row through the **current**
redactor before backfilling it; rows now recognized as secret-like are marked as
observed but never indexed. The feature is therefore useful immediately after
upgrade without trusting stale redaction metadata. Both migrations are
additive. Rollback: leave tables empty + flag off (no destructive drop in
production).

## Security

- Never log raw command lines with secrets.
- Shell emitters percent-escape OSC delimiters/control bytes before emission;
  the main scanner rejects decoded control-bearing command/cwd payloads.
- Denylist: `history`, `env`, `printenv`, export of secret env names.
- Re-execution re-resolves server-side state and reuses the same PTY write
  policy / ownership; client-supplied command text is not authoritative.

## Metrics

- Recognition rate: sessions with ≥1 finished block / sessions with integration.
- Secret hits count on insert.
- Tracker disabled time (flag off).
- Suggestion hit, explicit dismiss, and successful re-run rates.

## How to test

```bash
npx vitest run \
  src/shared/command-block.test.ts \
  src/main/terminal/shell-integration-osc133.test.ts \
  src/main/terminal/command-redaction.test.ts \
  src/main/terminal/command-block-store.test.ts \
  src/main/terminal/command-block-tracker.test.ts \
  src/main/terminal/command-refinery-store.test.ts \
  src/main/terminal/terminal-block-actions-ipc.test.ts \
  src/renderer/components/CommandBlockMenu.test.tsx
```

Enable flag in `~/.nexus/feature-flags.json` (dev channel) for dogfood:

```json
{
  "schemaVersion": 1,
  "overrides": [{ "id": "feature.terminal.commandBlocks", "enabled": true }]
}
```

Source shell integration when `NEXUS_SHELL_INTEGRATION=1`.
