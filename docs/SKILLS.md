# Skills

## Contract

Catalog of built-in/custom skills with digest lockfile, drift detection, uninstall-all + backup.
Insert/copy/attach are app-layer actions; skill content is Markdown.

## Ownership

- `src/main/skills/skills-catalog.ts`
- Mirror to agent homes: `skill-mirror.ts`
- Flag: `feature.skills.catalog`

## Error flow

Missing dir → empty catalog. Corrupt lock → null. Uninstall backs up lock first.

## Limits

Preview ≤ 4 KiB; digest SHA-256; ≤ 512 lock entries.

## Migration / rollback

Restore `skills.lock.json.*.bak`.

## Security

No automatic execution of skill content as shell; redaction on terminal insert path.

## Metrics

Drifted skill count; sync status transitions.

## How to test

```bash
npx vitest run src/main/skills/skills-catalog.test.ts
```
