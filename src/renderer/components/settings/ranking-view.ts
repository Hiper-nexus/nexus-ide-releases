/**
 * Conta pura da tela Comparar modelos (F-1588). Só número que existe:
 * benchmark oficial publicado ou avaliação medida pelo Nexus. Ausência de
 * número é "—" e vai para o fim da lista, nunca vira zero.
 */

import type { ModelCostTier } from '../../../shared/adapter-types';
import type {
  ModelComparisonCli,
  ModelComparisonEntry,
} from '../../../shared/eval-ranking-types';
import {
  OPERATIONAL_BAND_LABELS,
  OPERATIONAL_BANDS,
  classifyOperationalBand,
  type OperationalBand,
} from '../../../shared/model-operational-bands';

export { OPERATIONAL_BAND_LABELS, OPERATIONAL_BANDS, type OperationalBand };

export type CompareSortKey = 'score' | 'deepSWE' | 'terminalBench21' | 'swebenchVerified';

export const COMPARE_SORT_KEYS: readonly CompareSortKey[] = [
  'score',
  'deepSWE',
  'terminalBench21',
  'swebenchVerified',
];

export const COMPARE_SORT_LABELS: Readonly<Record<CompareSortKey, string>> = {
  score: 'Nota geral',
  deepSWE: 'DeepSWE',
  terminalBench21: 'Terminal-Bench 2.1',
  swebenchVerified: 'SWE-bench Verified',
};

export const COMPARE_SORT_HINTS: Readonly<Record<CompareSortKey, string>> = {
  score:
    'Média dos benchmarks publicados, em escala de 0 a 100. É a nota de qualidade que a escolha automática usa; custo, cota e tipo da tarefa também pesam.',
  deepSWE: 'DeepSWE v1.1: tarefas reais de engenharia de software, em % resolvidas.',
  terminalBench21: 'Terminal-Bench 2.1: tarefas executadas no terminal, em % resolvidas.',
  swebenchVerified: 'SWE-bench Verified: correções de issues reais verificadas, em % resolvidas.',
};

export function valueFor(entry: ModelComparisonEntry, key: CompareSortKey): number | null {
  const value = key === 'score' ? entry.score : entry.benchmarks[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Maior primeiro; sem número no fim; empate pela nota geral e depois pelo id. */
export function sortComparison(
  entries: readonly ModelComparisonEntry[],
  key: CompareSortKey,
): ModelComparisonEntry[] {
  return [...entries].sort((a, b) => {
    const va = valueFor(a, key);
    const vb = valueFor(b, key);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (vb !== va) {
      return vb - va;
    }
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    if (sb !== sa) return sb - sa;
    return a.modelId.localeCompare(b.modelId);
  });
}

/** O melhor com número naquele benchmark; `null` quando ninguém publicou. */
export function bestFor(
  entries: readonly ModelComparisonEntry[],
  key: CompareSortKey,
): ModelComparisonEntry | null {
  const [best] = sortComparison(entries, key);
  return best && valueFor(best, key) !== null ? best : null;
}

export function bandOf(entry: ModelComparisonEntry): OperationalBand {
  return classifyOperationalBand(entry);
}

/** Maior nota na faixa mais barata que tem nota: rápida, depois equilibrada. */
export function bestValuePick(
  entries: readonly ModelComparisonEntry[],
): ModelComparisonEntry | null {
  for (const band of ['fast', 'balanced'] as const) {
    const pick = bestFor(entries.filter((entry) => bandOf(entry) === band), 'score');
    if (pick) return pick;
  }
  return null;
}

export function groupByBand(
  entries: readonly ModelComparisonEntry[],
): Readonly<Record<OperationalBand, ModelComparisonEntry[]>> {
  const sorted = sortComparison(entries, 'score');
  return {
    fast: sorted.filter((entry) => bandOf(entry) === 'fast'),
    balanced: sorted.filter((entry) => bandOf(entry) === 'balanced'),
    deep: sorted.filter((entry) => bandOf(entry) === 'deep'),
  };
}

export const CLI_LABELS: Readonly<Record<ModelComparisonCli, string>> = {
  ready: 'instalada',
  disabled: 'desligada em Providers',
  missing: 'não instalada',
};

const COST_TIER_LABELS: Readonly<Record<ModelCostTier, string>> = {
  free: 'grátis',
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
  unknown: 'desconhecido',
};

export function costTierLabel(entry: Pick<ModelComparisonEntry, 'costTier'>): string {
  return entry.costTier ? COST_TIER_LABELS[entry.costTier] : 'desconhecido';
}

/** `75.2` → `75,2%`; ausente → `—`. */
export function formatPercent(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${String(value).replace('.', ',')}%`;
}

/** `97.4` → `97,4`; ausente → `—`. */
export function formatScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return String(value).replace('.', ',');
}

/** De quem são os números, em uma frase; `null` quando são do próprio modelo. */
export function originNote(entry: ModelComparisonEntry): string | null {
  const from = entry.numbersFrom;
  if (!from) return null;
  switch (entry.origin) {
    case 'variant':
      return `Números publicados para ${from}: esforço e contexto não mudam o modelo.`;
    case 'same-model':
      return `Mesmo modelo de ${from}: os números são dele.`;
    case 'predecessor':
      return `Versão nova sem número próprio: herda a nota de ${from} como piso até o fabricante publicar.`;
    default:
      return null;
  }
}

/** Selo curto ao lado do modelo quando os números não são dele. */
export function originBadge(entry: ModelComparisonEntry): string | null {
  if (entry.origin === 'predecessor') return 'nota herdada';
  if (entry.origin === 'same-model') return 'mesmo modelo';
  return null;
}

/** Só link http(s) vira âncora; nome de documento fica como texto. */
export function sourceHref(entry: Pick<ModelComparisonEntry, 'source'>): string | null {
  const source = entry.source?.trim();
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function formatGeneratedAt(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '—' : new Date(ms).toLocaleString('pt-BR');
}
