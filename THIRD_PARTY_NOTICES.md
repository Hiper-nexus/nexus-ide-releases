# Third-party notices

NexusIDE includes third-party software and data. The corresponding licenses
remain with their copyright holders.

## @lydell/node-pty macOS bootstrap

Terminal PTYs use `@lydell/node-pty@1.2.0-beta.12` (MIT). On macOS, the
deterministic install step `scripts/patch-node-pty-darwin.mjs` changes the
pinned platform package's `helperPath` from its bundled `spawn-helper` to
Apple's `/usr/bin/perl` and removes that redundant executable. The script
accepts only the recorded upstream and patched SHA-256 values; it does not
change the native `pty.node` binding. The upstream copyright and MIT `LICENSE`
remain packaged with `@lydell/node-pty`.

## taste-skill design dials

The design profile of the automatic prompt engine
(`src/main/orch/design-profile.ts`) adapts the concept and taxonomy of the
aesthetic-direction variants (minimalist/brutalist/soft) and the 1–10 design
dials (variance/motion/density) from
[`leonxlnx/taste-skill`](https://github.com/leonxlnx/taste-skill)
(MIT, copyright 2026 Leonxlnx). The injected instruction text is original to
NexusIDE; no upstream files are redistributed.

## WebRTC AEC3 WebAssembly

Realtime echo cancellation uses `@ennuicastr/webrtcaec3.js@0.3.0`, a
WebAssembly port maintained by Yahweasel/Ennuicastr of Google's WebRTC AEC3.
The package glue uses the 0-clause BSD license and the compiled WebRTC implementation is
BSD-3-Clause, with some WebRTC components under Apache-2.0. The complete
upstream notices are retained verbatim in the packaged module
`node_modules/@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.js`.

NexusIDE uses the same WASM artifact on macOS, Windows and Linux. It does not
copy or redistribute the proprietary AEC binary found in Overclock.

## SpeechKit wake-word models

The offline wake pipeline contains three ONNX artifacts from
[`Soulcreek2/speechkit-wakeword-models`](https://huggingface.co/Soulcreek2/speechkit-wakeword-models),
pinned at commit `479ba4f8d0233541e4b25583803afad275fcdc1f`:

- `melspectrogram.onnx` — SHA-256 `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f`
- `embedding_model.onnx` — SHA-256 `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f`
- `hey_jarvis.onnx` — SHA-256 `7256019a18029c7bea33abc3344f7a3d0e07655cf4a5f18e65c9b6329eac3fb6`

The artifacts are distributed under the Apache License 2.0. NexusIDE stores
the bytes as base64 without modifying the model weights. The shared
mel/embedding components derive from the permissive openWakeWord/Google speech
embedding pipeline; the phrase head is SpeechKit's independently trained
Apache-2.0 model. NexusIDE does **not** include openWakeWord v0.5.1's
CC BY-NC-SA `hey_jarvis_v0.1` phrase model.

The Apache License 2.0 text is included at
`third_party/licenses/Apache-2.0.txt`.

## VT323 font

`src/renderer/styles/fonts/VT323-Regular.ttf` is the VT323 font by Peter Hull,
distributed under the SIL Open Font License 1.1. The license text is included
at `third_party/licenses/OFL-1.1.txt`.

## Tesseract OCR language data

Offline English and Portuguese OCR use the pinned npm packages
`@tesseract.js-data/eng@1.0.0` and `@tesseract.js-data/por@1.0.0` (MIT package
metadata; trained data originating from the Apache-2.0 Tesseract tessdata
project). The compact `4.0.0_best_int` artifacts are verified before use:

- `eng.traineddata.gz` — SHA-256 `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`
- `por.traineddata.gz` — SHA-256 `dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c`

NexusIDE resolves these files from its signed package and copies verified bytes
to a private local runtime directory. OCR does not download language data at
runtime.

## Onlook CSS-to-Tailwind translator

Visual Edit uses the CSS-to-Tailwind translator from the
[`onlook-dev/onlook`](https://github.com/onlook-dev/onlook) project
(`packages/utility/src/tailwind.ts`), fetched from the `main` branch on
2026-07-10. Copyright remains with the Onlook contributors. The translator is
distributed under the Apache License 2.0 and credits an adaptation of
[`hymhub/css-to-tailwind`](https://github.com/hymhub/css-to-tailwind), which is
distributed under the MIT License.

The vendored translator logic is consumed without local modification. The
Apache License 2.0 text is included at
`third_party/licenses/Apache-2.0.txt`.

## ORCA (stablyai/orca) — terminal reliability modules

Selected modules are adapted from
[`stablyai/orca`](https://github.com/stablyai/orca) at commit
`143c36e566483006fe54fa2716b019ec00599752`, licensed under the MIT License.

Copyright (c) 2026 Lovecast Inc.

The full MIT license text is included at `third_party/licenses/orca-MIT.txt`.
Per-file provenance (upstream URL, original path, SHA-256 of the original
file, Nexus destination path, and adaptation notes) is recorded in
`third_party/provenance/orca-143c36e.json`.

Adapted modules in this harvest:

- Renderer recovery circuit breaker
- Terminal stream protocol
- Terminal output scheduler
- Worktree removal safety (with orphan gitdir proof and path-compare helpers)

Every adapted source file carries an attribution header pointing at the pin
and license. Existing copyright notices inside copied code are preserved.

## brace-expansion 5.0.8 security compatibility package

The build toolchain uses an exact copy of the patched
[`brace-expansion@5.0.8`](https://github.com/juliangruber/brace-expansion/tree/v5.0.8)
CommonJS implementation (MIT, Copyright Julian Gruber; TypeScript port
Copyright Isaac Z. Schlueter). A Nexus-authored export adapter keeps legacy
minimatch 3.x/5.x consumers callable while retaining the modern `.expand` and
named ESM contracts. The expansion algorithm itself is unmodified.

This temporary local package addresses
[`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
until compatible v1/v2 maintenance releases are published and consumed by the
complete Electron Forge maker tree. Removal is tracked against upstream pull
requests
[#129](https://github.com/juliangruber/brace-expansion/pull/129),
[#130](https://github.com/juliangruber/brace-expansion/pull/130),
[#134](https://github.com/juliangruber/brace-expansion/pull/134), and
[#135](https://github.com/juliangruber/brace-expansion/pull/135).

License text: `third_party/licenses/brace-expansion-MIT.txt`. Source hashes,
npm integrity, commit/tag pin, and compatibility rationale:
`third_party/provenance/brace-expansion-5.0.8-compat.json`.

## JavaScript and native dependencies

The production dependency inventory and individual package licenses are
recorded in the CycloneDX SBOM shipped with every release. Package license
files remain present in their packaged npm modules when required by the
upstream package.

## stablyai/orca (Agent Runtime harvest — F3)

Additional modules adapted from [stablyai/orca](https://github.com/stablyai/orca) at commit
`143c36e566483006fe54fa2716b019ec00599752` (MIT, Copyright (c) 2026 Lovecast Inc.):

- crash reporting (process-gone classification/dedupe/diagnostics, GPU fallback, breadcrumb/report stores)
- agent hook types/listener/status and agent-awake sleep prevention

License text: `third_party/licenses/orca-MIT.txt`. Provenance ledger:
`third_party/provenance/orca-143c36e.json`.

## hosted-git-info@9.0.3 (via ORCA hosted-remote-url)

`src/main/git/hosted-remote-url.ts` is adapted from stablyai/orca @
`143c36e566483006fe54fa2716b019ec00599752`, which documents a scoped local fork
of **hosted-git-info@9.0.3** behavior (ISC) for GitHub/GitLab/Bitbucket remote
parsing. Nexus does not vendor the npm package; dual provenance is recorded in
`third_party/provenance/orca-143c36e.json`.

## stablyai/orca (Source Control harvest — F4)

Modules adapted from [stablyai/orca](https://github.com/stablyai/orca) at commit
`143c36e566483006fe54fa2716b019ec00599752` (MIT, Copyright (c) 2026 Lovecast Inc.):

- `src/main/git/hosted-remote-url.ts` (+ dual provenance hosted-git-info@9.0.3 ISC behavior)
- `src/main/source-control/forge-provider.ts` (lean interface + authz/audit)
- `src/main/source-control/github-forge-provider.ts`
- `src/main/source-control/gitlab-forge-provider.ts`
- `src/main/source-control/forge-flags.ts` (Bitbucket/Azure/Gitea default off)

License text: `third_party/licenses/orca-MIT.txt`. Provenance ledger:
`third_party/provenance/orca-143c36e.json`.

## stablyai/orca (Remote harvest — F5)

Modules adapted from ORCA remote/relay/SSH/WSL concepts at the same pin
`143c36e566483006fe54fa2716b019ec00599752` (MIT, Copyright (c) 2026 Lovecast Inc.):

- `src/main/remote/terminal-stream-session.ts` (production session over terminal-stream-protocol)
- `src/main/remote/remote-terminal-streams.ts` (remote-bridge production path: pane.read/stream framing)
- `src/main/remote/relay-framing.ts`
- `src/main/remote/ssh-path.ts`
- `src/main/remote/wsl-detect.ts`
- `src/main/remote/device-pairing.ts` (device-pairing proof only; NOT end-to-end encryption — transport confidentiality is TLS)
- `src/main/remote/remote-capability.ts` (Nexus scope binding; local ProjectExecutionScope authority)

License text: `third_party/licenses/orca-MIT.txt`. Provenance ledger:
`third_party/provenance/orca-143c36e.json`.

## stablyai/orca — resync wave 1 (2026-09-11 @ f352b6b)

The crash-reporting, agent awake/sleep, hook-type and harness-injected-turn modules
first harvested at `143c36e` were resynchronized with
[`stablyai/orca`](https://github.com/stablyai/orca) at commit
`f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92` (v1.4.200; MIT, Copyright (c) 2026 Lovecast Inc.).
Their entries in `third_party/provenance/orca-143c36e.json` are marked superseded and
re-recorded in `third_party/provenance/orca-f352b6b.json`, together with the new upstream
dependencies those modules gained (`src/shared/crash-report-redaction.ts`,
`crash-report-exit-code.ts`, `posix-wait-status.ts`, `crash-report-signature-lines.ts`,
`crash-report-attribution-lines.ts`, `react-update-depth-attribution.ts`,
`computer-awake-mode.ts`; `src/main/crash-reporting/system-memory-details.ts`,
`swap-volume-free-space.ts`, `pre-gone-host-memory.ts`). Deliberately not resynced:
the GPU fallback marker (scheme v3 belongs to a restart-prompt flow Nexus does not have)
and the Windows ACL repair helper (Nexus keeps the bounded retry only).

## stablyai/orca (Design Mode harvest)

The incremental unique-selector algorithm in `src/preload/browser-design-mode.ts`
is adapted from Orca's Grab Mode guest overlay
(`src/main/browser/grab-guest-script.ts`), taken from
[`stablyai/orca`](https://github.com/stablyai/orca) at commit
`5e100914d3f557953c810da36448986a87efec14` (a newer pin than the F3/F4/F5
harvests — Orca ships daily and the grab overlay is under active development).
MIT License, Copyright (c) 2026 Lovecast Inc.

Only the selector-construction strategy was ported (build shortest unique
selector by climbing ancestors, preferring stable class names over generated
hashes, adding `:nth-of-type` only when not yet unique). Orca ships this as a
JS string injected via `executeJavaScript`; Nexus ports it to TypeScript module
functions inside its existing preload overlay and adapts it to this project's
secret redaction. The fast path (`#id` for a simple-css-ident id) is preserved.

The design **annotations** feature (numbered notes pinned on page elements,
shipped to an agent as one consolidated feedback prompt) is also adapted from
Orca's Design Mode at the same pin:

- `src/preload/browser-design-annotations.ts` — in-page numbered badge layer,
  adapted from `src/shared/browser-annotation-viewport-bridge.ts` (Orca injects
  a JS string template and mirrors viewport geometry over console messages;
  Nexus keeps its preload-module architecture in the pane's isolated world,
  driven by the closed automation channel, geometry-only).
- The annotation model (comment + intent + priority, 20-per-page cap, cleared
  on navigation) in `src/shared/browser-design.ts` and the main-owned store in
  `src/main/browser/design-session.ts` adapt `BrowserPageAnnotation` from
  `src/shared/browser-grab-types.ts` (Orca persists annotations in the
  renderer store; Nexus makes the main process the authority).
- The consolidated feedback prompt in `src/main/orch/design-annotation-format.ts`
  adapts the output model of
  `src/renderer/src/components/browser-pane/browser-annotation-output.ts`,
  rebuilt on this project's untrusted-envelope prompt discipline (page data
  never ships as free-form markdown).

License text: `third_party/licenses/orca-MIT.txt`. Provenance ledger:
`third_party/provenance/orca-5e1009.json`.

## stablyai/orca (late worker report settlement policy)

The precedence policy in `src/main/orch/provisional-worker-handoff.ts` is adapted
from `src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts`
at Orca commit `2f4f4578c828370f6413dc48f438a6b189f6190d`.
A real late report may replace a provisional inferred failure. Nexus applies
that policy through its existing physical receipt and dispatch CAS transaction;
it does not copy the upstream database implementation or relax identity checks.

Copyright (c) 2026 Lovecast Inc. MIT License.
License text: `third_party/licenses/orca-MIT.txt`. Provenance ledger:
`third_party/provenance/orca-2f4f457.json`.

## can1357/oh-my-pi (omp crossover harvest)

Modules vendored/adapted from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
at commit `03c48d073` (MIT, Copyright (c) 2025 Mario Zechner, Copyright (c)
2025-2026 Can Bölük). Analysis: `docs/analysis/2026-07-15-oh-my-pi-crossover-senior.md`.

- `src/vendor/omp/catalog/` — model catalog subset (pricing/context/capabilities) + identity classifier
- `src/vendor/omp/rate-limit/` — rate-limit reason taxonomy + retry-after text parsing (adapted for PTY output)
- `src/vendor/omp/hashline/` — hash-anchored patch language (applier, recovery, tests; xxHash32 reimplemented in TS)
- `src/vendor/omp/discovery/` + `src/main/discovery/` — multi-ecosystem agent-config discovery (subset)
- `src/vendor/omp/wire/` + `src/main/remote/relay/` — E2E collab wire protocol + content-blind relay (Bun→Node port)
- `src/main/orch/review-findings.ts` + builtin squad `review-p0p3` — review pipeline schema/prompts (derived)

License text: `third_party/licenses/oh-my-pi-MIT.txt`. Provenance ledger:
`third_party/provenance/oh-my-pi-03c48d0.json`. Vendoring policy: pinned copy,
never a live npm dependency; `src/markit`/mupdf-adjacent code excluded.

## generalaction/emdash (hook protocol harvest — wave 1)

Modules vendored/adapted from
[`generalaction/emdash`](https://github.com/generalaction/emdash) at commit
`c1af543f17241769c5cce29ab66cd47442d9d593` (Apache License 2.0,
Copyright 2026 General Action, Inc.):

- `src/vendor/emdash/hooks/` — canonical hook-event types
  (`CanonicalHookEvent`), the default hook-event parser, self-silencing hook
  command builders (curl `|| true` / PowerShell `SilentlyContinue`), native
  per-CLI hook spec tables and per-flavor `parseHookEvent` mappings
  (Claude/Codex/Kimi/Grok), plus their corresponding test suites.

The Apache License 2.0 text is shipped next to the vendored code at
`src/vendor/emdash/hooks/LICENSE.md` and also at
`third_party/licenses/Apache-2.0.txt`. Per-file provenance (upstream URL,
original path, SHA-256 of the original file, Nexus destination path, and
adaptation notes) is recorded in
`third_party/provenance/emdash-c1af543.json`.

Vendoring policy: pinned copy, never an `@emdash/*` npm dependency. No
upstream client ids, tokens or endpoints are redistributed — the vendored
command builders were re-pointed at NexusIDE's own loopback gate
(`$NEXUS_HOOK_URL` + per-pane bearer) and re-marked `NEXUS_HOOK_STATUS`.

## DESIGN.md workspace convention (Google Stitch / VoltAgent awesome-design-md)

Design mode reads a `DESIGN.md` file from the project root (the visual
counterpart to `AGENTS.md`, introduced by Google Stitch) and attaches it to the
agent prompt as trusted design-system context. This makes Nexus compatible with
the curated collection at
[`VoltAgent/awesome-design-md`](https://github.com/VoltAgent/awesome-design-md)
(MIT License): a user can drop any site's `DESIGN.md` into their project root
and design mode picks it up automatically.

Nexus does **not** redistribute any `DESIGN.md` files from that collection — the
integration is purely the reader convention (`src/main/orch/design-system-reader.ts`).
As the upstream repository notes, the extracted tokens represent publicly visible
CSS values and no site's visual identity is claimed; the decision to apply a
specific brand's design language remains with the user, in their own project.

## BridgeMind clean-room security patterns

NexusIDE includes clean-room, compact skills and audit patterns distilled from
the MIT-licensed [`BridgeWard`](https://github.com/bridge-mind/BridgeWard),
[`BridgeSecurity`](https://github.com/bridge-mind/BridgeSecurity), and
[`BridgeBench`](https://github.com/bridge-mind/bridgebench) projects by
BridgeMind. NexusIDE does not vendor their runtime source, assets, or text.

The integration is implemented in `src/main/security/` and
`src/main/eval/`: read-only content/source audits, provenance labels,
fail-closed tool validation, an immutable benchmark manifest/journal contract,
and an injected head-to-head runner. The original MIT notices remain with the
upstream projects; no upstream file was copied into the Nexus runtime.

## ssh2

Remote SSH transport (`src/main/integrations/ssh2-transport.ts`) depends on the
[`ssh2`](https://github.com/mscdex/ssh2) npm package (MIT License,
Copyright Brian White / mscdex and contributors), used for production SSH
sessions, remote worktree create, and SFTP. Optional native helpers may be
built by `cpu-features` on install.

## block/buzz (buzz-audit) — mission receipt hash chain

The mission receipt hash-chain module (`src/shared/receipt-chain.ts`) is
derived from the audit hash-chain of
[`block/buzz`](https://github.com/block/buzz) at commit
`8e81afa431deecd172f1ad6aab6f022f31cd812c` — specifically
`crates/buzz-audit/src/hash.rs` (preimage discipline: storage-precision
timestamp truncation, canonical sorted-key JSON, presence tags for optional
fields, big-endian sequence, zero-byte genesis sentinel) with the append and
`verify_chain` semantics of the neighbouring `service.rs`/`entry.rs`.

Copyright 2026 Block, Inc. Distributed under the Apache License 2.0.

The port is a TypeScript reimplementation (Rust is not redistributed); the
per-mission tenant binding replaces buzz's per-community binding, and the
hashed fields are Nexus handoff-receipt columns. Copyright header and license
reference: `third_party/licenses/buzz-APACHE-2.0.txt`; full license text:
`third_party/licenses/Apache-2.0.txt`.

## herdrdev/herdr — agent screen-state detection manifests

The 21 declarative agent-state manifests under `resources/agent-detection/*.toml`
are copied verbatim (plus an attribution header comment) from
[`herdrdev/herdr`](https://github.com/herdrdev/herdr) at commit
`702aa1e45527509bec73dad9b8d443f449c0379b` (`src/detect/manifests/`).
Copyright remains with the Herdr contributors. The manifests are distributed
under the Apache License 2.0.

The evaluation engine in `src/main/detect/` is a TypeScript reimplementation of
Herdr's manifest engine semantics (rule gates, regions, priority arbitration,
idle fallback, anti-flicker); no Rust code is redistributed.

The Apache License 2.0 text is included at
`third_party/licenses/Apache-2.0.txt`. Provenance ledger:
`third_party/provenance/herdr-702aa1e.json`.

## Impeccable (pbakaus/impeccable) — frontend visual audit skill

NexusIDE bundles the complete `impeccable` design and visual audit skill, copied from [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) at commit `8259c28209b92792005cec14dad573df39f68eaf`. Copyright remains with the Impeccable contributors. The skill files are distributed under the Apache License 2.0.

The Apache License 2.0 text and original third-party notices are included at `assets/skills/impeccable/LICENSE` and `assets/skills/impeccable/NOTICE.md`, and are mirrored to the client's local runtime skill folder upon bootstrap.

The Apache License 2.0 text is also included at `third_party/licenses/Apache-2.0.txt`.

## Paseo (getpaseo/paseo) — multi-agent orchestration, worktree lifecycle, activity timeline

Select components and patterns are adapted from [`getpaseo/paseo`](https://github.com/getpaseo/paseo)
at commit `a7a708bec99e935ee4b8c6f7314a4b9a9984cfa6`. Copyright remains with the
Paseo contributors. Distributed under the Apache License 2.0.

- **Design Tokens**: Calibrated surface and status dot color scales adapted from Paseo theme tokens into `DESIGN.md` and `src/renderer/styles/base.css`.
- **Activity Timeline & Diff Review**: Interactive tool-card timeline (`AgentActivityTimeline`) and gutter inline annotations (`GitPanelBody`) adapted into the renderer.
- **Git Worktree Isolation**: Branch slug sanitization (`src/shared/worktree-branch-slug.ts`), provenance metadata (`src/main/runtime/worktree-metadata.ts`), and lifecycle auto-archive (`src/main/runtime/worktree-lifecycle.ts`).
- **ACP Harness Presets**: Cursor, OpenCode, Kimi, and Copilot presets added to `src/shared/harness-catalog.ts`.

Provenance ledger: `third_party/provenance/paseo.json`. Full license: `third_party/licenses/Apache-2.0.txt`.

## Agent Orchestrator (Untrivial-ai/agent-orchestrator) — resizable inspector pattern

The mission inspector width preference and its collapsed reopening rail
(`src/renderer/state/mission-inspector-width-store.ts`,
`src/renderer/components/mission/MissionBoard.tsx`,
`src/renderer/styles/mission-board.css`) port the interaction pattern of
`frontend/src/renderer/hooks/useResizable.ts` and the inspector container in
`frontend/src/renderer/components/SessionView.tsx` from
[`Untrivial-ai/agent-orchestrator`](https://github.com/Untrivial-ai/agent-orchestrator)
at commit `73f0046ec5aee8f546a2ad75e4f75ad50ff222c9`: a panel width persisted in
`localStorage` and published as a CSS custom property on the layout root instead
of inline styles, a thin collapsed rail that reopens the panel once a drag
travels past an 8px threshold, and double-click to restore the default width.
The Nexus code is a fresh TypeScript implementation on top of its existing
mouse-driven splitter and zustand stores; no upstream file is redistributed.
Copyright remains with the Agent Orchestrator contributors. Distributed under
the Apache License 2.0.

Provenance ledger: `third_party/provenance/agent-orchestrator-2026-09-09.json`.
Full license: `third_party/licenses/Apache-2.0.txt`.

## stablyai/orca (Source Control GitHub PR merge-queue harvest)

Modules adapted from [`stablyai/orca`](https://github.com/stablyai/orca) at
commit `93334dc53fccdb7348d09fc28067ba6d3dec36ea`. MIT License, Copyright (c)
2026 Lovecast Inc.

- `src/main/source-control/github-pr-queue.ts` — GraphQL merge-queue probe,
  auto-merge mutations and enqueue flow adapted from
  `src/main/github/client.ts` (+ `github-pr-stack-async-merge.ts`), rebuilt on
  injected fetch with ForgeAuthorization + audit instead of the `gh` CLI.
- `src/shared/github-pr-merge-queue.ts` — merge metadata parsing, async-merge
  response classification and enqueue planning extracted as pure functions
  (no `gh` CLI, no Electron, no cache).
- `src/shared/github-pr-auto-merge-availability.ts` — auto-merge vs merge-queue
  availability rules without Orca i18n/types imports.
- `src/shared/github-pr-merge-state.ts` — PR merge-state presentation with
  Portuguese labels and tone tokens instead of i18n/Tailwind.
- `src/shared/pull-request-generation.ts` — honest LOCAL generator (commits +
  branch + issue) as the primary path; JSON parse kept as optional upgrade.
- `src/shared/source-control-primary-action-decision.ts` — primary-action
  decision core (commit / stage / publish / push / create PR / enqueue),
  Portuguese labels.

Provenance ledger: `third_party/provenance/orca-93334dc5.json`. License text:
`third_party/licenses/orca-MIT.txt`.

## stablyai/orca (Orchestration worker evidence harvest)

Modules adapted from [`stablyai/orca`](https://github.com/stablyai/orca) at
commit `4ec6bbf5884e5bd915b4f49c4602b5e5a88b61ae`. MIT License, Copyright (c)
2026 Lovecast Inc.

- `src/main/orch/worker-files-modified.ts` — `worker_done --files-modified`
  evidence contract from `src/main/runtime/orchestration/preamble.ts`: a
  writer that exits with 0 files-modified is not a successful delivery unless
  a real MCP handoff already closed a task.
- `src/main/orch/writer-circuit-breaker.ts` — connected+writable writer
  circuit adapted from `dispatch-circuit-breaker.ts`
  (`DISPATCH_CIRCUIT_BREAK_FAILURES = 3`): three deaths of the same role or
  adapter trip the circuit into remint / skip-silent.

Provenance ledger: `third_party/provenance/orca-4ec6bbf5.json`. License text:
`third_party/licenses/orca-MIT.txt`.

## stablyai/orca (terminal output scheduler resync — f352b6b)

The terminal output scheduler first adapted at commit
`143c36e566483006fe54fa2716b019ec00599752` (see "ORCA (stablyai/orca) —
terminal reliability modules" above) was resynced against
[`stablyai/orca`](https://github.com/stablyai/orca) at commit
`f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92` (v1.4.200), licensed under the
MIT License. Copyright (c) 2026 Lovecast Inc.

Between the pin and `f352b6b`, upstream sliced its single scheduler file into
a dozen pane-manager modules. Nexus did not mirror that split: the resync
ports three upstream behavior fixes onto the existing adapted single-file API
in `src/renderer/terminal/terminal-output-scheduler.ts`, rather than copying
the new file layout:

- orca#8754 — foreground hold and coalesce timers could cancel each other's
  fallback forever on an alternating stream (a continuously repainting TUI),
  freezing a visible pane. Ported as a shared release-deadline gate.
- orca#13402 / STA-3567 — partial queue slices and drained queue slots kept
  V8's full parent string alive. Ported as `flattenRetainedSlice` with the same
  geometric re-flatten bound, plus clearing drained slots early.
- Linear chunk assembly — output was assembled with repeated string
  concatenation, quadratic across many small queued chunks. Ported as
  array-and-join assembly.

Not ported: the ack-credit / delivery-credit flow control (remote PTY
multiplexing, no Nexus equivalent), the xterm `_core` dirty-row repaint
optimization (orca#18169, depends on the private API Nexus excludes), and the
mechanical file-split commits (no behavior change). Upstream's heap-measurement
tests for STA-3567 were not ported either; regression coverage was written
against Nexus's own public scheduler API.

The full MIT license text is included at `third_party/licenses/orca-MIT.txt`.
Per-file provenance is recorded in
`third_party/provenance/orca-f352b6b-terminal.json`; the two superseded entries
in `third_party/provenance/orca-143c36e.json` are marked `superseded` and point
at the new pin. The source file's attribution header names both pins.

## stablyai/orca (forge adapters resync — f352b6b)

The forge/source-control adapters first adapted at commit
`143c36e566483006fe54fa2716b019ec00599752` (see "Source Control harvest — F4"
above) were resynced against
[`stablyai/orca`](https://github.com/stablyai/orca) at commit
`f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92` (v1.4.200), licensed under the
MIT License. Copyright (c) 2026 Lovecast Inc.

This wave ports no code. The upstream files behind `forge-provider.ts`,
`forge-flags.ts`, `github-forge-provider.ts` and `gitlab-forge-provider.ts`
grew into Orca's full hosted-review multi-forge router and client graph, which
Nexus deliberately does not import; the upstream deltas since the pin were
reviewed in full and none crosses into the narrow injectable-HTTP surface these
lean adapters expose. `hosted-remote-url.ts` is byte-identical to the pin and
keeps its dual provenance (hosted-git-info@9.0.3). Headers were re-pinned and
per-file provenance is recorded in
`third_party/provenance/orca-f352b6b-forge.json`; the superseded entries in
`orca-143c36e.json` point at the new pin.

## stablyai/orca (Runtime/Remote resync)

Runtime and remote modules re-checked against
[`stablyai/orca`](https://github.com/stablyai/orca) at commit
`f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92` (upstream v1.4.200). MIT License,
Copyright (c) 2026 Lovecast Inc.

- `src/shared/terminal-stream-protocol.ts` (+ test) — full-file resync:
  `decodeTerminalStreamJson` gained an 8 MiB payload cap and structural/
  nesting limits via the new `src/shared/json-text-structure-limit.ts`
  (DoS prevention — oversized or deeply nested frames no longer reach
  `JSON.parse` uncapped); opcodes Ack, ClaimViewport, OutputSpan,
  SetOutputPaused and WriteUnavailable added as type surface only.
- `src/main/remote/ssh/ssh-config-path-expansion.ts` — `__PROGRAMDATA__`
  token expansion fix (Windows `ssh -G` prints it unexpanded; left alone
  when `ProgramData` is unset, guarded against startsWith collisions).
- `src/main/remote/ssh/ssh-config-parser.ts` — OpenSSH first-value-wins
  semantics for a single-valued directive repeated inside one Host block.
- `src/main/runtime/worktree-path-compare.ts` — Windows-path detection
  resynced onto the shared `isWindowsAbsolutePathLike` (upstream also
  removed the duplicate private regex); no behavioral change.
- Checked, no code changed: `worktree-removal-safety(.test)`, `ssh-path`,
  `cross-platform-path`, `terminal-stream-session(.test)`.
- Deliberately not ported: the `allowUnverifiedStop` Force Delete escape
  hatch and structured-agent-session sweep in `worktree-teardown.ts`
  (#11960) — `src/main/orch/mission-runtime-termination.ts` keeps the
  physical-exit-before-replacement invariant strict for mission authority.

Provenance ledger: `third_party/provenance/orca-f352b6b-runtime-remote.json`.
License text: `third_party/licenses/orca-MIT.txt`.
