# Baseline repair report

Date: 2026-08-07

## Scope

Repaired the intentional mission-stall changes before Nexus V2 Task 1. The repair is limited to blocked-handoff authority/store behavior, its focused physical-boundary integration assertions, and the stale guided coordination assertion.

## RED

### Physical blocked handoff

Command:

```text
npx vitest run src/main/orch/http-mcp-boundary.integration.test.ts
```

Observed output:

```text
Test Files  1 failed (1)
Tests       3 failed | 25 passed (28)
```

The three failures were the expected reproduction:

- `commits a physical non-success handoff and terminal block without a false transport error`: expected mission `status: "blocked"`, received `status: "running"` at line 1509.
- `returns the committed non-success handoff after its own mission block`: expected mission `status: "blocked"`, received `status: "running"` at line 1528.
- `rejects a divergent blocker replay after the mission is already blocked`: expected a `dispatch_required` denial, received `handoff replay recusado: missão running diverge do resultado esperado` at line 1567.

Duration: 2.06s; command exit code 1.

### Guided coordination

Command:

```text
npx vitest run src/main/orch/guided-mission-coordination.test.ts
```

Observed output:

```text
Test Files  1 failed (1)
Tests       1 failed | 4 passed (5)
```

`keeps mutating team requests on the delivery graph` expected an `isolated_worktree` row, but the intentional operator-choice simple delivery plan returned no such row (`false` received at line 247).

Duration: 1.98s; command exit code 1.

## Root cause

`commitTaskDispatchHandoffInTransaction()` intentionally leaves a non-success mission running so worker-decision clarify chips can be persisted before the mission transitions to `blocked_user`. `blockTaskDispatchFromHandoff()` performed that post-commit sequence, but `ScopedHandoffStore.#submit()` used the transactional primitive directly and omitted it. The committed dispatch/task/receipt therefore coexisted with a running mission, and replay correctly detected divergent durable state.

The coordination production topology was already correct. Autopilot/operator-choice seals the delivery writer as `same_checkout` with `guided-simple-implementation`; the test's `isolated_worktree` proxy was stale.

## Changes

- `src/main/orch/task-dispatch-handoff-authority.ts`
  - Added the reusable `completeBlockedTaskDispatchHandoffPostCommit()` authority sequence.
  - The sequence bounds the detail, emits worker-decision clarify while the mission is running, durably blocks the mission as `blocked_user`, and emits the scoped change.
  - The direct blocked-handoff wrapper now delegates to the shared sequence.
- `src/main/orch/handoff-store.ts`
  - Invokes the shared sequence after a newly committed non-success physical dispatch transition.
  - Keeps the invocation inside `!committed.replayed`, so exact replay does not emit another clarify or block again.
  - Preserves the prior success/general change and dispatch-change behavior.
- `src/main/orch/http-mcp-boundary.integration.test.ts`
  - Verifies one physical handoff plus one clarify handoff, one physical receipt, `blocked_user`, and the existing exact/divergent replay outcomes without clarify duplication.
- `src/main/orch/guided-mission-coordination.test.ts`
  - Verifies returned topology `delivery`.
  - Verifies a `same_checkout` row owns `GUIDED_TASK_DOMAINS.simpleImplementation`.
  - Retains the assertion that no row owns `team-read-only-fanout`.

## GREEN

### Physical blocked handoff

Command:

```text
npx vitest run src/main/orch/http-mcp-boundary.integration.test.ts
```

Final output:

```text
Test Files  1 passed (1)
Tests       28 passed (28)
Duration    1.91s
```

The expected replay/gate-denial diagnostics identify `state=blocked_user` and `reason=dispatch_required:nexus_handoff_submit`; there were no warnings or errors.

### Guided coordination

Command:

```text
npx vitest run src/main/orch/guided-mission-coordination.test.ts
```

Final output:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
Duration    1.84s
```

No warnings, errors, or unexpected output were emitted.

No formatter, linter, typecheck, build, security scan, or project-wide test command was run.

## Commit

Repair commit: `da9c72d1` (`fix(orch): finalize blocked physical handoffs`)

Only the four repair code/test files were included in this commit. All other pre-existing tracked and untracked working-tree changes were left untouched.

## Self-review

Reviewed the exact four-file commit with CodeRabbit CLI 0.7.0 and manually against the brief.

- Confirmed the new post-commit sequence is shared by both entry paths and ordered clarify → `blocked_user` → change emission.
- Confirmed the physical store calls it only for a new non-success dispatch transition; `committed.replayed` remains side-effect free.
- Confirmed success handoffs and non-dispatch submissions retain the existing general change emission, and dispatch listeners still fire.
- Confirmed replay tests hold the row counts at two handoffs (one physical, one clarify) and one physical receipt, proving no clarify/receipt duplication for same or divergent retries.
- Confirmed the coordination test asserts the actual topology, writer execution mode/domain, and absence of team-read-only fanout without changing production planning.

Review finding dispositions:

1. The reviewer warned that the fifth `"user"` argument might be ignored. Verified against the current checkout: `blockTaskDispatchMission()` already accepts `kind: "technical" | "user" = "technical"` and persists `blocked_user` for `"user"`. The focused integration test was strengthened to assert `intentState: "blocked_user"`; it passes.
2. The reviewer proposed a new durable pending-completion marker for a process-exit window. This is outside the brief's deliberately post-commit contract and would add schema/recovery behavior not requested by the baseline repair. It was not adopted. The required first-write and same/divergent replay contracts are covered and green.

No in-scope correctness, replay, audit, receipt, or topology issue remained after review and final focused verification.
