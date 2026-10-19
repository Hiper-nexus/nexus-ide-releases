/**
 * Ajustes → Comparar modelos (F-1588): a comparação que o operador vê usa a
 * MESMA régua da escolha automática (F-675) — benchmark oficial publicado,
 * ou avaliação medida pelo Nexus quando existir — sobre a oferta que esta
 * máquina realmente serve. A fixture offline (`nexus-eval/v1/fixture`, notas
 * escritas à mão para exercitar o pipeline) nunca entra aqui.
 *
 * Puro: a coleta de adapters, Providers e quarentena fica em `eval-ipc.ts`.
 */

import type { AdapterInfo, ModelCatalogEntryInfo } from '../../shared/adapter-types';
import type {
  ModelComparisonBenchmarks,
  ModelComparisonCli,
  ModelComparisonEntry,
  ModelComparisonSnapshot,
} from '../../shared/eval-ranking-types';
import { newestInModelLine } from '../../shared/model-line';
import {
  hasAuthoritativeModelQuality,
  isModelBlockedForAutoRouting,
} from '../adapters/model-catalog';
import {
  publishedEntryScore100,
  resolvePublishedBenchmark,
} from '../orch/published-benchmarks';

export interface ModelComparisonAdapter {
  readonly adapterId: string;
  readonly label: string;
  readonly cli: ModelComparisonCli;
  /** Oferta elegível: sem api-only/deprecated nem quarentena de acesso. */
  readonly models: readonly string[];
  readonly info: Readonly<Record<string, ModelCatalogEntryInfo | undefined>>;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function comparisonEntry(
  adapter: ModelComparisonAdapter,
  modelId: string,
): ModelComparisonEntry {
  const info = adapter.info[modelId];
  const base: ModelComparisonEntry = {
    id: `${adapter.adapterId}/${modelId}`,
    adapterId: adapter.adapterId,
    adapterLabel: adapter.label,
    modelId,
    cli: adapter.cli,
    ...(info?.costTier !== undefined ? { costTier: info.costTier } : {}),
    ...(info?.availability !== undefined ? { availability: info.availability } : {}),
    score: null,
    scoreKind: 'none',
    benchmarks: {},
  };

  const published = resolvePublishedBenchmark(adapter.adapterId, modelId);
  const benchmarks: ModelComparisonBenchmarks = {};
  if (published) {
    const { deepSWE, terminalBench21, swebenchVerified } = published.entry;
    if (typeof deepSWE === 'number') benchmarks.deepSWE = deepSWE;
    if (typeof terminalBench21 === 'number') benchmarks.terminalBench21 = terminalBench21;
    if (typeof swebenchVerified === 'number') benchmarks.swebenchVerified = swebenchVerified;
  }
  const publishedScore = published ? publishedEntryScore100(published.entry) : null;
  const provenance =
    published && publishedScore !== null
      ? {
          source: published.entry.source,
          origin: published.origin,
          ...(published.origin !== 'own'
            ? { numbersFrom: published.key.slice(published.key.indexOf(':') + 1) }
            : {}),
        }
      : {};

  // Mesma precedência do roteador: nexus-eval medido > benchmark publicado.
  if (hasAuthoritativeModelQuality(info) && info?.quality) {
    const q = info.quality;
    return {
      ...base,
      ...provenance,
      score: clampScore(q.overall),
      scoreKind: 'measured',
      benchmarks,
      measured: {
        overall: clampScore(q.overall),
        ...(q.coding !== undefined ? { coding: clampScore(q.coding) } : {}),
        ...(q.reasoning !== undefined ? { reasoning: clampScore(q.reasoning) } : {}),
        ...(q.frontend !== undefined ? { frontend: clampScore(q.frontend) } : {}),
        ...(q.security !== undefined ? { security: clampScore(q.security) } : {}),
        evaluatedAt: q.evaluatedAt,
      },
    };
  }
  if (publishedScore === null) return base;
  return {
    ...base,
    ...provenance,
    score: publishedScore,
    scoreKind: 'published',
    benchmarks,
  };
}

/**
 * Uma linha por modelo oferecido. A versão antiga de uma linha com versão
 * mais nova na mesma oferta sai (regra do operador: modelo mais novo sempre)
 * e só conta em `olderVersionsHidden`.
 */
export function buildModelComparison(
  adapters: readonly ModelComparisonAdapter[],
  generatedAt: string,
): ModelComparisonSnapshot {
  const entries: ModelComparisonEntry[] = [];
  const seen = new Set<string>();
  let olderVersionsHidden = 0;
  for (const adapter of adapters) {
    for (const modelId of adapter.models) {
      const id = `${adapter.adapterId}/${modelId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (newestInModelLine(modelId, adapter.models) !== modelId) {
        olderVersionsHidden += 1;
        continue;
      }
      entries.push(comparisonEntry(adapter, modelId));
    }
  }
  return { generatedAt, entries, olderVersionsHidden };
}

/**
 * Oferta que a comparação mostra (F-1588): o mesmo filtro da ferramenta dos
 * agentes (`nexus_model_ranking`, F-1230) — sem api-only/deprecated nem
 * modelo em quarentena de acesso —, mas também as CLIs desligadas ou
 * ausentes, marcadas, para o operador ver o que ganharia instalando.
 */
export function comparisonAdaptersFrom(
  adapters: readonly AdapterInfo[],
  disabled: ReadonlySet<string>,
  quarantined: (adapterId: string, model: string) => boolean,
): ModelComparisonAdapter[] {
  return adapters
    .filter((adapter) => adapter.id !== 'shell')
    .map((adapter) => {
      const info = adapter.models.info ?? {};
      return {
        adapterId: adapter.id,
        label: adapter.label,
        cli: !adapter.installed ? 'missing' : disabled.has(adapter.id) ? 'disabled' : 'ready',
        models: adapter.models.list.filter(
          (model) =>
            !isModelBlockedForAutoRouting(info[model]) && !quarantined(adapter.id, model),
        ),
        info,
      } satisfies ModelComparisonAdapter;
    })
    .filter((adapter) => adapter.models.length > 0);
}
