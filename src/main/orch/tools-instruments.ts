import fs from 'node:fs';
import { rankCapabilitiesByNeed } from './capability-need-ranking';
import {
  OPERATIONAL_DOCTRINE,
  classifyOperationalBand,
  groupByOperationalBand,
  pickForBandWithDegrade,
  resolveNeedBand,
} from '../../shared/model-operational-bands';
import { scanInstalledPlugins } from './agent-plugin-scan';
import path from 'node:path';
import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import type { AgentGateContext } from './gate';
import type { EnrichedCatalogItem } from '../../shared/surface-payload-types';
import { homeRelativeDirOf, OUTSIDE_HOME_LABEL } from './home-relative-path';
import { migrateModelId } from '../../shared/model-defaults';
import { newestInModelLine } from '../../shared/model-line';
import { publishedScoreHint } from './published-benchmarks';

/**
 * Instrument panel — the five READ-ONLY consultations a pilot needs before
 * deciding. Everything else in the nexus_* namespace is a hand (spawn, write,
 * merge, generate); these are gauges.
 *
 *   nexus_quota_status      how much fuel is left, per provider/account
 *   nexus_model_ranking     radar + operational bands (fast/balanced/deep)
 *   nexus_mcp_servers       which third-party MCP servers are configured here
 *   nexus_skills_inventory  which skills this machine actually has
 *   nexus_cli_inventory     which CLIs are installed AND authenticated
 *
 * Invariants, enforced by tools-instruments.test.ts:
 *  1. No new authority. Nothing here installs, authenticates, selects, writes
 *     or probes the network. Every handler is a projection of state some other
 *     part of the product already computed.
 *  2. No secrets, ever — and by construction, not by filtering. Account labels
 *     (which carry e-mails), binary paths (which carry the OS username), key
 *     previews, MCP env/header values and MCP argv are never *shaped into* the
 *     response. Only ids, key NAMES, booleans and ratios cross the boundary.
 *  3. Missing data answers honestly. A source that is absent, disabled, empty
 *     or broken returns `{ available: false, reason }` with an empty list —
 *     never a throw the model must guess about, never an invented number.
 *  4. Everything is bounded (see the caps below) and reports `truncated`.
 *
 * Sources are imported dynamically inside each handler so that a cold source
 * (Electron-bound service, keychain-bound provider store) never becomes a
 * load-time dependency of the whole toolset, and so failures stay per-call.
 */

const MAX_QUOTA_ENTRIES = 64;
const MAX_QUOTA_WINDOWS = 8;
const MAX_RANKING_ENTRIES = 64;
const DEFAULT_RANKING_LIMIT = 20;
const MAX_BAND_ENTRIES = 8;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_TOOLS_PER_SERVER = 32;
const MAX_MCP_KEYS = 32;
const MAX_SKILL_ITEMS = 200;
const DEFAULT_SKILL_LIMIT = 100;
const MAX_CLIS = 64;
const MAX_MODELS_PER_CLI = 24;
/** Hard ceiling on any free-text reason we echo from an upstream failure. */
const MAX_REASON_CHARS = 512;

function reasonFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_REASON_CHARS);
}

/**
 * Single-syscall "is there a readable regular file here?" probe.
 *
 * `existsSync(file) && lstatSync(file)` is two syscalls with a window between
 * them: a config written atomically (write temp + rename) is momentarily
 * absent, and the second call throws ENOENT from outside every try block —
 * invariant 3 turned into a crash the model has to guess about. One stat,
 * `throwIfNoEntry: false` for the missing case, and a catch for every other
 * stat failure (EACCES, ELOOP, EIO) keeps the honest-absence answer.
 */
