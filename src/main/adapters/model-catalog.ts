// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só modelCatalogReferenceErrors e o portão do refreshRemoteModelCatalog — porte de hasValidProviderCatalogReferences/resolveProviderCatalog (ModelManifest.ts:99-128, 152-194: ids únicos e default presente na lista) e da regra de refresh (ModelManifest.ts:378-421: dado inválido ou edição mais velha nunca substitui a última versão boa), no formato de catálogo em camadas do Nexus; o restante do arquivo é do Nexus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Adapter,
  ModelCatalogEntryInfo,
  ModelCostTier,
  ModelInfoMap,
} from '../../shared/adapter-types';
import publishedCatalogRaw from '../../../resources/model-catalog.json';
import { MIMO_CODE_DEFAULT_MODEL, MIMO_CODE_MODEL_IDS } from '../../shared/mimo-models';
import { CODEX_FRONTIER_MODEL, GROK_FRONTIER_MODEL, migrateModelId } from '../../shared/model-defaults';
import { bareModelId } from '../../vendor/omp/catalog/identity';
import { modelListAuthority } from './model-availability';
import { withClaudeModelProfile } from './claude-model-profiles';
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
  'https://raw.githubusercontent.com/Hiper-nexus/nexus-ide-releases/catalog/resources/model-catalog.json';

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

