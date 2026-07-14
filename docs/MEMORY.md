# Memory (`.nexus-memory/`)

## Contract

Local-first Markdown notes under configurable `.nexus-memory/` with `[[wikilinks]]`, search, backlinks, decision/mission/agent kinds. Integrates with knowledge services without hiding files.

## Ownership

- `src/main/memory/nexus-memory.ts`
- Jarvis facts: `jarvis-memory.ts` / `memory_entries` (complementary)
- Flag: `feature.memory.nexusMemory`

## Error flow

Flag off → remember throws. Path escape → throw. Corrupt files skipped in list.

## Limits

Body ≤ 64 KiB; file mode 0600; root must stay under project.

## Migration / rollback

Plain Markdown files — delete or restore with VCS; no mandatory server.

## Security

Command redaction on write; no secrets in paths logged.

## Metrics

Notes written; search hits; wikilink completions.

## How to test

```bash
npx vitest run src/main/memory/nexus-memory.test.ts
```
