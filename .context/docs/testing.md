# Testing

> Source-bound summary of verification scripts declared in this repository's manifests. No claims below reference files outside the bound sources.

## Root workspace (`package.json`)

- `typecheck`: `tsc --noEmit`
- `lint`: `tsc --noEmit`
- `test`: `vitest run`
- `rebuild:node`: runs `scripts/rebuild-node-natives.mjs` then `scripts/check-node-natives.mjs` as a native-module health probe.

## Server workspace (`server/package.json`)

- `typecheck`: `tsc --noEmit`
- `test`: `vitest run`
- `smoke:artifact`: `node scripts/smoke-built-server.mjs`
- `verify:artifact`: `npm run build && npm run smoke:artifact`

## Python training assets (`training/wake-ptbr/requirements.txt`)

- The file's header comment states it should be run with CPython 3.11 on macOS arm64 (this is a comment, not an enforced/pinned constraint).
- Packages (`edge-tts`, `huggingface_hub`, `numpy`, `onnx`, `onnxruntime`, `openwakeword`, `scipy`, `torch`) are used only to produce and validate a candidate ONNX model; the shipped app does not import them.
