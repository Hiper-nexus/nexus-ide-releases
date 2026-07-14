# Parallel Task Scheduler (default fan-out of independent mission tasks)

Status: **Operational (P0–P4)** · Owner: orchestration · Flag: `orch.parallelScheduler` (release configuration **on**; production loop starts after orchestration bootstrap)

Modules:
- pure core: `src/main/orch/mission-scheduler.ts` (`decideSchedule`, ownership/glue, adaptive cap, telemetry, planner contract, fail-closed diff check)
- meta codec: `src/main/orch/mission-scheduler-meta.ts`
- runtime driver: `src/main/orch/mission-scheduler-runtime.ts` (`runSchedulerTick`, `finalizeTaskForMerge`)
- production loop: `src/main/orch/mission-scheduler-production.ts` (5-second tick, isolated worker panes, serial merge queue)
- IO bridge: `src/main/orch/mission-scheduler-io.ts`
- flag: `FEATURE_FLAG_IDS.parallelScheduler` = `orch.parallelScheduler`

## Goal

When a mission has many steps/tasks (say 1–10), stop running them strictly one at a
time. Fan out the **provably-independent** tasks across multiple worker panes so they
run **simultaneously**, each isolated in its own Git worktree, **never touching the
same files**, then integrate them through a serial merge barrier. Make the fan-out the
**default** — but only for tasks whose file ownership is disjoint and whose
dependencies are satisfied; everything else stays sequential.

The hard constraint the user set — "não pode sobrepor arquivos" — is **the gate
condition**, not an afterthought: two tasks only run in the same wave if their declared
ownership is pairwise-disjoint.

## What already exists (do NOT rebuild)

Most of the substrate is in the tree today:

| Primitive | Where | What it gives us |
|---|---|---|
| Per-task worktree + ownership + deps | `nexus_worktree_create` (`tools-context.ts:760`) | `ownership {files, symbols, domains}` + `dependsOn [{missionId, taskId}]`, protected-context guard, blast-radius expansion |
| Worktree registry | `WorktreeRuntimeRegistry.create` (`worktree-runtime-registry.ts:76`) | Materializes an isolated git worktree per task |
| Ownership blast-radius | `expandOwnershipWithBlastRadius` (`orientation-blast-radius`) | Expands declared files to their structural dependents so "disjoint" is honest |
| Merge integration | `MergeQueue` + `MergeValidationCoordinator` (`merge-queue.ts`, `merge-validation-coordinator.ts`) + `nexus_merge_task` | Serial, validated merge of a worktree back to the base |
| Task store | `task-store.ts` (`TaskStatus = pending\|running\|done\|failed`) | Per-mission task records + status |
| Mission supervisor | `mission-drive.ts` (`decideDriveAction`, sequential `currentStepId`) | Watchdog / evidence gate — one current step at a time |
| Workflow autopilot | `prevc-autopilot-policy.ts` | Stage advancement (not a task scheduler) |

**The gap:** allocation is **LLM-orchestrator-driven and ad-hoc** (`nexus_worktree_create`
is called by the orchestrator role when it decides to). There is **no deterministic
scheduler** that computes ready+disjoint waves and fans them out by default. That is the
only new thing to build.

## Architecture — the scheduler loop

A new pure-core module `mission-scheduler.ts` (mirroring `mission-drive.ts`'s pure
`decide*` style: no IO, `now` injected) plus a thin runtime driver.

```
decideSchedule(tasks, activeWorkers, cap, now) -> SchedulePlan
```

Loop (deterministic, re-entrant on every tick / task-completion event):

1. **Ready set** = tasks with `status = pending` and every `dependsOn` task `done`+merged.
2. **Disjointness filter** = greedily admit ready tasks whose *expanded* ownership
   (files ∪ symbols ∪ domains) does not intersect (a) any already-admitted task in this
   wave, nor (b) any `running` worker's ownership. Deterministic order (task id) so it is
   reproducible and testable.
3. **Concurrency cap** = admit up to `min(configuredCap, cores-2, MAX_LIVE_PANES budget)`.
4. **Dispatch** = for each admitted task: `nexus_worktree_create` (existing) → spawn a
   worker pane in that worktree → mark `running`. (Reuses the existing spawn + worktree path.)
5. **On task done** = enqueue its worktree on the `MergeQueue` (serial barrier). On merge
   success → `done`; unblocks dependents next tick. On **merge conflict** or **ownership
   violation** → fail-closed (see below).
6. **Terminal** = all tasks `done` → mission complete (hand back to `mission-drive` gate).

Sequential is just the degenerate case: cap effectively 1, or no two ready tasks are
disjoint → exactly today's behavior. So this **strictly generalizes** the current driver.

