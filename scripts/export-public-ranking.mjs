#!/usr/bin/env node
/**
 * Export public LLM ranking + seed quality blocks into resources/model-catalog.json.
 * Usage: node --import tsx scripts/export-public-ranking.mjs
 * Safe for landing pages: no secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { runOfflineEvalV1 } = await import('../src/main/eval/eval-pipeline.ts');
const { PUBLISHED_MODEL_CATALOG, mergeModelCatalogs } = await import(
  '../src/main/adapters/model-catalog.ts'
);

const result = runOfflineEvalV1(PUBLISHED_MODEL_CATALOG);
const rankingPath = path.join(root, 'resources', 'model-ranking.json');
const catalogPath = path.join(root, 'resources', 'model-catalog.json');

fs.writeFileSync(rankingPath, `${JSON.stringify(result.publicRanking, null, 2)}\n`);

// Merge quality into the published catalog JSON file (preserve non-eval fields).
const existing = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const merged = mergeModelCatalogs(existing, result.catalogOverlay);
// Keep file-friendly shape: adapters with models arrays only
const out = {
  version: existing.version ?? 1,
  updatedAt: result.publicRanking.generatedAt,
  adapters: {},
};
for (const [adapterId, adapter] of Object.entries(merged.adapters ?? {})) {
  out.adapters[adapterId] = {
    ...(existing.adapters?.[adapterId]?.default
      ? { default: existing.adapters[adapterId].default }
      : {}),
    models: (adapter.models ?? []).map((m) => {
      const clean = { id: m.id };
      if (m.availability) clean.availability = m.availability;
      if (m.costTier) clean.costTier = m.costTier;
      if (m.source) clean.source = m.source;
      if (m.warning) clean.warning = m.warning;
      if (m.quality) clean.quality = m.quality;
      return clean;
    }),
  };
}
fs.writeFileSync(catalogPath, `${JSON.stringify(out, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      rankingPath,
      catalogPath,
      models: result.publicRanking.entries.length,
      top: result.publicRanking.entries.slice(0, 3).map((e) => ({
        id: e.id,
        overall: e.overall,
      })),
    },
    null,
    2,
  ),
);
