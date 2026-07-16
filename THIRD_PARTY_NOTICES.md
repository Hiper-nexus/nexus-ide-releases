# Third-party notices

NexusIDE includes third-party software and data. The corresponding licenses
remain with their copyright holders.

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
- `src/main/adapters/omp-rpc-*.ts` — RPC mode frame types (derived; omp binary is consumed as an external
  user-installed process and is NEVER redistributed with Nexus — upstream binary embeds AGPL-3.0 mupdf)

License text: `third_party/licenses/oh-my-pi-MIT.txt`. Provenance ledger:
`third_party/provenance/oh-my-pi-03c48d0.json`. Vendoring policy: pinned copy,
never a live npm dependency; `src/markit`/mupdf-adjacent code excluded.

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

## Impeccable (pbakaus/impeccable) — frontend visual audit skill

NexusIDE bundles the complete `impeccable` design and visual audit skill, copied from [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) at commit `8259c28209b92792005cec14dad573df39f68eaf`. Copyright remains with the Impeccable contributors. The skill files are distributed under the Apache License 2.0.

The Apache License 2.0 text and original third-party notices are included at `assets/skills/impeccable/LICENSE` and `assets/skills/impeccable/NOTICE.md`, and are mirrored to the client's local runtime skill folder upon bootstrap.

The Apache License 2.0 text is also included at `third_party/licenses/Apache-2.0.txt`.
