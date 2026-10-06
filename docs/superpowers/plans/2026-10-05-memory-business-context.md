# Memory and business context implementation plan

> **For agentic workers:** Execute bounded tasks with test-driven-development. Shared checkout is authorized by the coordinator; no commits/deployment.

**Goal:** Relevant, current, authority-scoped context that preserves decisions and avoids repeated discovery.

**Architecture:** Reuse SQLite/FTS, file links, operator attestations, business context mounting and hook dedupe. Repo excerpts stay unverified; operator attestation grants business-fact authority. No vector engine/provider/code egress.

**Tech Stack:** TypeScript, existing SQLite meta, Node 22/Vitest.

**Spec:** Operator-authorized scope supplied by coordinator on 2026-10-05; same release.

## Constraints

- Preserve project/same-mission/quarantine checks and history. Never infer global preferences.
- Retention/classification is not factual verification.
- No unrelated native-heavy WIP, commits, deploy, full suite or concurrent typecheck.

## Tasks

- [x] RED impact starvation; reserve two candidate positions for linked facts within eight/bounded bytes; preserve dedupe/authority.
- [x] RED repeated-hook counters; defer acknowledgement until context survives delivery dedupe; keep spawn/MCP behavior.
- [x] RED explicit named operator correction; supersede only its authorized topic, preserving unrelated/history/quoted negatives. Peer review added same-clause negation guard, four RED→GREEN cases.
- [x] RED root PRODUCT/PRD excerpts with local source/revision citations and inert rendering; confirmed workspace business facts use existing attestation contract/form. Execution document wins; cross-project fallback and planted sources cannot confer authority.
- [x] RED changed source files; bounded maintenance/meta marks freshness without claiming first observation proves factual truth. Descriptor read guards and 1 MB cap remain local to the coordinator.
- [x] Focused authority-negative tests; renderer sinks zero; independent routing reviewer found no remaining blockers after correction-verb negation and clause guards. Twelve-file focused run passed 300 tests; final preference/attestation/profile/operator-context run passed 36 tests (overlapping). Coordinator owns final typecheck/release.
