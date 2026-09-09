import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Adapter,
  ModelCatalogEntryInfo,
  ModelCostTier,
  ModelInfoMap,
} from '../../shared/adapter-types';
import publishedCatalogRaw from '../../../resources/model-catalog.json';
import { CODEX_FRONTIER_MODEL } from '../../shared/model-defaults';
import { bareModelId } from '../../vendor/omp/catalog/identity';
import {
  RICH_MODEL_CATALOG,
  findRichModelInProvider,
  type RichModelEntry,
} from '../../vendor/omp/catalog/rich-models';

export interface AdapterModelCatalog {
  models?: ModelCatalogEntryInfo[];
  default?: string;
}

export interface ModelCatalog {
  version?: number;
  updatedAt?: string;
  adapters?: Record<string, AdapterModelCatalog>;
}

const NEXUS_DIR = path.join(os.homedir(), '.nexus');
export const USER_MODEL_CATALOG_FILE = path.join(NEXUS_DIR, 'model-catalog.json');
export const MODEL_CATALOG_URL_ENV = 'NEXUS_MODEL_CATALOG_URL';

/**
 * Default remote catalog (GitHub raw), same hosting pattern as the aitmpl
 * catalog in orch/catalog.ts. Override with NEXUS_MODEL_CATALOG_URL.
 *
 * Branch `catalog` hosts `resources/model-catalog.json`. For private repos
 * raw.githubusercontent.com returns 404 without auth — the app then seeds
 * from the bundled published JSON (same file, imported at build time).
 * Prefer a public URL, gist, or `file:///…/resources/model-catalog.json` for
 * local/dev refresh without GitHub auth.
 */
export const DEFAULT_MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/cleofasvolarehost/nexus-ide/catalog/resources/model-catalog.json';

/** Resolve the URL used for remote refresh (env wins, else default). */
export function resolveModelCatalogUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env[MODEL_CATALOG_URL_ENV]?.trim();
  if (!fromEnv) return DEFAULT_MODEL_CATALOG_URL;
  // Absolute path → file URL so refresh can read without HTTP.
  if (fromEnv.startsWith('/') || /^[A-Za-z]:[\\/]/.test(fromEnv)) {
    return pathToFileURL(fromEnv).href;
  }
  return fromEnv;
}

const COST_RANK: Record<ModelCostTier, number> = {
  free: 0,
  low: 1,
  unknown: 2,
  medium: 3,
  high: 4,
};

