# Nexus Eval (LLM ranking)

Offline, reproducible model evaluation. Two consumers, with an honesty gate
between them:

1. `resources/model-ranking.json` → public ranking DTO (Settings + `nexus_model_ranking`)
2. `resources/model-catalog.json` → `quality` blocks (`source: nexus-eval/...`)
3. `task-router` uses quality **only** when `hasAuthoritativeModelQuality` — a
   `.../fixture` source is plumbing, not evidence. The live prior today is
   cost + specialty heuristic + operational bands (fast / balanced / deep).

`npm run eval:export-ranking` still writes the public DTO. It must not put
fixture scores back into the published catalog.

## Run offline pipeline

```bash
npm run eval:export-ranking
```

Writes ranking + merges quality into the published model catalog.

## Public API

- **In-app IPC:** `window.nexus.ranking.public()` → `PublicModelRankingSnapshot`
- **Static export:** `resources/model-ranking.json` (schemaVersion 1)
- **Types:** `src/shared/eval-ranking-types.ts`

No auth secrets are included. Safe for a future customer landing page.

## Implementation

| Module | Role |
| --- | --- |
| `src/main/eval/scorer.ts` | Per-case score |
| `src/main/eval/ranker.ts` | Dimension aggregates + overall |
| `src/main/eval/catalog-publisher.ts` | Merge quality into catalog |
| `src/main/eval/public-ranking.ts` | Public DTO builder |
| `src/main/eval/eval-pipeline.ts` | Fixture → ranks → catalog → public |
| `src/main/eval/eval-ipc.ts` | IPC read path |
| `src/main/eval/fixtures/v1-case-results.ts` | Deterministic suite v1 |

Live multi-provider agent runs can replace fixtures later; CI gates on the offline path.
