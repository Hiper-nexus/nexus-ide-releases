# Architecture

> Source-bound structural anchors observed directly in this repository.
> Only the hashed files listed below are asserted as structural anchors.

## Bound structural anchors

- `package.json`
- `src/shared/types.ts`
- `src/main/browser/browser-artifact-store.test.ts`

No runtime topology, deployment boundary, or business behavior is asserted beyond the contents of those files.

## Selected root runtime scripts

- `typecheck`: `tsc --noEmit`
- `test`: `vitest run`
- `lint`: `tsc --noEmit`
- `start`: `node scripts/dev-start.mjs`
- `rebuild`: `npm run rebuild:electron`
- `rebuild:electron`: `electron-rebuild -f -s -w @lydell/node-pty -w better-sqlite3 -w onnxruntime-node`
- `rebuild:node`: `node scripts/rebuild-node-natives.mjs && node scripts/check-node-natives.mjs`
- `start:forge`: `electron-forge start`
