# NexusIDE 0.76.213 reviewed release implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute tasks in order, with one implementer at a time and a task review after each change.

**Goal:** Publish the next macOS ARM64 release with the production-ready improvements from the reviewed PRs, preserving current 0.76.212 behavior and fixing regressions in included changes.

**Architecture:** Start from upstream/main eab826a5d in an external .noindex worktree. Integrate ready feature commits rather than importing the unused ORC foundation or introducing new subsystems. Keep existing Main authority, account failover and packaged smoke implementations when they supersede older PR implementations.

**Tech Stack:** Electron, TypeScript, React, better-sqlite3; Node 22.23.2; repository-pinned npm 12.0.0; existing Developer ID/notarization pipeline.

**Spec:** User request to release the improvements already ready, previous PR review and docs/RELEASE-CHECKLIST.md. Included product scope: launcher shortcuts/accessibility, paged handoff listing, Luna decisions with per-account settings and conservative ensemble, live mission board. Existing main account/failover, capture and smoke fixes remain canonical after a read-only comparison.

## Global constraints

- Work only in /Users/cleofaspereirarocha/.nexus-worktrees/release-076213-reviewed.noindex on codex/release-0.76.213-reviewed.
- Preserve the user's coordination checkout and uncommitted files. No worktrees under the repository root.
- Read AGENTS.md and applicable security ownership documents before changes under src/main/orch or src/main/runtime.
- Every affected source gets its co-located test; typecheck and renderer-sinks run for renderer/IPC changes.
- One heavy validation/build command at a time. Never rebuild shared coordination node_modules.
- Never re-enable SSL.com eSigner/CKA/Windows signing. Site and cloud-api are independent projects, and this app release does not deploy them.
- No automatic GPT-6 Astra selection. Implementers do not spawn further agents.
- Release source, local annotated tag, package/server/lock/CURRENT_RELEASE/CHANGELOG, built artifacts and receipts must agree. No force push, tag replacement, manual publication bypass, or weakened gate.
- User authorized a new release and necessary integration/publication. Do not request approval again for the same authorized action. Platform question is optional; use current macOS ARM64 channel if unanswered.
- Do not advertise the unused effect outbox/receipts/boot gate, Mermaid component without renderer/product wiring, CLI history parser without import UI/store, native resource monitor, Tiptap, WSL or CDP relay as delivered functionality.

## Task 1 — Ready T3 launcher and pagination

Files: src/shared/cursor-pagination.ts and test, src/main/orch/tools-handoff.ts, src/main/orch/handoff-store.ts and tests, src/renderer/components/product/Launcher.tsx and test, src/renderer/lib/action-names.ts and test, src/renderer/styles/app-shell.css; docs/qa/items/F-1049.md.

Interfaces: preserve list's array return when limit/cursor absent; cursor mode returns {items,nextCursor,hasMoreHistory}. Extend acknowledgeSeenByOrchestratorList(missionId, seenIds?) without breaking legacy callers.

- [x] Integrate only PR126 commits 802251949 and a4c0a021a, resolving context against current main; exclude their ancestors' unused ORC changes.
- [x] Add the failing pagination test from docs/qa/evidence/2026-10-08-pr-review-mimo-t3/pagination-ack.patch to the co-located handler test. Prove invalid cursor does not ACK; page ACK affects only returned ids. Add store coverage for scoped id selection and existing full-list compatibility.
- [x] Select/validate the page before ACK, and ACK only returned ids; use parameterized SQL, validated ids and bounded chunks if necessary. Preserve own-mission/current-leader authority and submitted-only update.
- [x] Add rendered keyboard verification for launcher action callbacks and editable-input suppression; preserve canonical design tokens and current UI copy.
- [x] Run focused cursor/launcher/handler/store tests, typecheck and renderer-sinks with Node22. Update F-1049 with evidence only after passing; commit explicit pathspecs.

## Task 2 — Luna and conservative ensemble

Files: PR124's 43 changed files, especially src/main/decision-models/decision-ensemble.ts and test, src/main/orch/jev-handoff-review.ts consumer; docs/qa/items/F-1047.md.

Interfaces: preserve per-account decision settings, explicit opt-in Luna/Juntos, no credential fallback, refusal semantics, vision consent/redaction and paid-call accounting.

- [x] Integrate PR124 head f88205509 against current release branch, preserving main's subsequent changes.
- [x] Add the failing reproduction from ensemble-evidence.patch with the actual handoffBounceSignals consumer.
- [x] Remove changed_code from LOWER_IS_RESTRICTIVE so the maximum preserves the requirement for verification. Cover all providers and three-member combinations; do not change other calibrated directions.
- [x] Run focused decision and handoff review tests, typecheck and renderer-sinks. Update F-1047 and commit explicit paths.

## Task 3 — Live board on current main

Files: PR125's 8 changed files, particularly src/main/orch/mission-engine-production.ts, MissionGraph.tsx, mission-board.css and co-located tests; docs/qa/items/F-1051.md.

Interfaces: roster includes only physically live mission members from the coordination checkout; idle Maestro remains live, closed workers/history are not reanimated. Preserve main's inspector/zoom sizing tokens and existing scope boundaries.

- [x] Integrate PR125 head 1ff1a026e on the updated release branch.
- [x] Reproduce the failing literal assertion at MissionBoard.layout.test.ts:113 against current main's calc(--mission-inspector-toggle-width ...).
- [x] Adjust the test and any overlapping CSS to the canonical spacing contract, without reverting main's newer inspector sizing. Perform one focused DOM/browser layout verification with inspector open/closed at normal and narrow widths, recording effective spacing and absence of overlap; preserve current tokens.
- [x] Run snapshot/graph/layout focused tests, typecheck and renderer-sinks; update F-1051 and commit explicit paths.