export const BUILTIN_MODEL_CATALOG: ModelCatalog = {
  version: 1,
  adapters: {
    claude: {
      models: [
        { id: 'claude-opus-5', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'claude-fable-5-1', availability: 'paid', costTier: 'high', source: 'bundled' },
        {
          id: 'claude-mythos-5-1',
          availability: 'api-only',
          costTier: 'high',
          source: 'bundled',
          warning:
            'Trusted-access only: not used for automatic routing unless the user selects it manually.',
        },
        {
          id: 'claude-fable-5',
          availability: 'api-only',
          costTier: 'high',
          source: 'bundled',
          warning:
            'API-only/high-cost: not used for automatic routing unless the user selects it manually.',
        },
        { id: 'claude-opus-4-8', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'claude-sonnet-5', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'claude-haiku-4-5', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    codex: {
      default: CODEX_FRONTIER_MODEL,
      models: [
        {
          id: 'gpt-6-astra',
          availability: 'api-only',
          costTier: 'high',
          source: 'bundled',
          warning:
            'Trusted-access rollout (2026-09-03): not used for automatic routing unless the user selects it manually.',
        },
        { id: 'gpt-5.6-sol', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gpt-5.6-terra', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gpt-5.6-luna', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'gpt-5.5', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gpt-5.4', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'gpt-5.4-mini', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    grok: {
      default: 'grok-4.6',
      models: [
        { id: 'grok-4.6', availability: 'paid', costTier: 'high', source: 'bundled' },
        {
          id: 'grok-4.5',
          availability: 'paid',
          costTier: 'high',
          source: 'bundled',
          warning: 'New xAI model; verify tier/pricing before making it the default.',
        },
        { id: 'grok-4.1', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'grok-4-fast', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'grok-code-fast-1', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    glm: {
      default: 'glm-5.3',
      models: [
        { id: 'glm-5.3', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'glm-5.3-flash', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'glm-5.2', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'glm-4.7', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'glm-4.5-air', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    agy: {
      default: 'gemini-3.7-flash-high',
      models: [
        { id: 'gemini-3.7-flash-low', availability: 'free', costTier: 'free', source: 'bundled' },
        { id: 'gemini-3.7-flash-medium', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.7-flash-high', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.6-flash-low', availability: 'free', costTier: 'free', source: 'bundled' },
        { id: 'gemini-3.6-flash-medium', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.6-flash-high', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.5-flash-low', availability: 'free', costTier: 'free', source: 'bundled' },
        { id: 'gemini-3.5-flash-medium', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.5-flash-high', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.1-pro-high', availability: 'paid', costTier: 'medium', source: 'bundled' },
      ],
    },
    kimi: {
      models: [
        { id: 'kimi-code/k3', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'kimi-code/kimi-for-coding-highspeed', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'kimi-code/kimi-for-coding', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    longcat: {
      models: [
        { id: 'LongCat-2.0', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
  },
};

let cachedCatalog: ModelCatalog | null = null;

function safeModels(models: unknown, source: string): ModelCatalogEntryInfo[] {
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Partial<ModelCatalogEntryInfo>;
    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return [];
    const qualityRaw = raw.quality;
    const score = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
        ? value
        : undefined;
    const overall = score(qualityRaw?.overall);
    const quality =
      qualityRaw &&
      overall !== undefined &&
      typeof qualityRaw.evaluatedAt === 'string' &&
      !Number.isNaN(Date.parse(qualityRaw.evaluatedAt)) &&
      typeof qualityRaw.source === 'string' &&
      /^nexus-eval\/[A-Za-z0-9._/-]{1,120}$/.test(qualityRaw.source.trim())
        ? {
            overall,
            coding: score(qualityRaw.coding),
            reasoning: score(qualityRaw.reasoning),
            frontend: score(qualityRaw.frontend),
            security: score(qualityRaw.security),
            evaluatedAt: qualityRaw.evaluatedAt,
            source: qualityRaw.source.trim(),
          }
        : undefined;
    return [
      {
        id: raw.id.trim(),
        availability: raw.availability,
        costTier: raw.costTier,
        source: raw.source ?? source,
        warning: raw.warning,
        // Omit when invalid — explicit `quality: undefined` would wipe published
        // scores during mergeModelCatalogs ({ ...prev, ...overlay }).
        ...(quality ? { quality } : {}),
      },
    ];
  });
}

function normaliseCatalog(raw: unknown, source: string): ModelCatalog {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as ModelCatalog;
  const adapters: Record<string, AdapterModelCatalog> = {};
  for (const [adapterId, value] of Object.entries(input.adapters ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const models = safeModels((value as AdapterModelCatalog).models, source);
    const defaultModel =
      typeof (value as AdapterModelCatalog).default === 'string'
        ? (value as AdapterModelCatalog).default
        : undefined;
    if (models.length > 0 || defaultModel) {
      adapters[adapterId] = { models, default: defaultModel };
    }
  }
  return {
    version: typeof input.version === 'number' ? input.version : undefined,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : undefined,
    adapters,
  };
}

/** In-repo published catalog (resources/model-catalog.json), bundled at build. */
export const PUBLISHED_MODEL_CATALOG: ModelCatalog = normaliseCatalog(
  publishedCatalogRaw,
  'remote',
);

export function mergeModelCatalogs(base: ModelCatalog, overlay: ModelCatalog): ModelCatalog {
  const adapters: Record<string, AdapterModelCatalog> = {};
  const ids = new Set([
    ...Object.keys(base.adapters ?? {}),
    ...Object.keys(overlay.adapters ?? {}),
  ]);

  for (const adapterId of ids) {
    const baseAdapter = base.adapters?.[adapterId] ?? {};
    const overlayAdapter = overlay.adapters?.[adapterId] ?? {};
    const byId = new Map<string, ModelCatalogEntryInfo>();
    for (const entry of baseAdapter.models ?? []) byId.set(entry.id, entry);
    for (const entry of overlayAdapter.models ?? []) {
      const prev = byId.get(entry.id);
      const merged: ModelCatalogEntryInfo = { ...prev, ...entry, id: entry.id };
      // Preserve nexus-eval quality when overlay only carries cost/availability.
      if (entry.quality === undefined && prev?.quality) {
        merged.quality = prev.quality;
      }
      byId.set(entry.id, merged);
    }
    adapters[adapterId] = {
      models: [...byId.values()],
      default: overlayAdapter.default ?? baseAdapter.default,
    };
  }

  return {
    version: overlay.version ?? base.version,
    updatedAt: overlay.updatedAt ?? base.updatedAt,
    adapters,
  };
}

export function invalidateModelCatalogCache(): void {
  cachedCatalog = null;
}

export function loadUserModelCatalog(file = USER_MODEL_CATALOG_FILE): ModelCatalog {
  try {
    return normaliseCatalog(JSON.parse(fs.readFileSync(file, 'utf8')), 'local');
  } catch {
    return {};
  }
}

/**
 * Live catalog for routing, provider UI, and public ranking.
 *
 * Layers (later wins per-field; absent fields keep earlier values):
 *   1. BUILTIN — code defaults
 *   2. PUBLISHED — shipped resources/model-catalog.json (nexus-eval quality)
 *   3. USER — ~/.nexus/model-catalog.json or caller path
 *
 * Including PUBLISHED is required so routeTask sees nexus-eval quality even when
 * a legacy user catalog has cost/availability only (no quality blocks).
 */
export function loadModelCatalog(file = USER_MODEL_CATALOG_FILE): ModelCatalog {
  if (file === USER_MODEL_CATALOG_FILE && cachedCatalog) return cachedCatalog;
  const withPublished = mergeModelCatalogs(
    BUILTIN_MODEL_CATALOG,
    PUBLISHED_MODEL_CATALOG,
  );
  const catalog = mergeModelCatalogs(withPublished, loadUserModelCatalog(file));
  if (file === USER_MODEL_CATALOG_FILE) cachedCatalog = catalog;
  return catalog;
}

function writeCatalogFile(catalog: ModelCatalog, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2));
  invalidateModelCatalogCache();
}

/**
 * Seed ~/.nexus/model-catalog.json from the bundled published catalog when
 * missing (or when force=true). Used so this machine picks up grok-4.5 /
 * fable api-only without waiting on a public CDN.
 */
export function seedLocalModelCatalogFromPublished(
  file = USER_MODEL_CATALOG_FILE,
  force = false,
): boolean {
  if (!force && fs.existsSync(file)) return false;
  if (Object.keys(PUBLISHED_MODEL_CATALOG.adapters ?? {}).length === 0) return false;
  writeCatalogFile(PUBLISHED_MODEL_CATALOG, file);
  return true;
}

function loadCatalogFromLocalPath(filePath: string): ModelCatalog | null {
  try {
    return normaliseCatalog(JSON.parse(fs.readFileSync(filePath, 'utf8')), 'remote');
  } catch (err) {
    console.warn('[model-catalog] local path load failed:', err);
    return null;
  }
}

async function loadCatalogFromUrl(url: string): Promise<ModelCatalog | null> {
  if (url.startsWith('file://')) {
    return loadCatalogFromLocalPath(fileURLToPath(url));
  }
  // Absolute filesystem path (dev convenience: NEXUS_MODEL_CATALOG_URL=/path/to.json)
  if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) {
    return loadCatalogFromLocalPath(url);
  }

  if (!globalThis.fetch) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'nexus-ide' },
    });
    if (!res.ok) return null;
    return normaliseCatalog(await res.json(), 'remote');
  } catch (err) {
    console.warn('[model-catalog] remote refresh failed:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshRemoteModelCatalog(
  url = resolveModelCatalogUrl(),
  file = USER_MODEL_CATALOG_FILE,
): Promise<boolean> {
  if (!url) return false;

  let json = await loadCatalogFromUrl(url);

  // Private GitHub raw → 404. Seed only a missing catalog; never replace a
  // newer local/CLI-discovered catalog with the older bundled snapshot.
  if (
    (!json || Object.keys(json.adapters ?? {}).length === 0) &&
    url === DEFAULT_MODEL_CATALOG_URL &&
    !fs.existsSync(file)
  ) {
    json = PUBLISHED_MODEL_CATALOG;
  }

  if (!json || Object.keys(json.adapters ?? {}).length === 0) return false;
  writeCatalogFile(json, file);
  return true;
}

export function modelCatalogInfo(
  catalog: ModelCatalog,
  adapterId: string,
  modelId: string | undefined,
): ModelCatalogEntryInfo | null {
  if (!modelId) return null;
  const entries = catalog.adapters?.[adapterId]?.models ?? [];
  return (
    entries.find((entry) => entry.id === modelId) ??
    entries.find((entry) => entry.id.toLowerCase() === modelId.toLowerCase()) ??
    null
  );
}

export function isModelBlockedForAutoRouting(
  info: ModelCatalogEntryInfo | null | undefined,
): boolean {
  return info?.availability === 'api-only' || info?.availability === 'deprecated';
}

/**
 * Only measured/published Nexus evaluations may influence automatic rank.
 * `fixture` scores exercise catalog plumbing and may ship in dev/test
 * overlays, but they are not evidence about model quality.
 */
export function hasAuthoritativeModelQuality(
  info: ModelCatalogEntryInfo | null | undefined,
): boolean {
  const quality = info?.quality;
  if (!quality) return false;
  const sourceSegments = quality.source.toLowerCase().split(/[\/._-]+/);
  return !sourceSegments.includes('fixture');
}

export function modelRoutingRank(info: ModelCatalogEntryInfo | null | undefined): number {
  if (!info) return COST_RANK.unknown;
  if (isModelBlockedForAutoRouting(info)) return Number.POSITIVE_INFINITY;
  if (info.costTier) return COST_RANK[info.costTier];
  switch (info.availability) {
    case 'free':
      return COST_RANK.free;
    case 'cheap':
      return COST_RANK.low;
    case 'paid':
      return COST_RANK.high;
    default:
      return COST_RANK.unknown;
  }
}

/**
 * Auth-aware routing rank (herança Orca: a sessão nativa de cada CLI é o
 * juiz). Um modelo sem auth pronta nunca vence — retorna +Infinity para
 * tirá-lo da rota automática sem mexer no rank de custo dos demais.
 */
export function modelRoutingRankWithAuth(
  info: ModelCatalogEntryInfo | null | undefined,
  isAuthReady: boolean,
): number {
  if (!isAuthReady) return Number.POSITIVE_INFINITY;
  return modelRoutingRank(info);
}

export function applyModelCatalogToAdapter(adapter: Adapter, catalog: ModelCatalog): Adapter {
  const adapterCatalog = catalog.adapters?.[adapter.id];
  if (!adapterCatalog) return adapter;

  const list = [...adapter.models.list];
  for (const entry of adapterCatalog.models ?? []) {
    if (!list.includes(entry.id)) list.push(entry.id);
  }

  const requestedDefault = adapterCatalog.default ?? adapter.models.default;
  const defaultInfo = modelCatalogInfo(catalog, adapter.id, requestedDefault);
  const defaultModel = isModelBlockedForAutoRouting(defaultInfo)
    ? (list.find((model) => !isModelBlockedForAutoRouting(modelCatalogInfo(catalog, adapter.id, model))) ??
      requestedDefault)
    : requestedDefault;

  return {
    ...adapter,
    models: {
      ...adapter.models,
      list,
      default: defaultModel,
    },
  };
}

export function modelInfoForAdapter(
  catalog: ModelCatalog,
  adapterId: string,
  models: readonly string[],
): ModelInfoMap {
  const info: ModelInfoMap = {};
  for (const model of models) {
    const entry = modelCatalogInfo(catalog, adapterId, model);
    if (entry) info[model] = entry;
  }
  return info;
}

// ---------------------------------------------------------------------------
// Metadados ricos (recorte vendorado do oh-my-pi — src/vendor/omp/catalog/)
//
// Camada ADITIVA e read-only: resolve preço USD/MTok, contextWindow, maxTokens
// e capacidades a partir do catálogo vendorado. Não participa (nem altera) o
// schema availability/costTier acima — quem roteia continua usando o
// ModelCatalog em camadas; isto é fonte de verdade complementar para UI/custo.
//
// PENDÊNCIA (renderer): o único canal de catálogo hoje é adapter:list →
// AdapterInfo[], cujo models.info usa o schema compartilhado
// ModelCatalogEntryInfo — expor o metadado rico exigiria mudar esse schema.
// Por ora a função fica pronta no main; expor via IPC é entrega futura.
// ---------------------------------------------------------------------------

/** Metadado rico resolvido + provider do catálogo de origem. */
export interface RichModelMetadata extends RichModelEntry {
  /** Provider do catálogo que forneceu o metadado (ex.: 'anthropic', 'xai'). */
  catalogProvider: string;
}

/**
 * Adapter Nexus → providers de catálogo candidatos, em ordem de preferência.
 */
const CATALOG_PROVIDERS_BY_ADAPTER: Record<string, readonly string[]> = {
  claude: ['anthropic'],
  codex: ['openai-codex', 'openai'],
  glm: ['zai', 'zhipu-coding-plan'],
  kimi: ['kimi-code', 'moonshot'],
  grok: ['xai'],
  // agy expõe gemini-* e também claude-*-thinking — anthropic entra como
  // fallback para o strip de `-thinking` resolver preço/janela.
  agy: ['google-gemini-cli', 'google', 'anthropic'],
};

function toRichMetadata(catalogProvider: string, entry: RichModelEntry): RichModelMetadata {
  return { ...entry, catalogProvider };
}

/**
 * Resolve metadados ricos (preço, janela, capacidades) para um modelo de um
 * adapter Nexus. Fuzzy leve por provider (case-insensitive, strip de sufixo de
 * data/thinking/esforço, expansão de snapshot) — ver
 * src/vendor/omp/catalog/rich-models.ts. Retorna null quando o modelo não
 * existe no recorte vendorado.
 */
export function getRichModelMetadata(
  adapterId: string,
  modelId: string | undefined,
): RichModelMetadata | null {
  if (!modelId) return null;
  const trimmed = modelId.trim();
  if (trimmed.length === 0) return null;

  // 1. Prefixo `provider/` explícito: resolve direto no provider indicado.
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    if (RICH_MODEL_CATALOG[prefix]) {
      const entry = findRichModelInProvider(prefix, trimmed.slice(slash + 1));
      if (entry) return toRichMetadata(prefix, entry);
    }
  }

  // 2. Cadeia de providers do adapter, com o id como veio e como "bare"
  //    (sem namespace) quando o prefixo não é um provider do recorte.
  const bare = bareModelId(trimmed);
  for (const providerId of CATALOG_PROVIDERS_BY_ADAPTER[adapterId] ?? []) {
    const entry =
      findRichModelInProvider(providerId, trimmed) ??
      (bare !== trimmed ? findRichModelInProvider(providerId, bare) : null);
    if (entry) return toRichMetadata(providerId, entry);
  }

  return null;
}
