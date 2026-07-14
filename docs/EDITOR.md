# Editor

## Contract

Secure document model: hash, dirty, binary/oversize detection, workspace path guard, markdown read vs explicit edit.
**CodeMirror 6** not yet installed — formal eval: MIT license, multi-package size; install deferred until size/security sign-off. Feature flag `feature.editor.codemirror`.

## Ownership

- Model: `src/main/editor/editor-document.ts`
- UI still uses FilesPanel textarea until CM lands; model is ready for swap.

## Error flow

Binary/oversized → non-editable explain state. Path escape → throw. Silent overwrite prevented via contentHash.

## Limits

~1.5 MB / 1.2M chars.

## Migration / rollback

No schema; flag off reverts to prior FilesPanel behavior.

## Security

Workspace-only paths; no renderer direct fs.

## Metrics

Open time for 1 MB fixture (unit &lt; 2s budget).

## How to test

```bash
npx vitest run src/main/editor/editor-document.test.ts
```
