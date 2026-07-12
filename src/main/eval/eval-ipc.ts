/**
 * Public ranking IPC — no secrets, no user accounts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcMain } from 'electron';
import { EVAL_RANKING_CHANNELS } from '../../shared/eval-ranking-types';
import type { PublicModelRankingSnapshot } from '../../shared/eval-ranking-types';
import {
  loadModelCatalog,
  PUBLISHED_MODEL_CATALOG,
} from '../adapters/model-catalog';
import { runOfflineEvalV1 } from './eval-pipeline';
import {
  buildPublicRankingFromCatalog,
  isPublicModelRankingSnapshot,
} from './public-ranking';

function resolveBundledRankingPath(): string | null {
  // Packaged: process.resourcesPath/model-ranking.json (extraResource)
  // Dev: repo resources/model-ranking.json next to this file tree
  const candidates = [
    typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
      ? path.join(process.resourcesPath, 'model-ranking.json')
      : null,
    path.join(process.cwd(), 'resources', 'model-ranking.json'),
  ];

  try {
    candidates.push(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../resources/model-ranking.json',
      ),
    );
  } catch {
    // import.meta.url unavailable in some packaged/CJS shapes — skip.
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadBundledPublicRanking(): PublicModelRankingSnapshot | null {
  const file = resolveBundledRankingPath();
  if (!file) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPublicModelRankingSnapshot(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Prefer catalog quality (live merge of published + user),
 * fall back to bundled public JSON, then recompute from fixtures.
 */
export function getPublicModelRanking(): PublicModelRankingSnapshot {
  // loadModelCatalog already merges BUILTIN + PUBLISHED + user so ranking and
  // routeTask share the same quality truth.
  const liveCatalog = loadModelCatalog();
  const fromCatalog = buildPublicRankingFromCatalog(liveCatalog);
  if (fromCatalog.entries.length > 0) {
    return fromCatalog;
  }

  const bundled = loadBundledPublicRanking();
  if (bundled && bundled.entries.length > 0) return bundled;

  return runOfflineEvalV1(PUBLISHED_MODEL_CATALOG).publicRanking;
}

export function registerEvalRankingIpc(): void {
  // Idempotent for HMR / re-bootstrap of main process handlers.
  ipcMain.removeHandler(EVAL_RANKING_CHANNELS.publicRanking);
  ipcMain.handle(EVAL_RANKING_CHANNELS.publicRanking, () => getPublicModelRanking());
}
