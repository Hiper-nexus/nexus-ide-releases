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

- The file's header comment states it should be run with CPython 3.11 on macOS arm64, and that the app itself does not import these packages (they only produce and validate a candidate ONNX).
- Declared packages: `edge-tts==6.1.12`, `huggingface_hub>=0.24,<1`, `numpy>=1.26,<2`, `onnx>=1.16,<2`, `onnxruntime==1.19.2`, `openwakeword==0.6.0`, `scipy>=1.11,<2`, `torch>=2.5,<2.7` — a mix of exact pins and version ranges.
