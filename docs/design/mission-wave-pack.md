# ADR — Mission Wave Pack (Livre · Pack · Guiado)

**Status:** Accepted (Wave 1 authority field landed; wizard picker optional)  
**Date:** 2026-08-03  
**Branch:** `feat/mission-wave-pack`  
**Owner:** orchestration  
**Cross-ref:** `docs/analysis/2026-08-02-overclock-124-distill.md`, `docs/design/parallel-task-scheduler.md`

## Context

Overclock’s happy path is brief → Maestro spawns N panes → handoff. Nexus already
has `maxWorkers=12` and an ownership-disjoint scheduler, but **promoted BMAD
plans always seal Guided delivery** (`choosePrimaryExecutor` → 1 writer). Squad
prompts still say “one story at a time”, so a mission with 7 stories never
becomes 7 panes.

The product intent is acceleration with organization — not BMAD theatre that
serializes coding behind a roster ritual.

## Decision

Introduce three **orchestration modes** (orthogonal to `lane` / `executionMode`):

| Mode | When | Graph | PREVC fence |
|------|------|-------|-------------|
| **Livre** | Explicit ad-hoc / no sealed pack | Maestro/operator spawn ≤ `maxWorkers` | No (ops-like freedom; OS sandbox stays) |
| **Pack** (`wave-pack`) | Promoted plan with ≥2 extractable stories, risk ≠ destructive | N story tasks (`isolated_worktree`) + optional QA gate | No — scheduler + ownership + merge queue enforce |
| **Guiado** (`delivery`) | Default for engine squads / single story / destructive / sensitive when opted | Advisories + 1 writer + reviews + QA | Yes |

### Story → task (Pack)

1. Parse BMAD headings from promoted `summary` (`### Story N.M: title` / `# Story N.M:`).
2. Seal one mutation task per story, domains:
   - `guided-implementation`
   - `wave-pack` (topology marker)
   - `wave-pack-story:<id>` (disjointness key)
3. Round-robin **executor** agents from the approved roster (same agent may own
   multiple stories → N panes of the same CLI — Overclock parity).
4. Optional quality-gate reviewer depends on all story tasks.
5. Optimistic parallel waves; merge queue serial; ownership-violation fail-closed
   on merge (existing scheduler contract).

### What we refuse to copy from Overclock

- No OS-sandbox bypass for speed.
- No boot-time builtin rewrite that invalidates an already-approved mission
  without reapproval UX.
- No “yolo by default”.

### What we keep from Nexus

Seatbelt/bwrap/OCI, MCP bearer, worktree + RouteReservation, evidence-bound
handoff, merge validation.

## Consequences

- `StandardMissionTopology` gains `"wave-pack"`.
- `missionRequiresGuidedPrevc` returns false for `wave-pack` (same class as
  `team-read-only-fanout`).
- Promoted-plan path in `ensureGuidedMissionPlan` no longer hard-codes
  `"delivery"` when ≥2 stories parse.
- Builtin story-impl prompt must be updated in Wave 1 to match Pack semantics
  (remove “UMA POR VEZ” as hard doctrine when Pack seals).
- Completion for Pack uses scheduler/delivery-style done+merge, **not** the
  team fan-out consolidation ACK path.

## Non-goals (Wave 0)

- Hibernation/wake of panes
- Soft-status cross-CLI hooks
- Recipe marketplace UI
- Changing security floor / sandbox

## Rollout

1. **Wave 0 (this branch):** pure planner + topology + tests; Pack seals when
   stories parse; happy-path wiring (canonical planner ids, ownership files,
   non-claim `wave-pack`, bootstrap topology, scheduler completion, idle ACK,
   kickoff Pack).
2. **Wave 1:** optional `orchestrationMode` on the intent contract + plan seal
   (`forcedMode` → `resolveMissionOrchestrationMode`) so Pack can be forced or
   suppressed. Promote UI asks Pack vs Guiado when the physical plan has ≥2
   BMAD stories (MissionRail ▶ and toast “Executar plano”); native review stays
   the authority boundary. Full Livre picker in MissionWizard remains optional.
3. **Wave 2:** structured story artifacts (stop relying on markdown parse);
   Pack templates (Landing / SaaS / Fix) with declared fan-out.

## Wave 0 fix log (2026-08-03 review)

| Gap | Fix |
|-----|-----|
| Canonical `guided-execution` only | `parseGuidedTaskKind` allows `wave-pack-*` planner ids |
| Empty ownership.files | Pack seals inventory + `repository-coverage` |
| Shared `wave-pack` claim | Added to `OWNERSHIP_NON_CLAIM_DOMAINS`; scheduler/worktree ignore file overlap between Pack peers |
| Bootstrap PREVC | Promotes `wave-pack` topology from plan result |
| Completion topology | `missionSchedulerCompletionTopology` detects Pack → legacy complete |
| Kickoff “uma story” | Pack-specific sequence + promotedPlanBlock |
| Fast-path kickoff contradicted motor | Delivery without PREVC uses Main-owned sequence (no ACK/done ceremony) |
| Cross-mission Pack file fence | `exclusiveOwnershipOverlap` requires `sameMission` to ignore inventory |