## Task 4A — current account selection and measured cross-window confirmation

Read-only comparison proved explicit accountId is dropped by the mission picker/IPC/preload/Main despite main already sealing the physical account. Adapt only missing transport/pin checks from 4693c47cc; retain F-1002 physical identity+effort, F-995 compare-and-swap/recovery, F-249 no-data same-pane/capped retry, F-645/F-646 native credential ownership. Do not import old colliding F-954/955/956 docs or broad rebind implementation.

Files: PanePicker.tsx/test, preload.ts/shared/types.ts, orch-ipc.ts/test, renderer-mission-authority.ts/adoption test; limit-refutation.ts/test and failover tests. Add fresh QA records after checking free IDs.

- [x] Reproduce account-pin loss and cross-kind exhausted window behavior.
- [x] Transport explicit accountId through validated contracts and existing accountPin mechanism; prove requested account matches physical spawned account before sealing/returning.
- [x] Add cross-window confirmation only for fresh provider-api account windows with measured exhaustion (usedRatio >= 1), usage-kind unscoped hits. Keep existing matching-kind 0.8 policy intact; 0.79/0.80/0.99 in opposite-kind windows do not prove exhaustion. No stale/local/unknown/tier confirmation. Preserve switched only after actual recovery and active-account/headroom rules.
- [x] Run focused picker/authority/failover/limit tests, typecheck, sinks; independent task review and explicit-path commits.

## Task 4B — explicit Shot target without regressing current capture flow

Main already stages/batches capture paths without Enter. Adapt only missing explicit target/query from PR106 938ba4249, preserving F-613 batching/staging and scope/parked guards.

Files: shot-bridge-server.ts/test, shared/shot-bridge.ts, main.ts callback wiring, shot-ingest.ts/test; terminal-host.ts/test only if needed. Add fresh QA record.

- [x] Reproduce authenticated targets query/current target omission; prove explicit target selects intended live pane.
- [x] Add bounded token-protected GET /shot/targets and optional validated targetPaneId. Explicit dead/foreign/parked target must refuse, never fall back to a different pane.
- [x] Revalidate workspace/target after async staging; preserve quoted trailing-space/no-Enter delivery, recording batch prioritization and known-folder guards.
- [x] Run focused bridge/ingest/host tests, typecheck, sinks; actual local HTTP roundtrip and independent review before committing.

## Task 4 — Whole candidate verification and version

- [x] Read-only scout compares PR123/122/106 to main and records superseded or missing ready behavior; include a missing fix only after focused reproduction and review.
- [ ] A fresh reviewer examines the whole integration diff for correctness/security, scopes, account isolation and feature readiness. Address important findings.
- [ ] Run full app tests, server typecheck/tests, renderer sinks and the mission E2E, sequentially. If an unrelated test fails, reproduce on baseline; do not call it a product regression without attribution and do not bypass release gates.
- [x] Choose a still-unused monotonic version at release time (planned 0.76.213). Update package/server/lock/CURRENT_RELEASE/CHANGELOG with accurate ready feature notes.
- [ ] Commit clean source, revalidate authority, create local annotated tag at exact HEAD, check no other release is running and valid Developer ID/notary profile.

## Task 5 — Build, gate and publish

- [ ] Follow build/notarize.md and docs/RELEASE.md with Node22.23.2 and pinned npm. Prepare with release:mac --no-publish; build and candidate gates precede additional packaged acceptance and publication.
- [ ] Require security audits/SBOMs, signed/notarized/stapled DMG/ZIP, real packaged smoke, graceful process exit and final receipt. Fix a concrete failure without disabling checks.
- [ ] After candidate and extra acceptance pass, release:mac --from candidate includes the only publication transaction through release:publish:macos. Verify remote bytes/digests/tag/version and report links, actual platforms and remaining limits. Do not call a second publisher.
- [ ] Maintain an evidence ledger mapping every docs/RELEASE-CHECKLIST.md requirement to an automated/manual check or an explicit remaining limit. Do not infer UI/voice/update or soak coverage from an unrelated smoke.
- [ ] Verify adapted T3 file coverage in third_party/provenance/t3code-26285ab.json and THIRD_PARTY_NOTICES.md, preserving attribution.

## Rulings and execution ledger

- User's 'melhorias já prontas' means release ready, connected product changes. Unused foundations remain in their PR for a separate implementation; no speculative engine rewrite is part of this release.
- GitHub Actions was previously budget-blocked. macOS uses the existing local launchd release pipeline; no dependence on unavailable hosted jobs.
- Bundled SDD workspace/review-package scripts are absent. Use the documented manual git diff package fallback and the plan-owned ignored ledger .superpowers/sdd/release-076213-reviewed/progress.md.

## Completed integration evidence before source freeze

All scoped implementations and independent reviews passed: Task1 at6d4e42455,
Task2 ate02f75598 (including F1055–1058 conservative decisions, usage receipts and
recipient-specific consent), Task3 atc5f3395e7 (F1059 live membership fallback),
Task4A at84cdc152d (F1052 account selection, F1053 measured cross-window exhaustion),
Task4B atcc81b7eef (F1054 explicit capture target). Final source regression, whole
review, signing, packaged acceptance and publication remain pending; these scoped
results alone do not declare the release ready.

The user chose macOS first; Windows/Linux wait for available runners and their
independent gates. Canonical/public latest verified v0.76.212 before choosing213.
Final regression uses a fully owned npm12 install in the isolated release worktree;
coordination dependencies were not rebuilt. Public notes list only connected
features and disclose beta/live-provider test limits.
