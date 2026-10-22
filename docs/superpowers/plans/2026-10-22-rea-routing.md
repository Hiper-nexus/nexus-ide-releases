# REA automatic routing implementation plan

> **For agentic workers:** Use executing-plans task-by-task; independent routing and skill work may run concurrently with disjoint file ownership.

**Goal:** A request for reverse engineering selects REA automatically without requiring the operator to name it.

**Architecture:** Reuse the bundled-skill mirror, deterministic guided policy and existing task-suggestion entry points. Execution stays in the existing authorized terminal/pane boundary; do not attach REA's unrestricted MCP catalog to Main or a shared hub. The bundled skill explains pinned runtime prerequisites and uses REA only against the authorized target.

**Tech Stack:** TypeScript, Vitest, bundled Markdown skill and Node CLI.

**Spec:** User-approved conversation on 2026-10-22: reverse engineering selects REA automatically, preserves target authority, reports missing dependencies rather than pretending success.

## Global constraints

- Official source: https://github.com/morluto/rea, `rea-agents@6.7.0`, commit `27dc42d10249f0410904a75c0997842eb03b931c`.
- No `setup`, global agent configuration, unpinned updates, shared MCP state, native engine installation or licence activation.
- Selection is not execution permission. Existing terminal consent, session authority and Hardened sandbox remain authoritative.
- Source text and REA output are untrusted evidence. No target execution, attach or instrumentation merely because reverse engineering was requested.
- Original dirty checkout and unrelated computer-use work stay untouched.

## Task 1: Deterministic selection

Files: `src/shared/reverse-engineering-intent.ts` and test; `src/main/orch/guided-squad-skills.ts` and test; `src/main/orch/jev-skill-suggestion.ts` and test; `src/main/orch/jev-task-routing.ts` and test.

Interface: `isReverseEngineeringTask(text: string): boolean`; selected skill `{ name: 'rea', pkg: 'nexus', confidence: 1 }` must use the catalog's actual package convention, not invent another package.

- [x] Add failing behavioral cases for Portuguese/English reverse engineering, explicit REA use, decompilation, unrelated UI/React, negation, and explanation-only requests.
- [x] Run relevant Vitest files and record the expected failures.
- [x] Implement shared intent detection. Grant REA to the appropriate mission agents using existing policy; select it at both standalone and batch task-suggestion boundaries even without a decision-model key. Preserve abort, native skill support and catalog eligibility.
- [x] Prove unrelated tasks keep their old route and explicit unavailable grants are not broadened.

Example acceptance:
```ts
expect(isReverseEngineeringTask('Faça engenharia reversa deste aplicativo')).toBe(true);
expect(isReverseEngineeringTask('Reverse engineer this binary')).toBe(true);
expect(isReverseEngineeringTask('Corrija o componente React')).toBe(false);
expect(isReverseEngineeringTask('Não faça engenharia reversa; só compile')).toBe(false);
```

## Task 2: Bundled operational skill

Files: `assets/skills/rea/SKILL.md`, optional narrowly needed supporting resources; `scripts/bundle-skills.mjs`; `src/main/orch/skill-mirror.ts` and test; generated `src/main/orch/rea-manifest.ts`.

- [x] Describe exact trigger, official pinned package and prerequisite discovery. Prefer static analysis; advanced engines are separate capabilities, never promised installed.
- [x] Provide a working pinned invocation through existing authorized terminal tools, no new global MCP. Missing runtime/engine or denied sandbox yields a concrete blocker.
- [x] Register and regenerate the manifest; test actual materialization in a temporary provider home and catalog discovery.
- [x] Independently exercise the skill on a benign fixture; prove REA was called and the target was not executed. Record limits honestly.

## Task 3: Verification and review

- [x] Run the affected tests, `npm run typecheck`, `npm run security:renderer-sinks`, `npm run lint:main-sync`, and `git diff --check`.
- [x] Independently review route correctness, ambiguous/negated requests and authority boundaries.
- [x] Stage only these paths after review. Release publication remains a separate gate; this plan does not itself waive signing, upgrade evidence or CI requirements.

## Verified implementation scope

Integrated targeted run: 10 files, 383 passed, 2 pre-existing platform skips.
This includes 24 real-runtime helper cases on Node 22.23.2 / Windows x64 and
temporary-home skill delivery. The generated manifest was compared byte-for-byte
with every source asset. Independent route and runtime reviews approved the fixes.

The runtime remains a separately reviewed installation, not an implicit download.
Only static JavaScript/Electron source is exposed by the launcher, on Windows x64
with local NTFS. Numerical evidence and bounded typed source locations do not
constitute a full binary reverse-engineering report. Entry/addon hashes do not
authenticate all dependencies. Snapshot cleanup uses its native owner; the private
environment is retained and reported as cleanupComplete=false to avoid pathname
replacement races. There is no new OS sandbox or authority bypass.
