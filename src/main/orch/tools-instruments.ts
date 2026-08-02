import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import type { AgentGateContext } from './gate';
import { homeRelativeDirOf, OUTSIDE_HOME_LABEL } from './home-relative-path';

/**
 * Instrument panel — the five READ-ONLY consultations a pilot needs before
 * deciding. Everything else in the nexus_* namespace is a hand (spawn, write,
 * merge, generate); these are gauges.
 *
 *   nexus_quota_status      how much fuel is left, per provider/account
 *   nexus_model_ranking     what the product's own radar says about models
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
const MAX_MCP_SERVERS = 64;
const MAX_MCP_TOOLS_PER_SERVER = 32;
const MAX_MCP_KEYS = 32;
const MAX_SKILL_ITEMS = 200;
const DEFAULT_SKILL_LIMIT = 100;
const MAX_GATE_SKILLS = 64;
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RANKING_ENTRIES)
      .catch(MAX_RANKING_ENTRIES)
      .default(DEFAULT_RANKING_LIMIT),
  })
  .strict();

const modelRankingTool: McpToolDef = {
  name: 'nexus_model_ranking',
  description:
    "Read the product's own model ranking (Settings → Ranking LLMs) for a " +
    'dimension: overall | coding | reasoning | frontend | security. Consult ' +
    'BEFORE choosing which model does a piece of work. Public data only — no ' +
    'accounts, no keys. Entries carry `estimate: true` when the score comes ' +
    'from offline fixtures rather than a real audit; treat those as a hint, ' +
    'not evidence. Models with no score in the requested dimension are ' +
    'omitted and counted, never given an invented number.',
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
      limit: { type: 'number', description: 'Max entries (default 20).' },
    },
  },
  handler: async (args) => {
    const input = rankingInputSchema.parse(args);

    let snapshot: {
      generatedAt: string;
      suiteId: string;
      suiteRevision: string;
      entries: ReadonlyArray<{
        id: string;
        adapterId: string;
        modelId: string;
        overall: number;
        coding?: number;
        reasoning?: number;
        frontend?: number;
        security?: number;
        costTier?: string;
        confidence?: number;
        estimate?: boolean;
        sourceLabel?: string;
        rank?: number;
      }>;
    };
    try {
      const { getPublicModelRanking } = await import('../eval/eval-ipc');
      snapshot = getPublicModelRanking();
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: `model ranking unavailable: ${reasonFrom(error)}`,
        dimension: input.dimension,
        truncated: false,
        entries: [],
      });
    }

    const pool = input.adapterId
      ? snapshot.entries.filter((e) => e.adapterId === input.adapterId)
      : snapshot.entries;
    const scoreOf = (e: (typeof pool)[number]): number | undefined =>
      e[input.dimension as RankingDimension];
    const scored = pool.filter((e) => typeof scoreOf(e) === 'number');
    const omitted = pool.length - scored.length;

    if (scored.length === 0) {
      return Object.freeze({
        available: false,
        reason:
          omitted > 0
            ? `no ranking entries carry a "${input.dimension}" score (${omitted} model(s) scored in other dimensions only)`
            : 'no ranking entries are available for this filter',
        dimension: input.dimension,
        generatedAt: snapshot.generatedAt,
        truncated: false,
        entries: [],
      });
    }

    const ordered = [...scored].sort(
      (a, b) => (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0),
    );
    const capped = ordered.slice(0, Math.min(input.limit, MAX_RANKING_ENTRIES));

    return Object.freeze({
      available: true,
      dimension: input.dimension,
      generatedAt: snapshot.generatedAt,
      suiteId: snapshot.suiteId,
      suiteRevision: snapshot.suiteRevision,
      truncated: ordered.length > capped.length,
      omittedForMissingDimension: omitted,
      entries: capped.map((e, index) => ({
        id: e.id,
        adapterId: e.adapterId,
        modelId: e.modelId,
        score: scoreOf(e) as number,
        overall: e.overall,
        ...(e.costTier !== undefined ? { costTier: e.costTier } : {}),
        ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
        estimate: e.estimate === true,
        ...(e.sourceLabel !== undefined ? { sourceLabel: e.sourceLabel } : {}),
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
    "agent's OWN skill gate (allowlist) — never another agent's. Absolute " +
    'paths are never returned. Read-only: installing is a separate, ' +
    'explicitly-granted tool.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['skill', 'agent', 'all'],
        description: 'Which catalog kind to list (default skill).',
      },
      limit: { type: 'number', description: 'Max items (default 100).' },
    },
  },
  handler: async (args, ctx) => {
    const input = skillsInputSchema.parse(args);
    const gate = {
      restricted: ctx.allowedSkills !== null,
      allowed: ctx.allowedSkills
        ? ctx.allowedSkills.slice(0, MAX_GATE_SKILLS)
        : null,
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

    const capped = matching.slice(0, Math.min(input.limit, MAX_SKILL_ITEMS));
    return Object.freeze({
      available: true,
      gate,
      truncated: matching.length > capped.length,
      counts,
      items: capped.map((item) => ({
        name: item.name,
        kind: item.kind,
        source: homeRelativeSource(item.file),
        sizeBytes: item.size,
        modifiedAt: item.modifiedAt,
      })),
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
    'capability ladder. Consult BEFORE routing or rerouting work to a ' +
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
      truncated:
        adapters.length > capped.length ||
        capped.some((a) => a.models.list.length > MAX_MODELS_PER_CLI),
      clis: capped.map((adapter) => {
        const auth = authByAdapter.get(adapter.id);
        return {
          adapterId: adapter.id,
          label: adapter.label,
          kind: adapter.kind,
          installed: adapter.installed,
          binaryResolved: typeof adapter.resolvedBinPath === 'string' &&
            adapter.resolvedBinPath.length > 0,
          enabled: auth ? auth.enabled : null,
          authStrategy: auth ? auth.authStrategy : null,
          hasStoredKey: auth ? auth.hasKey : null,
          authReadyModelCount: auth ? (auth.authReadyModels?.length ?? 0) : null,
          defaultModel: adapter.models.default,
          modelCount: adapter.models.list.length,
          models: adapter.models.list.slice(0, MAX_MODELS_PER_CLI),
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

export function buildInstrumentTools(): McpToolDef[] {
  return [
    quotaStatusTool,
    modelRankingTool,
    mcpServersTool,
    skillsInventoryTool,
    cliInventoryTool,
  ];
}
