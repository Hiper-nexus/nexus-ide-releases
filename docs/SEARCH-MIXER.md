# SearchMixer

## Contract

Unified multi-source search with:

- debounce
- `AbortSignal` cancel
- generation counter (stale callbacks discarded)
- partial results
- stable ranking (score → source priority → id)
- result limit + redacted snippets

Sources: files, commands, symbols, panes, missions, agents, settings, skills, mcp_tools, workspaces, handoffs.

## Ownership

| Piece | Location |
|-------|----------|
| Types | `src/shared/search-mixer-types.ts` |
| Mixer | `src/main/search/search-mixer.ts` |
| Flag | `feature.search.mixer` |

## Error flow

- Invalid query → zod throw at boundary.
- Source failure → skip source, continue others.
- Cancel / newer generation → `cancelled: true`, no stale listener delivery.

## Limits

- Query text ≤ 512 chars
- Default limit 30 (max 100)
- Debounce default 80 ms

## Rollback

Flag off; do not register providers. No schema.

## How to test

```bash
npx vitest run src/main/search/search-mixer.test.ts
```