## Fail-closed enforcement (the senior part)

"Disjoint by declaration" is not trusted blindly:

1. **Ownership-violation check.** Before merge, diff the worktree against base; every
   changed path MUST be within the task's *expanded* ownership. Out-of-scope change →
   reject the merge, mark task `failed`, re-run that task **sequentially on the merged
   base** (no other worker running). This catches an agent that wandered outside its lane.
2. **Overlap is impossible by construction** in a wave (step 2), but "glue" files
   (lockfiles, barrel `index.ts`, migrations, `.nexus/`, `.context/`) are **reserved**:
   never ownable by a parallel task (already partly enforced — `nexus_worktree_create`
   rejects `.context`/`.nexus/project.json`). Extend the reserved list; tasks needing glue
   files run sequentially.
3. **Merge conflict** (declared disjoint but git still conflicts) → serialize the loser on
   the new base; log the mis-declaration for planner feedback.
4. **Resource ceiling** → cap by cores/memory/pane budget; never spawn past it.

Correctness > speed everywhere: any ambiguity collapses to sequential.

## Planner contract

For the scheduler to have anything to parallelize, the **planner** (`squad-architect.ts` /
mission-wizard) must emit tasks already carrying `ownership` + `dependsOn`. Some of this
exists for worktree tasks; the change is to make **every** planned mission task declare:

- `dependsOn: taskId[]` (DAG edges)
- `ownership.files: glob[]` (best-effort; blast-radius expands + enforcement corrects)

Where the planner cannot confidently declare disjoint ownership, it emits a single
sequential chain (safe default).

## Phased implementation

| Phase | Deliverable | Testable outcome | Status |
|---|---|---|---|
| **P0** | `mission-scheduler.ts` pure core: `decideSchedule` (ready set + disjointness + cap). No IO. | Unit tests: DAG ordering, disjoint-wave selection, cap, all-sequential fallback, glue-file reservation. | **done** (`mission-scheduler.test.ts`) |
| **P1** | Ownership-intersection util + reserved-glue list; expander hook compatible with `expandOwnershipWithBlastRadius`. | Unit tests: overlap detection incl. blast-radius, reserved files never parallel. | **done** |
| **P2** | Runtime driver: `runSchedulerTick` → injected worktree/spawn/MergeQueue deps, flag `orch.parallelScheduler` (release-configured on). | Integration test with fake spawn/merge: 3 disjoint → wave of 3; dependent → next wave; flag off → wave of 1. | **done** (`mission-scheduler-runtime.test.ts`) |
| **P3** | Fail-closed: `enforceOwnershipOnDiff` + `finalizeTaskForMerge` re-run; planner `emitPlannedTasksWithContract` + `nexus_task` plan/create. Release flag is **on** and production dispatches only approved, planned tasks. | Out-of-scope diff rejected + re-run; merge conflict serialized; planner sequential chain when ownership unknown. | **done** |
| **P4** | Telemetry counters (wave size, conflict, violation) + adaptive cap starting 2, widen after clean waves. | Tests for counters and adaptive widen/shrink. | **done** |

## Risks & rollout

- **LLM-declared ownership is unreliable** → P1 blast-radius + P3 enforcement are the
  safety net; never trust the declaration for correctness, only for scheduling.
- **Glue-file contention** (lockfiles, barrels, migrations) → reserved, always sequential.
- **Cost** (N panes + worktrees = memory/CPU/disk) → hard cap, resource-aware.
- **Rollout**: release default is on for the *provably-independent subset*; the
  production loop still requires an approved mission contract and a sealed task plan.
  Kill-switch = flip flag → pure sequential.

## Production behavior

After Nexus orchestration boots, the scheduler evaluates running missions every five
seconds and on task/mission changes. It creates one isolated worktree and worker pane
per admitted task, respecting dependencies, ownership overlap, worker budgets, and
the existing mission contract. A worker must mark its task `done`; the scheduler then
queues the worktree through the existing validated serial merge barrier. A failed
dispatch marks the task `failed` and a failed merge remains recoverable through the
existing merge queue state.

## Open questions

1. Merge barrier granularity: merge each task as it finishes (max throughput, more
   conflict surface) vs merge a whole wave atomically (simpler, more idle)? Lean:
   per-task via the existing `MergeQueue` serial semantics.
2. Should `mission-drive`'s evidence/PREVC gate run **per task** (parallel) or only at the
   merge barrier? Lean: per-task evidence at completion, PREVC receipt at merge.
3. Does the planner declare ownership, or do we derive it from a dry-run/orientation map
   and only *confirm* with the planner? Lean: planner declares, orientation expands,
   enforcement corrects.
