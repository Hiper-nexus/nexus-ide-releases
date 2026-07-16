// Vendored/derived from can1357/oh-my-pi@03c48d073 (MIT)
/**
 * Acesso tipado ao recorte vendorado do catálogo do oh-my-pi
 * (`models-rich.json`, gerado por scripts/vendor-omp-catalog.mjs — ver
 * README.md ao lado para origem/licença/re-sync).
 *
 * Camada read-only: preço (USD/MTok), contextWindow, maxTokens e capacidades
 * por `provider omp → modelId`. A resolução fuzzy fica aqui porque deriva do
 * vocabulário de identidade do omp (markers/datas de snapshot); o mapeamento
 * adapter Nexus → provider omp fica em src/main/adapters/model-catalog.ts.
 */
import modelsRichRaw from './models-rich.json';
import { stripTrailingMarker } from './identity';

/** Preço em USD por milhão de tokens (MTok), como no catálogo do omp. */
export interface RichModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RichModelEntry {
  id: string;
  name?: string;
  api?: string;
  cost?: RichModelCost;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

export type RichModelCatalog = Record<string, Record<string, RichModelEntry>>;

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeCost(raw: unknown): RichModelCost | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const cost: RichModelCost = {
    input: asFiniteNumber(source.input),
    output: asFiniteNumber(source.output),
    cacheRead: asFiniteNumber(source.cacheRead),
    cacheWrite: asFiniteNumber(source.cacheWrite),
  };
  return Object.values(cost).some((v) => v !== undefined) ? cost : undefined;
}

function normalizeEntry(modelId: string, raw: unknown): RichModelEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const entry: RichModelEntry = { id: modelId };
  if (typeof source.name === 'string') entry.name = source.name;
  if (typeof source.api === 'string') entry.api = source.api;
  const cost = normalizeCost(source.cost);
  if (cost) entry.cost = cost;
  const contextWindow = asFiniteNumber(source.contextWindow);
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  const maxTokens = asFiniteNumber(source.maxTokens);
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  if (typeof source.reasoning === 'boolean') entry.reasoning = source.reasoning;
  if (Array.isArray(source.input) && source.input.every((v): v is string => typeof v === 'string')) {
    entry.input = [...source.input];
  }
  return entry;
}

/** Normaliza o JSON gerado — mesma postura defensiva do model-catalog.ts. */
function normalizeCatalog(raw: unknown): RichModelCatalog {
  if (!raw || typeof raw !== 'object') return {};
  const catalog: RichModelCatalog = {};
  for (const [providerId, models] of Object.entries(raw as Record<string, unknown>)) {
    if (!models || typeof models !== 'object') continue;
    const byId: Record<string, RichModelEntry> = {};
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      const normalized = normalizeEntry(modelId, entry);
      if (normalized) byId[modelId] = normalized;
    }
    if (Object.keys(byId).length > 0) catalog[providerId] = byId;
  }
  return catalog;
}

/** Recorte vendorado, normalizado uma única vez no load do módulo. */
export const RICH_MODEL_CATALOG: RichModelCatalog = normalizeCatalog(modelsRichRaw);

/** Providers omp presentes no recorte (útil para testes/diagnóstico). */
export function richCatalogProviders(): string[] {
  return Object.keys(RICH_MODEL_CATALOG);
}

const DATE_SUFFIX_PATTERN = /^\d{8}$/;

function findCaseInsensitive(
  models: Record<string, RichModelEntry>,
  modelId: string,
): RichModelEntry | null {
  const lower = modelId.toLowerCase();
  for (const [id, entry] of Object.entries(models)) {
    if (id.toLowerCase() === lower) return entry;
  }
  return null;
}

/**
 * Expansão de snapshot: consulta `claude-sonnet-4-5` casa com a entrada
 * `claude-sonnet-4-5-20250929` (sufixo de data). Entre múltiplos snapshots,
 * vence o mais recente.
 */
function findDateSnapshot(
  models: Record<string, RichModelEntry>,
  modelId: string,
): RichModelEntry | null {
  const prefix = `${modelId.toLowerCase()}-`;
  let best: RichModelEntry | null = null;
  let bestSuffix = '';
  for (const [id, entry] of Object.entries(models)) {
    const lower = id.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const suffix = lower.slice(prefix.length);
    if (!DATE_SUFFIX_PATTERN.test(suffix)) continue;
    if (suffix > bestSuffix) {
      best = entry;
      bestSuffix = suffix;
    }
  }
  return best;
}

/**
 * Lookup fuzzy leve dentro de um provider do recorte:
 *  1. match exato / case-insensitive;
 *  2. strip iterativo de marcadores de sufixo que não mudam identidade
 *     (`-20250929`, `-thinking`, esforços) — cobre
 *     `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`;
 *  3. expansão de snapshot — `claude-sonnet-4-5` → `claude-sonnet-4-5-<data>`.
 * Sufixos que mudam identidade (`-fast`, `-air`, …) nunca são removidos.
 */
export function findRichModelInProvider(
  providerId: string,
  modelId: string,
): RichModelEntry | null {
  const models = RICH_MODEL_CATALOG[providerId];
  if (!models || modelId.length === 0) return null;

  let candidate: string | null = modelId;
  while (candidate !== null) {
    const hit = models[candidate] ?? findCaseInsensitive(models, candidate);
    if (hit) return hit;
    candidate = stripTrailingMarker(candidate);
  }

  return findDateSnapshot(models, modelId);
}
