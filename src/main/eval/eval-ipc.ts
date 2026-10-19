/**
 * Public ranking IPC — no secrets, no user accounts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcMain } from 'electron';
import { handleTrusted } from '../security/trusted-ipc';
import { EVAL_RANKING_CHANNELS } from '../../shared/eval-ranking-types';
import type {
  ModelComparisonSnapshot,
  PublicModelRankingSnapshot,
} from '../../shared/eval-ranking-types';
import {
  loadModelCatalog,
  PUBLISHED_MODEL_CATALOG,
} from '../adapters/model-catalog';
import { runOfflineEvalV1 } from './eval-pipeline';
import { buildModelComparison, comparisonAdaptersFrom } from './model-comparison';
import {
  buildPublicRankingFromCatalog,
  dedupeRankingEntries,
  isPublicModelRankingSnapshot,
  withFixtureEstimateMark,
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
    if (!isPublicModelRankingSnapshot(raw)) return null;
    // Bundled files predating the estimate mark get stamped on load, so the
    // served payload never lets fixture scores pose as a real audit.
    // Dedupe também: arquivos empacotados podem carregar resíduo de régens
    // (duas entradas com o mesmo id quebram a key da corrida no renderer).
    return {
      ...raw,
      entries: dedupeRankingEntries(raw.entries.map(withFixtureEstimateMark)),
    };
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

export async function getModelComparison(): Promise<ModelComparisonSnapshot> {
  const [{ listAdapterInfos }, { modelAccessQuarantine }] = await Promise.all([
    import('../adapters/adapter-registry'),
    import('../orch/model-access-quarantine'),
  ]);
  let disabled = new Set<string>();
  try {
    const { listProviderSettings } = await import('../persistence/provider-config-store');
    disabled = new Set(
      listProviderSettings({ nonBlockingAuth: true })
        .filter((provider) => !provider.enabled)
        .map((provider) => provider.adapterId),
    );
  } catch {
    // Postura de Providers ilegível: só a instalação decide o estado da CLI.
  }
  return buildModelComparison(
    comparisonAdaptersFrom(
      listAdapterInfos(),
      disabled,
      (adapterId, model) => modelAccessQuarantine(adapterId, model) !== null,
    ),
    new Date().toISOString(),
  );
}

export function registerEvalRankingIpc(): void {
  // Idempotent for HMR / re-bootstrap of main process handlers.
  ipcMain.removeHandler(EVAL_RANKING_CHANNELS.publicRanking);
  ipcMain.handle(EVAL_RANKING_CHANNELS.publicRanking, () => getPublicModelRanking());
  ipcMain.removeHandler(EVAL_RANKING_CHANNELS.modelComparison);
  handleTrusted(EVAL_RANKING_CHANNELS.modelComparison, () => getModelComparison());
}
