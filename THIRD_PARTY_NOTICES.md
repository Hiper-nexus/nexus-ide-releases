# Third-party notices

NexusIDE includes third-party software and data. The corresponding licenses
remain with their copyright holders.

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
- `src/main/remote/e2ee-pairing.ts`
- `src/main/remote/remote-capability.ts` (Nexus scope binding; local ProjectExecutionScope authority)

License text: `third_party/licenses/orca-MIT.txt`. Provenance ledger:
`third_party/provenance/orca-143c36e.json`.