function isReadableRegularFile(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/**
 * Home-relative directory that cannot become the exception that kills the
 * call: `os.homedir()` is an OS lookup and does throw on a machine with no
 * resolvable home. Reporting the path as outside home is the module's existing
 * "the absolute path is not decision-relevant" answer, and it never invents one.
 */
function homeRelativeSource(file: string): string {
  try {
    return homeRelativeDirOf(file);
  } catch {
    return OUTSIDE_HOME_LABEL;
  }
}

/**
 * Fleet-wide instruments answer for accounts and machines the caller does not
 * own. A worker is a single hand of one mission: it may read its own gauge
 * (see nexus_quota_status) but not the posture of every account on the box.
 */
function assertFleetInstrumentRole(ctx: AgentGateContext, tool: string): void {
  if (ctx.role === 'worker') {
    throw new Error(
      `${tool} is available to an orchestrator or the user only — a worker reads its own provider, not the whole fleet`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Quota                                                                    */
/* -------------------------------------------------------------------------- */

interface QuotaWindowShape {
  kind: string;
  label: string;
  usedRatio: number | null;
  resetsAt?: number;
  source: string;
  confidence: string;
}

interface QuotaEntryShape {
  adapterId: string;
  accountId?: string;
  /** `account` = a vault account row; `cli` = the bare native CLI login. */
  kind: 'account' | 'cli';
  installed: boolean;
  onCooldown: boolean;
  cooldownUntil?: number;
  updatedAt: number;
  windows: QuotaWindowShape[];
}

/**
 * The snapshot entry carries `label` (`"Claude Code · user@example.com"`) and
 * `remainingLabel` (provider free text). Neither is copied: the projection is
 * built field by field from ids and numbers, so no label can ever escape.
 */
function projectQuotaEntry(entry: {
  adapterId: string;
  accountId?: string;
  installed: boolean;
  onCooldown: boolean;
  cooldownUntil?: number;
  updatedAt: number;
  windows: ReadonlyArray<{
    kind: string;
    label: string;
    usedRatio: number | null;
    resetsAt?: number;
    source: string;
    confidence: string;
  }>;
}): QuotaEntryShape {
  return {
    adapterId: entry.adapterId,
    ...(entry.accountId ? { accountId: entry.accountId } : {}),
    kind: entry.accountId ? ('account' as const) : ('cli' as const),
    installed: entry.installed,
    onCooldown: entry.onCooldown,
    ...(entry.cooldownUntil !== undefined
      ? { cooldownUntil: entry.cooldownUntil }
      : {}),
    updatedAt: entry.updatedAt,
    windows: entry.windows.slice(0, MAX_QUOTA_WINDOWS).map((w) => ({
      kind: w.kind,
      label: w.label,
      usedRatio: w.usedRatio,
      ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
      source: w.source,
      confidence: w.confidence,
    })),
  };
}

const quotaStatusTool: McpToolDef = {
  name: 'nexus_quota_status',
  description:
    'Read the last fleet quota snapshot: per provider/account, how much of ' +
    'each window (session / 5h / weekly / credits) is used, when it resets, ' +
    'and whether the account is on cooldown. Consult BEFORE routing or ' +
    'delegating so work is not sent to an exhausted account. Read-only and ' +
    'passive: it never contacts a provider — it reports the snapshot the app ' +
    'already holds. Account labels/e-mails are never returned; rows are ' +
    'identified by adapterId + opaque accountId. An orchestrator sees the ' +
    'whole fleet; a worker sees only its own provider. usedRatio null means ' +
    'unknown — it does NOT mean zero.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const ownProviderOnly = ctx.role === 'worker';
    if (ownProviderOnly && !ctx.providerId) {
      return Object.freeze({
        available: false,
        reason:
          'worker provider identity is unknown in this session — refusing to widen the read to the whole fleet',
        scope: 'own-provider' as const,
        truncated: false,
        entries: [],
      });
    }

    let snapshot: {
      updatedAt: number;
      worstUsedRatio: number | null;
      highUsageCount: number;
      unknownCount: number;
      entries: ReadonlyArray<Parameters<typeof projectQuotaEntry>[0]>;
    } | null;
    try {
      const { requireQuotaService } = await import('../quota/quota-service');
      snapshot = requireQuotaService().lastSnapshot();
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `quota service unavailable: ${reasonFrom(error)}`,
        scope: ownProviderOnly ? ('own-provider' as const) : ('fleet' as const),
        truncated: false,
        entries: [],
      });
    }

    if (!snapshot) {
      return Object.freeze({
        available: false,
        reason:
          'no quota snapshot has been built yet in this session — the fleet gauge populates once Settings → Uso e cotas or the failover path reads it',
        scope: ownProviderOnly ? ('own-provider' as const) : ('fleet' as const),
        truncated: false,
        entries: [],
      });
    }

    const matching = ownProviderOnly
      ? snapshot.entries.filter((e) => e.adapterId === ctx.providerId)
      : snapshot.entries;
    const capped = matching.slice(0, MAX_QUOTA_ENTRIES);

    return Object.freeze({
      available: true,
      scope: ownProviderOnly ? ('own-provider' as const) : ('fleet' as const),
      updatedAt: snapshot.updatedAt,
      truncated:
        matching.length > capped.length ||
        capped.some((e) => e.windows.length > MAX_QUOTA_WINDOWS),
      entries: capped.map(projectQuotaEntry),
      // Fleet aggregates describe accounts a worker does not own.
      ...(ownProviderOnly
        ? {}
        : {
            fleet: {
              worstUsedRatio: snapshot.worstUsedRatio,
              highUsageCount: snapshot.highUsageCount,
              unknownCount: snapshot.unknownCount,
              entryCount: snapshot.entries.length,
            },
          }),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* 2. Model ranking                                                            */
/* -------------------------------------------------------------------------- */

const RANKING_DIMENSIONS = [
  'overall',
  'coding',
  'reasoning',
  'frontend',
  'security',
] as const;

type RankingDimension = (typeof RANKING_DIMENSIONS)[number];

const rankingInputSchema = z
  .object({
    dimension: z.enum(RANKING_DIMENSIONS).default('overall'),
    adapterId: z.string().trim().min(1).max(64).optional(),
    need: z.string().trim().min(1).max(280).optional(),
    band: z.enum(['fast', 'balanced', 'deep']).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RANKING_ENTRIES)
      .catch(MAX_RANKING_ENTRIES)
      .default(DEFAULT_RANKING_LIMIT),
  })
  .strict();

type RankingRow = {
  id: string;
  adapterId: string;
  modelId: string;
  overall: number;
  coding?: number;
  reasoning?: number;
  frontend?: number;
  security?: number;
  costTier?: string;
  availability?: string;
  confidence?: number;
  estimate?: boolean;
  sourceLabel?: string;
  rank?: number;
  /** F-1230: o score veio de um modelo mais velho da mesma linha. */
  upgradedFrom?: string;
};

/** Modelos elegíveis por CLI instalada e habilitada (F-1230). */
interface InstalledAdapterModels {
  readonly models: readonly string[];
  readonly info: Readonly<Record<string, { costTier?: string; availability?: string }>>;
}
type InstalledModels = ReadonlyMap<string, InstalledAdapterModels>;

/**
 * F-1230 (regra do operador: "os mais novos são os melhores", nunca tabela
 * velha): a linha do ranking só entra nas faixas e no pick se a CLI dela está
 * instalada e habilitada e se o modelo está na oferta elegível dela (sem
 * api-only/deprecated nem quarentena — o mesmo filtro de
 * `newestExplicitModelInLine` no spawn). Um modelo com versão mais nova da
 * mesma linha instalada sobe para ela; o score herdado vira estimativa. Um
 * modelo fora da oferta e sem linha mais nova instalada sai.
 */
export function alignRankingToInstalled(
  rows: readonly RankingRow[],
  installed: InstalledModels,
): { rows: RankingRow[]; dropped: string[]; lifted: string[] } {
  const kept = new Map<string, RankingRow>();
  const dropped: string[] = [];
  const lifted: string[] = [];
  for (const row of rows) {
    const adapter = installed.get(row.adapterId);
    const model = adapter
      ? newestInModelLine(migrateModelId(row.modelId) ?? row.modelId, adapter.models)
      : row.modelId;
    if (!adapter || !adapter.models.includes(model)) {
      dropped.push(row.id);
      continue;
    }
    let next = row;
    if (model !== row.modelId) {
      const info = adapter.info[model];
      next = {
        ...row,
        id: `${row.adapterId}/${model}`,
        modelId: model,
        costTier: info?.costTier ?? row.costTier,
        availability: info?.availability ?? row.availability,
        estimate: true,
        sourceLabel: `estimativa herdada de ${row.modelId}`,
        upgradedFrom: row.modelId,
      };
      lifted.push(`${row.adapterId}:${row.modelId}→${model}`);
    }
    const prior = kept.get(next.id);
    // O score medido do próprio modelo vence o herdado de um mais velho.
    if (prior && (prior.upgradedFrom === undefined || next.upgradedFrom !== undefined)) {
      continue;
    }
    kept.set(next.id, next);
  }
  // F-1290 (fixture velha): linha sem NENHUMA linha no fixture (astra, argon,
  // sol novo) nunca passava pelo lift acima e sumia das faixas mesmo
  // instalada. O modelo instalado com benchmark publicado entra como
  // estimativa — PUBLISHED_BENCHMARKS continua a única fonte (sem hint, sem
  // linha: qwen e Cia. seguem de fora, nunca se inventa número).
  for (const [adapterId, adapter] of installed) {
    for (const model of adapter.models) {
      const id = `${adapterId}/${model}`;
      if (kept.has(id)) continue;
      // Modelo mais novo sempre: a versão velha de uma linha com sucessor
      // instalado não volta (a tabela publicada guarda as velhas também).
      if (newestInModelLine(model, adapter.models) !== model) continue;
      const hint = publishedScoreHint(adapterId, model);
      if (!hint) continue;
      const info = adapter.info[model];
      kept.set(id, {
        id,
        adapterId,
        modelId: model,
        overall: hint.score100,
        coding: hint.score100,
        ...(info?.costTier !== undefined ? { costTier: info.costTier } : {}),
        ...(info?.availability !== undefined
          ? { availability: info.availability }
          : {}),
        estimate: true,
        sourceLabel: hint.label,
      });
    }
  }
  return { rows: [...kept.values()], dropped, lifted };
}

async function loadInstalledModels(): Promise<
  { readonly installed: InstalledModels } | { readonly reason: string }
> {
  try {
    const [{ listAdapterInfos }, { isModelBlockedForAutoRouting }, { modelAccessQuarantine }] =
      await Promise.all([
        import('../adapters/adapter-registry'),
        import('../adapters/model-catalog'),
        import('./model-access-quarantine'),
      ]);
    const adapters = listAdapterInfos();
    if (adapters.length === 0) return { reason: 'adapter registry is empty' };
    let disabled = new Set<string>();
    try {
      const { listProviderSettings } = await import('../persistence/provider-config-store');
      disabled = new Set(
        listProviderSettings({ nonBlockingAuth: true })
          .filter((p) => !p.enabled)
          .map((p) => p.adapterId),
      );
    } catch {
      // Postura de Providers ilegível: só a instalação filtra.
    }
    const installed = new Map<string, InstalledAdapterModels>();
    for (const adapter of adapters) {
      if (!adapter.installed || disabled.has(adapter.id)) continue;
      const info = adapter.models.info ?? {};
      installed.set(adapter.id, {
        models: adapter.models.list.filter(
          (model) =>
            !isModelBlockedForAutoRouting(info[model]) &&
            !modelAccessQuarantine(adapter.id, model),
        ),
        info,
      });
    }
    return { installed };
  } catch (error) {
    return { reason: `installed catalog unavailable: ${reasonFrom(error)}` };
  }
}

function bandOfRankingRow(entry: RankingRow) {
  return classifyOperationalBand(entry);
}

function compactBandEntry(entry: RankingRow) {
  return Object.freeze({
    id: entry.id,
    adapterId: entry.adapterId,
    modelId: entry.modelId,
    band: bandOfRankingRow(entry),
    ...(entry.costTier !== undefined ? { costTier: entry.costTier } : {}),
    ...(entry.upgradedFrom !== undefined ? { upgradedFrom: entry.upgradedFrom } : {}),
  });
}

function projectOperationalBands(entries: readonly RankingRow[]) {
  const grouped = groupByOperationalBand(entries, bandOfRankingRow);
  return Object.freeze({
    fast: grouped.fast.slice(0, MAX_BAND_ENTRIES).map(compactBandEntry),
    balanced: grouped.balanced.slice(0, MAX_BAND_ENTRIES).map(compactBandEntry),
    deep: grouped.deep.slice(0, MAX_BAND_ENTRIES).map(compactBandEntry),
  });
}

const EMPTY_OPERATIONAL_BANDS = projectOperationalBands([]);

const modelRankingTool: McpToolDef = {
  name: 'nexus_model_ranking',
  description:
    "Read the product's operational model list: three cost/depth bands " +
    '(fast / balanced / deep) plus the doctrine default-DOWN, and the ' +
    'optional score radar (Settings → Ranking LLMs). Consult BEFORE ' +
    'choosing a model. Pass `need` (what the work is) or `band` to get a ' +
    'pick; the tool degrades to a cheaper band when the target is empty, ' +
    'never escalates. Score entries carry `estimate: true` when they come ' +
    'from offline fixtures — treat those as a hint, not evidence. Bands ' +
    'come from catalog cost/availability, not from fixture scores, and only ' +
    'list models this machine runs: a CLI not installed/enabled or a model ' +
    'outside its offer is dropped, and an older model is lifted to the ' +
    'newest installed model of its line (`upgradedFrom`, score becomes an ' +
    'estimate) — see `installedCatalog`. Public data only — no accounts, no keys.',
  inputSchema: {
    type: 'object',
    properties: {
      dimension: {
        type: 'string',
        enum: [...RANKING_DIMENSIONS],
        description: 'Score dimension to rank by (default overall).',
      },
      adapterId: {
        type: 'string',
        description: 'Restrict to one CLI/provider (e.g. claude, codex).',
      },
      need: {
        type: 'string',
        description:
          'What the work is (one sentence). Selects a band via specialty: ' +
          'doc→fast, feature/visual→balanced, security/bug/ops→deep.',
      },
      band: {
        type: 'string',
        enum: ['fast', 'balanced', 'deep'],
        description: 'Force a band. Overrides the need-derived target.',
      },
      limit: { type: 'number', description: 'Max score entries (default 20).' },
    },
  },
  handler: async (args) => {
    const input = rankingInputSchema.parse(args);
    const need = resolveNeedBand(input.need, input.band);
    const askedNeed = Boolean(input.need || input.band);

    let snapshot: {
      generatedAt: string;
      suiteId: string;
      suiteRevision: string;
      entries: ReadonlyArray<RankingRow>;
    };
    try {
      const { getPublicModelRanking } = await import('../eval/eval-ipc');
      snapshot = getPublicModelRanking();
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `model ranking unavailable: ${reasonFrom(error)}`,
        dimension: input.dimension,
        doctrine: OPERATIONAL_DOCTRINE,
        bands: EMPTY_OPERATIONAL_BANDS,
        truncated: false,
        entries: [],
      });
    }

    // F-1230: faixas e pick só com o que esta máquina roda, na linha mais nova.
    const installedSource = await loadInstalledModels();
    let rows: readonly RankingRow[] = snapshot.entries;
    let installedCatalog: Readonly<Record<string, unknown>>;
    if ('installed' in installedSource) {
      const aligned = alignRankingToInstalled(snapshot.entries, installedSource.installed);
      rows = aligned.rows;
      installedCatalog = Object.freeze({
        applied: true,
        dropped: aligned.dropped.slice(0, MAX_RANKING_ENTRIES),
        lifted: aligned.lifted.slice(0, MAX_RANKING_ENTRIES),
      });
    } else {
      installedCatalog = Object.freeze({ applied: false, reason: installedSource.reason });
    }
    const pool = input.adapterId
      ? rows.filter((e) => e.adapterId === input.adapterId)
      : rows;
    const scoreOf = (e: RankingRow): number | undefined =>
      e[input.dimension as RankingDimension];
    const scored = pool.filter((e) => typeof scoreOf(e) === 'number');
    const omitted = pool.length - scored.length;
    const bands = projectOperationalBands(scored);

    if (scored.length === 0) {
      return Object.freeze({
        available: false,
        reason:
          omitted > 0
            ? `no ranking entries carry a "${input.dimension}" score (${omitted} model(s) scored in other dimensions only)`
            : 'no ranking entries are available for this filter',
        dimension: input.dimension,
        generatedAt: snapshot.generatedAt,
        doctrine: OPERATIONAL_DOCTRINE,
        bands,
        installedCatalog,
        truncated: false,
        entries: [],
      });
    }

    const ordered = [...scored].sort(
      (a, b) => (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0),
    );
    const capped = ordered.slice(0, Math.min(input.limit, MAX_RANKING_ENTRIES));
    const pick = askedNeed
      ? pickForBandWithDegrade(ordered, bandOfRankingRow, need.band)
      : null;

    return Object.freeze({
      available: true,
      dimension: input.dimension,
      generatedAt: snapshot.generatedAt,
      suiteId: snapshot.suiteId,
      suiteRevision: snapshot.suiteRevision,
      doctrine: OPERATIONAL_DOCTRINE,
      bands,
      installedCatalog,
      ...(askedNeed
        ? {
            need: Object.freeze({
              specialty: need.specialty,
              band: need.band,
              pick: pick
                ? Object.freeze({
                    ...compactBandEntry(pick.item),
                    degraded: pick.degraded,
                    servedBand: pick.band,
                  })
                : null,
            }),
          }
        : {}),
      truncated: ordered.length > capped.length,
      omittedForMissingDimension: omitted,
      entries: capped.map((e, index) => ({
        id: e.id,
        adapterId: e.adapterId,
        modelId: e.modelId,
        score: scoreOf(e) as number,
        overall: e.overall,
        band: bandOfRankingRow(e),
        ...(e.costTier !== undefined ? { costTier: e.costTier } : {}),
        ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
        estimate: e.estimate === true,
        ...(e.sourceLabel !== undefined ? { sourceLabel: e.sourceLabel } : {}),
        ...(e.upgradedFrom !== undefined ? { upgradedFrom: e.upgradedFrom } : {}),
        rank: index + 1,
      })),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* 3. MCP servers                                                              */
/* -------------------------------------------------------------------------- */

const HUB_RELATIVE_PATH = path.join('.nexus', 'mcp-hub.json');

/** Host only — drops userinfo, path and query, where tokens actually live. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

const mcpServersTool: McpToolDef = {
  name: 'nexus_mcp_servers',
  description:
    'List the third-party MCP servers configured for this workspace ' +
    '(.nexus/mcp-hub.json — Settings → MCPs): id, name, transport, declared ' +
    'tools, command NAME, url HOST and env/header KEY NAMES. Values, argv, ' +
    'urls with query strings and secrets are never returned. IMPORTANT: this ' +
    'is configuration, not liveness — Nexus does not probe these servers, so ' +
    '`status: "configured"` never means "alive". Orchestrator/user only.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    assertFleetInstrumentRole(ctx, 'nexus_mcp_servers');

    const livenessNote =
      'Nexus does not probe MCP server liveness; "configured" reflects the config file only.';

    try {
      const { getFeatureFlagRegistry } = await import(
        '../feature-flags/feature-flag-registry'
      );
      const { FEATURE_FLAG_IDS } = await import('../../shared/feature-flags');
      if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.mcpHub)) {
        return Object.freeze({
          available: false,
          reason: 'feature.mcp.hub is disabled on this installation',
          livenessProbed: false,
          livenessNote,
          truncated: false,
          servers: [],
        });
      }
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `feature flag registry unavailable: ${reasonFrom(error)}`,
        livenessProbed: false,
        livenessNote,
        truncated: false,
        servers: [],
      });
    }

    let file: string | null;
    try {
      const { tryResolveSubdirUnderRoot } = await import(
        '../security/scoped-workspace-fs'
      );
      const nexusDir = tryResolveSubdirUnderRoot(
        ctx.scope.rootRealPath,
        '.nexus',
      );
      file = nexusDir ? path.join(nexusDir, 'mcp-hub.json') : null;
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `workspace path resolver unavailable: ${reasonFrom(error)}`,
        livenessProbed: false,
        livenessNote,
        truncated: false,
        servers: [],
      });
    }

    if (!file || !isReadableRegularFile(file)) {
      return Object.freeze({
        available: true,
        configured: false,
        configPath: HUB_RELATIVE_PATH,
        reason: `this workspace has no ${HUB_RELATIVE_PATH} — no third-party MCP server is configured for it`,
        livenessProbed: false,
        livenessNote,
        truncated: false,
        servers: [],
      });
    }

    let config: {
      servers: ReadonlyArray<{
        id: string;
        name: string;
        transport: string;
        command?: string;
        args?: string[];
        url?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        tools: string[];
        source: string;
      }>;
    };
    try {
      const { mcpHubConfigSchema } = await import('../mcp-hub/mcp-hub-core');
      config = mcpHubConfigSchema.parse(
        JSON.parse(fs.readFileSync(file, 'utf8')),
      );
    } catch (error) {
      return Object.freeze({
        available: false,
        configured: true,
        configPath: HUB_RELATIVE_PATH,
        reason: `${HUB_RELATIVE_PATH} is unreadable or invalid: ${reasonFrom(error)}`,
        livenessProbed: false,
        livenessNote,
        truncated: false,
        servers: [],
      });
    }

    const capped = config.servers.slice(0, MAX_MCP_SERVERS);
    return Object.freeze({
      available: true,
      configured: true,
      configPath: HUB_RELATIVE_PATH,
      livenessProbed: false,
      livenessNote,
      truncated:
        config.servers.length > capped.length ||
        capped.some((s) => s.tools.length > MAX_MCP_TOOLS_PER_SERVER),
      servers: capped.map((server) => {
        const commandName = server.command
          ? path.basename(server.command)
          : undefined;
        const urlHost = hostOf(server.url);
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          source: server.source,
          status: 'configured' as const,
          ...(commandName ? { commandName } : {}),
          argCount: server.args?.length ?? 0,
          ...(urlHost ? { urlHost } : {}),
          envKeys: Object.keys(server.env ?? {}).slice(0, MAX_MCP_KEYS),
          headerKeys: Object.keys(server.headers ?? {}).slice(0, MAX_MCP_KEYS),
          toolCount: server.tools.length,
          tools: server.tools.slice(0, MAX_MCP_TOOLS_PER_SERVER),
        };
      }),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* 4. Skills inventory                                                         */
/* -------------------------------------------------------------------------- */

const skillsInputSchema = z
  .object({
    kind: z.enum(['skill', 'agent', 'all']).default('skill'),
    /** Necessidade em uma frase: ranqueia em vez de despejar o catálogo. */
    need: z.string().max(512).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SKILL_ITEMS)
      .catch(MAX_SKILL_ITEMS)
      .default(DEFAULT_SKILL_LIMIT),
  })
  .strict();

const skillsInventoryTool: McpToolDef = {
  name: 'nexus_skills_inventory',
  description:
    'List the skills (and optionally agents) actually installed on this ' +
    'machine (Settings → Skills): name, kind, home-relative source directory, ' +
    'size and mtime. Consult BEFORE planning work that assumes a skill ' +
    'exists, and before naming a skill in a squad. Also reports the calling ' +
    "agent's OWN skill access (open to every skill since F-1157). When the " +
    'enriched arsenal exists, each item carries tier ' +
    '(scout|builder|reviewer), blurb and whenToUse — ground squad/pipeline ' +
    'composition in THESE annotations, never in memory. Absolute ' +
    'paths are never returned. Read-only: installing is the separate ' +
    'nexus_skills tool (human confirmation applies).',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['skill', 'agent', 'all'],
        description: 'Which catalog kind to list (default skill).',
      },
      need: {
        type: 'string',
        description:
          'Necessidade em uma frase ("gerar diagrama", "revisar acessibilidade"). ' +
          'Ranqueia e encurta a resposta, com os termos que casaram. Sem isto o ' +
          'catálogo inteiro volta e o orquestrador gasta contexto escolhendo.',
      },
      limit: { type: 'number', description: 'Max items (default 100).' },
    },
  },
  handler: async (args, _ctx) => {
    const input = skillsInputSchema.parse(args);
    // F-1157: every agent may use every installed skill.
    const gate = {
      restricted: false,
      allowed: null,
    };

    let items: ReadonlyArray<{
      kind: string;
      name: string;
      file: string;
      size: number;
      modifiedAt: number;
    }>;
    try {
      const { listInstalledCatalogItems } = await import('./catalog-installed');
      items = listInstalledCatalogItems();
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `installed catalog scan failed: ${reasonFrom(error)}`,
        gate,
        truncated: false,
        counts: { skill: 0, agent: 0 },
        items: [],
      });
    }

    // Arsenal enriquecido (harness-enrich): anotação tier/blurb/whenToUse por
    // item, quando o catálogo anotado existe. Opcional por construção — o
    // inventário nunca falha nem muda de forma por causa do enriquecimento.
    let enrichedByKey: ReadonlyMap<string, EnrichedCatalogItem> | null = null;
    try {
      const { loadEnrichedCatalog } = await import('./harness-enrich');
      const enriched = loadEnrichedCatalog();
      if (enriched && Array.isArray(enriched.items) && enriched.items.length > 0) {
        enrichedByKey = new Map(
          enriched.items.map((entry) => [`${entry.kind}:${entry.name}`, entry]),
        );
      }
    } catch {
      // Sem anotação — inventário segue íntegro.
    }

    const counts = {
      skill: items.filter((i) => i.kind === 'skill').length,
      agent: items.filter((i) => i.kind === 'agent').length,
    };
    const matching =
      input.kind === 'all'
        ? items.filter((i) => i.kind === 'skill' || i.kind === 'agent')
        : items.filter((i) => i.kind === input.kind);

    if (matching.length === 0) {
      return Object.freeze({
        available: false,
        reason: `no installed ${input.kind === 'all' ? 'skills or agents' : `${input.kind}s`} were found in the known CLI catalog directories`,
        gate,
        truncated: false,
        counts,
        items: [],
      });
    }

    // Ranquear ANTES de cortar: cortar primeiro entregaria os 100 primeiros
    // alfabéticos e chamaria isso de busca — o candidato certo pode ser o 137º.
    const ranking = input.need
      ? rankCapabilitiesByNeed(
          matching.map((item) => ({
            name: item.name,
            labels: [item.kind],
            item,
          })),
          input.need,
          Math.min(input.limit, MAX_SKILL_ITEMS),
        )
      : null;
    const selected = ranking?.matched
      ? ranking.ranked.map((entry) => entry.item.item)
      : matching;
    const capped = selected.slice(0, Math.min(input.limit, MAX_SKILL_ITEMS));
    const matchedTermsByName = new Map(
      (ranking?.matched ? ranking.ranked : []).map((entry) => [
        entry.item.name,
        entry.matchedTerms,
      ]),
    );
    return Object.freeze({
      available: true,
      gate,
      truncated: selected.length > capped.length,
      counts,
      // D1: necessidade que não casou com nada devolve o catálogo com
      // matched:false. Busca sem resultado não pode ser pior que não buscar.
      ...(input.need ? { need: input.need, matched: ranking?.matched === true } : {}),
      items: capped.map((item) => {
        const annotation = enrichedByKey?.get(`${item.kind}:${item.name}`);
        return {
          name: item.name,
          kind: item.kind,
          source: homeRelativeSource(item.file),
          sizeBytes: item.size,
          modifiedAt: item.modifiedAt,
          ...(matchedTermsByName.has(item.name)
            ? { matchedTerms: matchedTermsByName.get(item.name) }
            : {}),
          ...(annotation
            ? {
                tier: annotation.tier,
                blurb: annotation.blurb,
                ...(annotation.whenToUse ? { whenToUse: annotation.whenToUse } : {}),
              }
            : {}),
        };
      }),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* 5. CLI inventory                                                            */
/* -------------------------------------------------------------------------- */

const cliInventoryTool: McpToolDef = {
  name: 'nexus_cli_inventory',
  description:
    'List the AI CLIs known to this machine and, crucially, whether each one ' +
    'can actually run: installed, binary resolved, enabled, authStrategy ' +
    '(subscription | api-key | login-needed | credentialless), whether a key ' +
    'is stored, how many models are auth-ready, and the orchestration/handoff ' +
    'capability ladder. autonomousWorkspaceWriteCapable is the proven native ' +
    'write confinement needed in Hardened; a worktree alone does not provide it. ' +
    'Autopilot uses its own operator-choice authority and still requires handoff. ' +
    'Consult BEFORE routing or rerouting work to a ' +
    'provider. Complements nexus_pane_list_providers, which reports adapters ' +
    'but not auth posture. Never returns binary paths, key previews or key ' +
    'env var names. Orchestrator/user only.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    assertFleetInstrumentRole(ctx, 'nexus_cli_inventory');

    let adapters: ReadonlyArray<{
      id: string;
      kind: string;
      label: string;
      models: { list: string[]; default: string };
      installed: boolean;
      resolvedBinPath?: string | null;
      cliInstallationWarning?: string;
      installCommand: string;
      orchestratorCapable: boolean;
      orchestrationEvidence?: string;
      taskHandoffCapable?: boolean;
      missionControlCapable?: boolean;
      autonomousWorkspaceWriteCapable?: boolean;
    }>;
    try {
      const { listAdapterInfos } = await import('../adapters/adapter-registry');
      adapters = listAdapterInfos();
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `adapter registry unavailable: ${reasonFrom(error)}`,
        authSource: 'unavailable' as const,
        truncated: false,
        clis: [],
      });
    }

    if (adapters.length === 0) {
      return Object.freeze({
        available: false,
        reason:
          'no CLI adapter is registered on this machine — the adapter registry is empty',
        authSource: 'unavailable' as const,
        truncated: false,
        clis: [],
      });
    }

    // Auth posture is a second, independently failable source: a locked
    // keychain must degrade the answer, not destroy it.
    let authByAdapter = new Map<
      string,
      {
        enabled: boolean;
        authStrategy: string;
        hasKey: boolean;
        authReadyModels?: string[];
        credentialReadiness?: string;
      }
    >();
    let authSource: 'provider-settings' | 'unavailable' = 'provider-settings';
    let authReason: string | null = null;
    try {
      const { listProviderSettings } = await import(
        '../persistence/provider-config-store'
      );
      // nonBlockingAuth: never let an instrument read hang the main thread on
      // a locked login keychain.
      authByAdapter = new Map(
        listProviderSettings({ nonBlockingAuth: true }).map((p) => [
          p.adapterId,
          {
            enabled: p.enabled,
            authStrategy: p.authStrategy,
            hasKey: p.hasKey,
            authReadyModels: p.authReadyModels,
            credentialReadiness: p.credentialReadiness,
          },
        ]),
      );
    } catch (error) {
      authSource = 'unavailable';
      authReason = `provider auth posture unavailable: ${reasonFrom(error)}`;
    }

    const capped = adapters.slice(0, MAX_CLIS);
    return Object.freeze({
      available: true,
      authSource,
      ...(authReason ? { reason: authReason } : {}),
      truncated: adapters.length > capped.length,
      clis: capped.map((adapter) => {
        const auth = authByAdapter.get(adapter.id);
        return {
          adapterId: adapter.id,
          label: adapter.label,
          kind: adapter.kind,
          installed: adapter.installed,
          ...(adapter.cliInstallationWarning
            ? { cliInstallationWarning: adapter.cliInstallationWarning } : {}),
          binaryResolved: typeof adapter.resolvedBinPath === 'string' &&
            adapter.resolvedBinPath.length > 0,
          enabled: auth ? auth.enabled : null,
          authStrategy: auth ? auth.authStrategy : null,
          hasStoredKey: auth ? auth.hasKey : null,
          authReadyModelCount: auth ? (auth.authReadyModels?.length ?? 0) : null,
          ...(auth?.credentialReadiness ? { credentialReadiness: auth.credentialReadiness } : {}),
          defaultModel: adapter.models.default,
          modelCount: adapter.models.list.length,
          models: adapter.models.list.slice(0, MAX_MODELS_PER_CLI),
          modelsTruncated: adapter.models.list.length > MAX_MODELS_PER_CLI,
          orchestratorCapable: adapter.orchestratorCapable,
          orchestrationEvidence:
            adapter.orchestrationEvidence ??
            (adapter.orchestratorCapable ? 'experimental' : 'unsupported'),
          taskHandoffCapable: adapter.taskHandoffCapable === true,
          missionControlCapable: adapter.missionControlCapable === true,
          autonomousWorkspaceWriteCapable:
            adapter.autonomousWorkspaceWriteCapable === true,
          installCommand: adapter.installCommand,
        };
      }),
    });
  },
};

/**
 * Ingestão de plugins: descobre e RELATA, nunca instala.
 *
 * Gravar componente de terceiro em `~/.claude` é `catalog_install`, recusado no
 * dispatch porque exige a superfície nativa (commit, digest, alertas). Expor
 * uma instalação por aqui seria o mesmo buraco com nome novo — então esta tool
 * é read-only por desenho, e o operador instala pelo Marketplace sabendo o que
 * entra.
 */
const pluginInventoryTool: McpToolDef = {
  name: 'nexus_plugin_inventory',
  description:
    'Lista os plugins de agente instalados nesta máquina (~/.nexus/plugins e ' +
    '~/.claude/plugins): nome, versão, componentes ingeríveis e o que este ' +
    'Nexus IGNORA de cada um. Consulte antes de assumir que um agente/skill de ' +
    'plugin existe. Read-only: instalar é outra superfície, explicitamente ' +
    'consentida. Caminhos absolutos nunca são retornados.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    const plugins = scanInstalledPlugins(undefined, {
      allowedTools: ctx.allowedTools,
    });
    return Object.freeze({
      counts: {
        total: plugins.length,
        usable: plugins.filter((p) => p.verdict.ok).length,
      },
      plugins: plugins.map((plugin) => ({
        source: plugin.source,
        summary: plugin.summary,
        status: plugin.status,
        usable: plugin.verdict.ok,
        mappings: plugin.mappings,
        notices: plugin.notices,
        limitations: plugin.limitations,
        skills: plugin.skills.map((skill) => ({
          name: skill.name,
          qualifiedName: skill.qualifiedName,
          providerName: skill.providerName,
          permissionGate: skill.metadata.permissionGate,
          allowedTools: skill.toolReduction,
        })),
        mcpServers: plugin.mcpServers.map((server) => ({
          name: server.name,
          transport: server.transport,
          activation: server.activation,
          permissionGate: server.permissionGate,
        })),
        ...(plugin.verdict.ok
          ? {
              name: plugin.verdict.name,
              version: plugin.verdict.version,
              entries: plugin.verdict.entries,
              degraded: plugin.verdict.degraded,
            }
          : { reason: plugin.verdict.reason }),
      })),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* 7. Vault — one place for every stored credential (parity: Overclock 1.3)   */
/* -------------------------------------------------------------------------- */

const MAX_VAULT_ENTRIES = 64;

const vaultListTool: McpToolDef = {
  name: 'nexus_vault_list',
  description:
    'List which credentials the app vault (Keychain/safeStorage-backed) ' +
    'holds: per CLI provider (adapterId) and per media generation provider. ' +
    'Reports presence, storage backend availability and a masked preview ' +
    'shape only — key VALUES are never shaped into the response, by ' +
    'construction. Labels/e-mails stay out; rows are identified by id. Use ' +
    'it to know which providers are credential-ready BEFORE promising a ' +
    'spawn, image or video step. Read-only. Orchestrator/user only.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    assertFleetInstrumentRole(ctx, 'nexus_vault_list');

    let backendAvailable = true;
    let backendReason: string | undefined;
    try {
      const { isSecureStorageAvailable } = await import(
        '../persistence/secrets-store'
      );
      backendAvailable = isSecureStorageAvailable();
      if (!backendAvailable) {
        backendReason =
          'secure storage (Keychain/safeStorage) is unavailable — stored credentials cannot be read here';
      }
    } catch (error) {
      backendAvailable = false;
      backendReason = `secrets store unavailable: ${reasonFrom(error)}`;
    }

    const cli: Array<{
      adapterId: string;
      hasKey: boolean;
      masked: string | null;
    }> = [];
    let truncated = false;
    try {
      const { listAdapterInfos } = await import(
        '../adapters/adapter-registry'
      );
      const { hasSecret, maskedKey } = await import(
        '../persistence/secrets-store'
      );
      for (const info of listAdapterInfos()) {
        if (cli.length >= MAX_VAULT_ENTRIES) {
          truncated = true;
          break;
        }
        cli.push({
          adapterId: info.id,
          hasKey: hasSecret(info.id),
          masked: maskedKey(info.id),
        });
      }
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `adapter vault projection failed: ${reasonFrom(error)}`,
        backendAvailable,
        truncated: false,
        cli: [],
        media: [],
      });
    }

    const media: Array<{
      providerId: string;
      kind: string;
      envVar: string;
      hasKey: boolean;
    }> = [];
    try {
      const { MEDIA_PROVIDERS } = await import('../media/media-providers');
      const { hasStoredMediaKey } = await import('../media/media-keys');
      for (const def of MEDIA_PROVIDERS) {
        if (media.length >= MAX_VAULT_ENTRIES) {
          truncated = true;
          break;
        }
        media.push({
          providerId: def.id,
          kind: def.kind,
          envVar: def.envVar,
          hasKey: hasStoredMediaKey(def.id),
        });
      }
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `media vault projection failed: ${reasonFrom(error)}`,
        backendAvailable,
        truncated: false,
        cli: [],
        media: [],
      });
    }

    return Object.freeze({
      available: true,
      backendAvailable,
      ...(backendReason ? { backendReason } : {}),
      truncated,
      cli,
      media,
    });
  },
};

export function buildInstrumentTools(): McpToolDef[] {
  return [
    quotaStatusTool,
    modelRankingTool,
    mcpServersTool,
    skillsInventoryTool,
    pluginInventoryTool,
    cliInventoryTool,
    vaultListTool,
  ];
}
