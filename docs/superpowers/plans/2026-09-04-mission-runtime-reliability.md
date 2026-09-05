# Nexus mission reliability implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement independently scoped fixes, with TDD and review. Do not commit, push, deploy, or change user runtime data while implementing.

**Goal:** Make ordinary mission execution and terminal setup observable, coherent, and verifiable, using the operator's configured providers and real handoffs.

**Architecture:** Keep the existing fast-lane mission entry point and its authority checks. Repair demonstrated contract mismatches instead of adding another engine. The router must use the same credential resolution as provider execution; mission prompts must have one dispatch owner and one completion contract; exhausted recovery must expose an actionable state.

**Tech stack:** Electron, TypeScript, React, SQLite, Vitest, CLI PTYs and MCP.

**Spec:** User requests from 2026-09-04: sidebar deletion, per-pane terminal/LLM setup, and a comparative review plus repairs to the overall mission engine. Reference evidence: `docs/analysis/bridgespace-3418-extract/DOSSIE-HARNESS.md`, `docs/analysis/overclock-13318-dossie-portabilidade.md`, current source and current local runtime (read-only).

## Constraints

- Preserve existing working changes and real user missions/configuration.
- Use existing credential stores; never print or persist secrets in evidence.
- Keep project/sandbox/mission/worker authority checks intact.
- An ASK result requires actual pane responses and an accepted handoff; never synthesize success.
- Product copy in PT-BR, design from DESIGN.md, no new dependency.
- Focused tests, TypeScript, renderer-sink check, UI QA and a real mission probe before claims.

## Task 1: Finish workspace UI (root)

Files: App, WorkspaceRail, Launcher, TerminalGridDialog, TerminalGridPanels and related styles/tests.

- [x] Reproduce invisible remove action: opacity 0, pointer-events none, position outside mission row.
- [x] Add visible independent removal control and preserve explicit confirmation/project scope.
- [x] Build folder/layout and per-pane tool/model/account steps from existing provider catalogue.
- [x] Preserve panes in same project; confirm before switching projects and terminating sessions.
- [x] Remove duplicate App restore-gate call that incorrectly captures fresh agents.
- [x] Run focused regressions, verify desktop/compact/light layouts.
- [ ] Record QA items and final checks.

## Task 2: Resolve router credentials consistently (isolated implementer scope)

Files: `src/main/orch/intent-router.ts`, its tests, existing provider credential helpers as necessary.

Evidence: hasRuntimeKey accepts vault/env while routeIntent and answerDirectQuestion read only launcher providers.conf. With a ready vault key and no launcher entry, both return null without HTTP.

- [x] Add failing tests with vault-only and environment-only credentials, plus missing/disabled providers.
- [x] Reuse the provider execution credential resolver for routing and direct answers. Preserve provider preference/fallback order and timeout/abort behavior.
- [x] Verify HTTP receives the selected credential without changing persisted configuration or logging secrets.
- [x] Run router focused suites and typecheck; return file list and review notes.

## Task 3: Make coordinator prompts consistent (isolated implementer scope)

Files: `src/main/orch/orchestrator-doctrine.ts`, co-located tests, narrowly scoped call sites if an explicit already-dispatched flag is required.

Evidence: plan/consult forbids workers but appends a base doctrine forbidding coordinator execution; first-wave is dispatched by main yet ordinary kickoff asks coordinator to spawn it again.

- [x] Add failing prompt contracts for consult, plan, maxWorkers=0, first-wave dispatched, and meta-pane ASK.
- [x] Give consult/plan a coherent direct-execution and completion rule; do not force a diagnostic answer into docs/plan.md.
- [x] Make dispatched first-wave authoritative and tell coordinator to collect its results, spawning only undispatched work or justified replacements through existing tools.
- [x] Keep user playbook verbatim, security note, worker handoff authority and PT-BR response policy.
- [x] Run doctrine/fast-lane relevant tests and return scoped review notes.

## Task 4: Diagnose and repair runtime recovery/handoff (root)

Files: fast-lane runtime and tests, only additional source identified by reproduction.

- [x] Read current failed mission events/dispatch/handoff counts without editing databases.
- [x] Add regression for running mission with no live pane and exhausted recovery budget.
- [x] Replace silent forever-running outcome with explicit recoverable technical blockage, preserving history and operator retry.
- [x] Probe a real isolated mission through prepare/start/PTY/response/handoff and inspect any actual failure before additional fixes.
- [x] Validate an answer task and a small file-producing task, recording limitations if external CLI auth/quota blocks the probe.

## Task 5: Integrate and deliver review (root)

- [x] Review all task diffs; address concrete findings.
- [x] Run focused suites for modified files, typecheck, renderer sinks, and renderer build.
- [x] Write `docs/analysis/2026-09-04-nexus-mission-engine-review.md` with evidence vs hypotheses, current-vs-old comparisons, fixes, remaining risks and verifiable commands/artifacts.
- [x] Deliver exact verified scope. Do not claim overall excellence or production readiness from unit tests alone.

## Delivery note

Final delivery is scoped to local DEV validation on branch
`fix/nexus-mission-reliability-20260904`. It is not a packaged release sign-off.
Final archived logs live in
`docs/qa/evidence/2026-09-05-final-delivery/`. The security incident follow-up
keeps the explicit limitation that the revocation endpoint returned HTTP 200,
but independent invalidation of the credential was not proven.