/** Esforços que todo modelo do Muse aceita (`reasoning_effort_variants`, F-1391). */
const MUSE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export const BUILTIN_MODEL_CATALOG: ModelCatalog = {
  version: 1,
  adapters: {
    claude: {
      default: 'claude-sonnet-5-5',
      models: [
        { id: 'claude-opus-5-5', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'claude-opus-5', availability: 'paid', costTier: 'high', source: 'bundled' },
        // Roda pela assinatura (`claude -p --model claude-fable-5-1`, 2026-09-27):
        // Max/Team Premium, até 50% da cota semanal; fora do Pro.
        {
          id: 'claude-fable-5-1',
          availability: 'paid',
          costTier: 'high',
          source: 'bundled',
          warning: 'Assinatura Max: até 50% da cota semanal (não incluso no Pro) — rota automática só em revisão cruzada e fallback do crítico.',
        },
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
        {
          id: 'claude-sonnet-5-5', availability: 'paid', costTier: 'medium', source: 'bundled',
        },
        { id: 'claude-sonnet-5', availability: 'paid', costTier: 'medium', source: 'bundled' },
        // Haiku 5.5 (anthropic.com/claude/haiku, 2026-10-07): o barato da linha
        // 5 e o padrão do rotineiro; o 4.5 segue listado enquanto a CLI o oferece.
        // Manifesto T3 26285ab (07/10): current, Claude Code >= 2.1.293 — e
        // 81 turnos reais na 2.1.293 dos panes. Abaixo disso só avisa (F-992).
        { id: 'claude-haiku-5-5', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'claude-haiku-4-5', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    codex: {
      default: CODEX_FRONTIER_MODEL,
      models: [
        // models_cache do Codex 0.159.0 (29/09): "latest workhorse model".
        { id: 'gpt-6.1-sol', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gpt-6-sol', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gpt-6-luna', availability: 'paid', costTier: 'medium', source: 'bundled' },
        // ~/.codex/models_cache.json (2026-09-27) lista o Astra como visível
        // na conta — o rollout trusted-access acabou; roda pela assinatura do
        // Codex (gasta a mesma cota, mais rápido). Topo da OpenAI: fora da
        // rota automática geral desde o F-700 — exceção: a lane visual do
        // F-227 (UI/design) e pedidos pelo nome.
        {
          id: 'gpt-6-astra',
          availability: 'paid',
          costTier: 'high',
          source: 'bundled',
          warning: 'Topo da OpenAI, caro: gasta a cota do Codex mais rápido — fora da rota automática geral; entra em UI/design (lane visual) ou quando pedido pelo nome.',
        },
        { id: 'gpt-5.6-sol', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gpt-5.6-terra', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gpt-5.6-luna', availability: 'paid', costTier: 'medium', source: 'bundled' },
        // Codex 0.163.0 (models_cache, 16/10): visível, especialidade cyber.
        // Sem nota publicada — fica fora da tabela de rota.
        {
          id: 'gpt-daybreak-blue-latest',
          availability: 'paid',
          costTier: 'high',
          source: 'bundled',
          warning: 'Modelo cyber do Codex 0.163.0 (models_cache). Sem nota publicada — não entra na tabela de rota.',
        },
      ],
    },
    'mimo-code': {
      default: MIMO_CODE_DEFAULT_MODEL,
      models: MIMO_CODE_MODEL_IDS.map(id => ({ id, availability: id.endsWith('ultraspeed') ? 'api-only' : 'paid', costTier: id.endsWith('ultraspeed') ? 'high' : 'low', source: 'bundled' })),
    },
    // MiniMax Code (`mcode`, Token Plan). O mais novo vem primeiro e é o
    // padrão (regra do operador, 29/09): o M3.1 Flash Preview roda na
    // assinatura dentro do MiniMax Code, sem preço por token.
    'minimax-code': {
      default: 'minimax/MiniMax-M3.1-Flash-Preview',
      models: [
        { id: 'minimax/MiniMax-M3.1-Flash-Preview', availability: 'paid', costTier: 'low', source: 'bundled' },
        { id: 'minimax/MiniMax-M3', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'minimax/MiniMax-M2.7-highspeed', availability: 'paid', costTier: 'low', source: 'bundled' },
        { id: 'minimax/MiniMax-M2.7', availability: 'paid', costTier: 'low', source: 'bundled' },
      ],
    },
    grok: {
      default: GROK_FRONTIER_MODEL,
      // `grok models` na CLI instalada (2026-09-27) só lista estes quatro —
      // xAI aposentou 4.1/4/4-fast/code-fast-1/3 (RETIRED_MODEL_MIGRATIONS
      // remapeia panes/squads antigos que ainda pedirem esses ids).
      models: [
        { id: GROK_FRONTIER_MODEL, availability: 'paid', costTier: 'high', source: 'bundled' },
        {
          id: 'grok-4.7-build-fast',
          availability: 'paid',
          costTier: 'high',
          source: 'bundled',
          warning: 'Variante fast do 4.7 — 2x o preço, não é opção barata.',
        },
        { id: 'grok-4.6', availability: 'paid', costTier: 'high', source: 'bundled' },
        {
          id: 'grok-4.5',
          availability: 'paid',
          costTier: 'high',
          source: 'bundled',
          warning: 'New xAI model; verify tier/pricing before making it the default.',
        },
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
    'glm-flash': {
      default: 'glm-5.3-flash[1m]',
      models: [
        // F-1412 (operador, 12/10): o GLM 5.3 Flash TEM visão (entrada de
        // imagem) — "Flash com visão e mais rápido, porém menos capaz". O glm
        // 5.3 base é text-only no recorte vendorado (zai: input ["text"]).
        { id: 'glm-5.3-flash[1m]', availability: 'cheap', costTier: 'low', source: 'bundled', vision: true },
        { id: 'glm-5.3-flash', availability: 'cheap', costTier: 'low', source: 'bundled', vision: true },
        { id: 'glm-4.7-flash[1m]', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'glm-4.7-flash', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    agy: {
      // Gemini mais recente com reasoning high — doutrina do produto: o agy
      // abre sempre na geração mais nova (2026-09-19, dono do produto).
      default: 'gemini-3.8-flash-high',
      models: [
        { id: 'gemini-3.8-flash-high', availability: 'cheap', costTier: 'high', source: 'bundled' },
        { id: 'gemini-3.8-flash-medium', availability: 'cheap', costTier: 'medium', source: 'bundled' },
        { id: 'gemini-3.8-flash-low', availability: 'cheap', costTier: 'low', source: 'bundled' },
        // 3.7/3.6 saíram do `agy models` 1.4.0 e do catálogo publicado (o
        // manifesto não oferece). Ficam aqui só para a chave de benchmark.
        { id: 'gemini-3.7-flash-low', availability: 'free', costTier: 'free', source: 'bundled' },
        { id: 'gemini-3.7-flash-medium', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.7-flash-high', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.6-flash-low', availability: 'free', costTier: 'free', source: 'bundled' },
        { id: 'gemini-3.6-flash-medium', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'gemini-3.6-flash-high', availability: 'cheap', costTier: 'low', source: 'bundled' },
        // Gemini 4 Argon sem sufixo: F-990, metadado. O AGY 1.4.0 lista só
        // as variantes com esforço; o catálogo não acrescenta id a CLI que lista.
        { id: 'gemini-4-argon', availability: 'paid', costTier: 'high', source: 'bundled' },
        // AGY 1.4.0 (16/10) lista o Argon com sufixo de esforço.
        { id: 'gemini-4-argon-high', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gemini-4-argon-medium', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'gemini-4-argon-low', availability: 'paid', costTier: 'high', source: 'bundled' },
      ],
    },
    kimi: {
      default: 'kimi-code/k3',
      models: [
        { id: 'kimi-code/k3', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'kimi-k2.8', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'kimi-code/kimi-for-coding-highspeed', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'kimi-code/kimi-for-coding', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    devin: {
      default: 'swe-2-high',
      models: [
        // Pedido do operador (12/10): SWE-2 tem custo e limites bons — incluso
        // no plano Devin (docs/models/estudo-2026-09.md) e $3,50/$17,50 por 1M
        // (pricing.ts), a faixa do K3 ($3/$15, medium). 'high' o tirava do
        // "escritor econômico elegível" do hard.
        { id: 'swe-2-high', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'swe-2-max', availability: 'paid', costTier: 'high', source: 'bundled' },
        { id: 'swe-2-medium', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'claude-sonnet-5-medium', availability: 'paid', costTier: 'medium', source: 'bundled' },
      ],
    },
    longcat: {
      models: [
        { id: 'LongCat-2.0', availability: 'cheap', costTier: 'low', source: 'bundled' },
      ],
    },
    deepseek: {
      default: 'deepseek-v4-pro',
      models: [
        { id: 'deepseek-v4-pro', availability: 'paid', costTier: 'low', source: 'bundled' },
        { id: 'deepseek-flash', availability: 'cheap', costTier: 'free', source: 'bundled' },
      ],
    },
    qwen: {
      // Catálogo vivo vem do settings.json do operador (F-238); estes são os
      // ids seed do adapter, usados como fallback e priors de custo.
      default: 'qwen3.8-max',
      models: [
        { id: 'qwen3.8-max', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'qwen3.8-max-preview', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'qwen3.7-max', availability: 'paid', costTier: 'medium', source: 'bundled' },
        { id: 'qwen3.7-plus', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'qwen3.6-plus', availability: 'cheap', costTier: 'low', source: 'bundled' },
        { id: 'qwen3.6-flash', availability: 'cheap', costTier: 'free', source: 'bundled' },
      ],
    },
    muse: {
      // F-1391: catálogo do provedor Meta (Muse 1.4.6, 12/10) — o default
      // marcado é o muse-wonder-1.0; o wonder-full é o mais forte. Esforços
      // F-1398: a CLI aceita max nos wonder e spark-1.3; o cache está atrasado.
      // Fallback estático do cache ~/.local/share/muse/model-catalog.
      default: 'muse-wonder-1.0',
      models: [
        { id: 'muse-wonder-full-1.0', availability: 'free', costTier: 'free', source: 'bundled', efforts: [...MUSE_EFFORTS, 'max'] },
        { id: 'muse-wonder-1.0', availability: 'free', costTier: 'free', source: 'bundled', efforts: [...MUSE_EFFORTS, 'max'] },
        { id: 'muse-spark-1.3', availability: 'free', costTier: 'free', source: 'bundled', efforts: [...MUSE_EFFORTS, 'max'] },
        { id: 'muse-spark-1.2', availability: 'free', costTier: 'free', source: 'bundled', efforts: [...MUSE_EFFORTS] },
      ],
    },
  },
};

let cachedCatalog: ModelCatalog | null = null;
let catalogEpoch = 0;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

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
    // F-912: janela explícita do overlay passa adiante; inválida vira ausente
    // (mesma regra do quality — `undefined` não pode apagar o que veio antes).
    const maxContext =
      typeof raw.maxContext === 'number' && Number.isFinite(raw.maxContext) && raw.maxContext > 0
        ? Math.round(raw.maxContext)
        : undefined;
    // F-1412: visão declarada no overlay só vale afirmativa (nunca "apaga" a
    // visão que o BUILTIN/enriquecimento marcou — mesmo contrato do maxContext).
    const vision = raw.vision === true ? true : undefined;
    const efforts = Array.isArray(raw.efforts)
      ? [...new Set(raw.efforts.filter((effort) => typeof effort === 'string' &&
          /^(?:none|minimal|low|medium|high|xhigh|max|ultra)$/.test(effort)))]
      : undefined;
    return [
      {
        id: raw.id.trim(),
        availability: raw.availability,
        costTier: raw.costTier,
        source: raw.source ?? source,
        warning: raw.warning,
        ...(maxContext !== undefined ? { maxContext } : {}),
        ...(vision !== undefined ? { vision } : {}),
        ...(efforts?.length ? { efforts } : {}),
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
  catalogEpoch++;
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
 *
 * F-679: um USER com `updatedAt` MAIS VELHO que o PUBLISHED do app é cópia
 * semeada/baixada de uma versão antiga (o refresh remoto dá 404 em repo
 * privado e a semente nunca é regravada). Ele passa a valer só para modelos
 * que o app não conhece: BUILTIN e PUBLISHED vencem por cima. Em 29/09 a
 * semente de 14/09 dizia `gemini-3.8-flash-high` custo low (hoje high) e
 * puxava a rota para o AGY. USER sem data ou mais novo continua mandando.
 */
export function loadModelCatalog(file = USER_MODEL_CATALOG_FILE): ModelCatalog {
  if (file === USER_MODEL_CATALOG_FILE && cachedCatalog) return cachedCatalog;
  const user = loadUserModelCatalog(file);
  const catalog = composeModelCatalog(user);
  if (file === USER_MODEL_CATALOG_FILE) cachedCatalog = catalog;
  return catalog;
}

function composeModelCatalog(user: ModelCatalog): ModelCatalog {
  return enrichVision(
    enrichMaxContext(
      isStaleUserModelCatalog(user)
        ? mergeModelCatalogs(
            mergeModelCatalogs(user, BUILTIN_MODEL_CATALOG),
            PUBLISHED_MODEL_CATALOG,
          )
        : mergeModelCatalogs(
            mergeModelCatalogs(BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG),
            user,
          ),
    ),
  );
}

/**
 * F-912: preenche `maxContext` dos modelos do catálogo a partir da janela
 * (`contextWindow`) do recorte vendorado do oh-my-pi — a única fonte de
 * janelas que o repo já traz. Aditivo: só quando o campo está ausente
 * (valor explícito de BUILTIN/PUBLISHED/USER vence) e modelo sem fonte fica
 * SEM o campo — nenhum número é inventado. O roteador trata ausência como
 * "não filtrar", nunca como janela zero.
 *
 * F-992: no Claude o perfil do modelo (manifesto do T3) vem antes — esforços
 * aceitos, versão mínima da CLI e a janela do Claude Code (o id sem `[1m]`
 * do sonnet-4-6 abre 200k, não o 1M da API).
 */
function enrichMaxContext(catalog: ModelCatalog): ModelCatalog {
  const adapters: Record<string, AdapterModelCatalog> = {};
  for (const [adapterId, adapterCatalog] of Object.entries(catalog.adapters ?? {})) {
    adapters[adapterId] = {
      ...adapterCatalog,
      models: (adapterCatalog.models ?? []).map((raw) => {
        const entry = adapterId === 'claude' ? withClaudeModelProfile(raw) : raw;
        if (entry.maxContext !== undefined) return entry;
        const contextWindow = getRichModelMetadata(adapterId, entry.id)?.contextWindow;
        return typeof contextWindow === 'number' && contextWindow > 0
          ? { ...entry, maxContext: contextWindow }
          : entry;
      }),
    };
  }
  return { ...catalog, adapters };
}

/**
 * F-1412: marca `vision: true` quando o recorte vendorado do oh-my-pi declara
 * entrada de imagem para o modelo (`input: ["text","image"]` — a única fonte
 * de modalidades que o repo já traz). Aditivo: só quando o campo está ausente
 * (valor explícito de BUILTIN/PUBLISHED/USER vence — é assim que o GLM 5.3
 * Flash, que não tem entrada no recorte, carrega a visão declarada pelo
 * operador). Modelo sem entrada no recorte fica SEM o campo: sem evidência,
 * não marca (glm-5.3 é text-only; kimi-code/k3 e grok-4.7 não constam).
 */
function enrichVision(catalog: ModelCatalog): ModelCatalog {
  const adapters: Record<string, AdapterModelCatalog> = {};
  for (const [adapterId, adapterCatalog] of Object.entries(catalog.adapters ?? {})) {
    adapters[adapterId] = {
      ...adapterCatalog,
      models: (adapterCatalog.models ?? []).map((entry) => {
        if (entry.vision === true) return entry;
        const input = getRichModelMetadata(adapterId, entry.id)?.input;
        return input?.includes('image') ? { ...entry, vision: true } : entry;
      }),
    };
  }
  return { ...catalog, adapters };
}

async function readCatalogText(file: string): Promise<string> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw new Error('catalog size');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length === bytes.length) throw new Error('catalog changed size');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

/** Same layers as the synchronous bootstrap getter, for periodic refresh. */
export async function loadModelCatalogAsync(file = USER_MODEL_CATALOG_FILE): Promise<ModelCatalog> {
  if (file === USER_MODEL_CATALOG_FILE && cachedCatalog) return cachedCatalog;
  const epoch = catalogEpoch;
  let user: ModelCatalog = {};
  try { user = normaliseCatalog(JSON.parse(await readCatalogText(file)), 'local'); } catch { /* Missing overlay. */ }
  const catalog = composeModelCatalog(user);
  if (epoch !== catalogEpoch) return loadModelCatalogAsync(file);
  if (file === USER_MODEL_CATALOG_FILE) cachedCatalog = catalog;
  return catalog;
}

/** Catálogo do usuário datado de antes do catálogo publicado que o app traz. */
export function isStaleUserModelCatalog(
  user: ModelCatalog,
  published: ModelCatalog = PUBLISHED_MODEL_CATALOG,
): boolean {
  const userAt = Date.parse(user.updatedAt ?? '');
  const publishedAt = Date.parse(published.updatedAt ?? '');
  return Number.isFinite(userAt) && Number.isFinite(publishedAt) && userAt < publishedAt;
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

async function loadCatalogFromLocalPath(filePath: string): Promise<ModelCatalog | null> {
  try {
    return normaliseCatalog(JSON.parse(await readCatalogText(filePath)), 'remote');
  } catch {
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
  // Allow a cold proxy/TLS connection while keeping refresh bounded.
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'nexus-ide' },
    });
    if (!res.ok) return null;
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_CATALOG_BYTES) { await reader.cancel(); return null; }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    return normaliseCatalog(JSON.parse(Buffer.concat(chunks, size).toString('utf8')), 'remote');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * F-990 (PRV-10): validação referencial — por adapter, ids únicos e o
 * `default` presente na própria lista. Um catálogo que manda o seletor abrir
 * num id que ele mesmo não descreve (ou descreve duas vezes) é dado quebrado.
 */
export function modelCatalogReferenceErrors(catalog: ModelCatalog): string[] {
  const errors: string[] = [];
  for (const [adapterId, entry] of Object.entries(catalog.adapters ?? {})) {
    const ids = new Set<string>();
    for (const model of entry.models ?? []) {
      if (ids.has(model.id)) errors.push(`${adapterId}: id duplicado "${model.id}"`);
      ids.add(model.id);
    }
    if (entry.default !== undefined && !ids.has(entry.default)) {
      errors.push(`${adapterId}: default "${entry.default}" fora da lista`);
    }
  }
  return errors;
}

/** Edição datada estritamente mais velha que a que já está em disco. */
function isOlderCatalogEdit(candidate: ModelCatalog, current: ModelCatalog): boolean {
  const candidateAt = Date.parse(candidate.updatedAt ?? '');
  const currentAt = Date.parse(current.updatedAt ?? '');
  return Number.isFinite(candidateAt) && Number.isFinite(currentAt) && candidateAt < currentAt;
}

export async function refreshRemoteModelCatalog(
  url = resolveModelCatalogUrl(),
  file = USER_MODEL_CATALOG_FILE,
): Promise<boolean> {
  if (!url) return false;
  const epoch = catalogEpoch;
  const identity = async () => {
    try { const s = await fs.promises.stat(file); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  // Start IO together so cancellation/deadline ownership starts immediately.
  let [json, initial] = await Promise.all([loadCatalogFromUrl(url), identity()]);
  if (epoch !== catalogEpoch) return false;
  // F-990 (PRV-10): catálogo remoto inválido conta como fetch que falhou — a
  // última versão boa (o arquivo em disco ou, sem ele, o publicado) fica.
  if (json && modelCatalogReferenceErrors(json).length > 0) json = null;
  // CDN atrasada pode servir uma edição anterior à que já está em disco.
  if (json && initial !== null) {
    let current: ModelCatalog | null = null;
    try { current = normaliseCatalog(JSON.parse(await readCatalogText(file)), 'local'); } catch { /* ilegível: o remoto substitui */ }
    if (current && isOlderCatalogEdit(json, current)) return false;
  }

  // Private GitHub raw → 404. Seed only a missing catalog; never replace a
  // newer local/CLI-discovered catalog with the older bundled snapshot.
  if (
    (!json || Object.keys(json.adapters ?? {}).length === 0) &&
    url === DEFAULT_MODEL_CATALOG_URL &&
    initial === null
  ) {
    json = PUBLISHED_MODEL_CATALOG;
  }

  if (!json || Object.keys(json.adapters ?? {}).length === 0) return false;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(temporary, JSON.stringify(json, null, 2), { mode: 0o600, flag: 'wx' });
    if (epoch !== catalogEpoch || await identity() !== initial) return false;
    await fs.promises.rename(temporary, file);
    invalidateModelCatalogCache();
    return true;
  } finally { await fs.promises.unlink(temporary).catch(() => undefined); }
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

/**
 * Catálogo → adapter. Para CLI sem listagem (`bundled`, ex.: Claude) o
 * catálogo É o manifesto e acrescenta ids, como no T3. F-990 (PRV-01): para
 * CLI que sabe listar ele só classifica — nunca acrescenta id (o
 * `gemini-4-argon` do catálogo era oferecido ao AGY 1.3.1, que não o lista) —
 * e só move o default para um id que o adapter já oferece.
 */
export function applyModelCatalogToAdapter(adapter: Adapter, catalog: ModelCatalog): Adapter {
  const adapterCatalog = catalog.adapters?.[adapter.id];
  if (!adapterCatalog) return adapter;
  const addsIds = modelListAuthority(adapter.id) === 'bundled';

  const list = [...adapter.models.list];
  for (const entry of addsIds ? adapterCatalog.models ?? [] : []) {
    // Id oferecido não pode estar migrado: um overlay antigo do operador
    // (~/.nexus/model-catalog.json) ainda listava kimi-k2.7 e o pane nascia
    // com um alias que o Kimi Code recusa.
    if (migrateModelId(entry.id) !== entry.id) continue;
    if (!list.includes(entry.id)) list.push(entry.id);
  }

  const requestedDefault = addsIds || (adapterCatalog.default && list.includes(adapterCatalog.default))
    ? adapterCatalog.default ?? adapter.models.default
    : adapter.models.default;
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
