# Mission Event Journal

## Contract

Append-only `mission_events` with per-consumer cursors and delivery ACK.
Complements (does **not** replace):

- `event_ledger` — hash-chained integrity for context/workflow
- `mission_drive_state` / `mission_step_receipts` — budgets & PREVC
- `effectMayHaveCommitted` — MCP effect uncertainty

| Column | Meaning |
|--------|---------|
| sequence | Monotonic per mission |
| run_id / parent_run_id | Agent/run parentage |
| event_type | Validated enum |
| payload_json | ≤ 64 KiB, redacted upstream |
| idempotency_key | Dedupe on (mission_id, key) |
| delivery_status | pending → delivered → acked |

## Ownership

| API | Module |
|-----|--------|
| append / replay / ack / projectRecent | `MissionEventJournal` |
| Schema | migration `014-mission-events-command-blocks` |
| Flag | `feature.mission.eventJournal` |

## Error flow

- Exact duplicate idempotency → return existing row (no double effect).
- Same idempotency key with different run/type/origin/payload/time → throw conflict.
- Oversized payload → throw, no insert.
- Corrupt row → `ScopedStoreCorruptionError` (fail closed).
- Core columns immutable via trigger; only `delivery_status` updates.

## Cursor / ACK

```
consumer lastSequence = N
replay(afterSequence: N) → events
ack(consumer, mission, upTo) → min(max(cursor, upTo), durable max sequence); mark acked
```

Cursor is monotonic within durable history. A corrupt/future cursor is repaired
down to the mission's highest durable sequence so replay cannot be skipped.

## Rollback

Flag off stops writers/readers in app code. Tables remain empty-safe.
Do not DROP in production; wipe only disposable project runtimes in dev.

## Metrics

- Events lost after crash: 0 (WAL + transactional append)
- Duplicates on retry: 0 (idempotency key)
- Replay lag: `max(sequence) - consumer.lastSequence`

## How to test

```bash
npx vitest run src/main/orch/mission-event-journal.test.ts
```
