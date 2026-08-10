import { z } from 'zod';

/**
 * Typed feature-flag contracts for Nexus.
 * Fail-closed: unknown or disabled flags must not enable effectful paths.
 */

export const FEATURE_FLAG_CHANNELS = [
  'dev',
  'dogfood',
  'preview',
  'stable',
] as const;
export type FeatureFlagChannel = (typeof FEATURE_FLAG_CHANNELS)[number];

export const featureFlagChannelSchema = z.enum(FEATURE_FLAG_CHANNELS);

export const featureFlagDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-zA-Z0-9._-]*$/),
    owner: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
    /** Lowest channel where the flag may be on by default. */
    channel: featureFlagChannelSchema,
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Planned removal date (YYYY-MM-DD); overdue flags should be cleaned up. */
    removeAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** When true, resolution always returns false regardless of overrides. */
    killSwitch: z.boolean().default(false),
    /** Emit minimal telemetry on evaluation (no secrets). */
    telemetry: z.boolean().default(true),
    /**
     * Default when channel policy allows the flag. Fail-closed products should
     * keep this false until the feature is proven.
     */
    defaultEnabled: z.boolean().default(false),
  })
  .strict();

export type FeatureFlagDefinition = z.infer<typeof featureFlagDefinitionSchema>;

export const featureFlagOverrideSchema = z
  .object({
    id: z.string().min(1).max(128),
    enabled: z.boolean(),
  })
  .strict();

export type FeatureFlagOverride = z.infer<typeof featureFlagOverrideSchema>;

export const featureFlagOverridesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    overrides: z.array(featureFlagOverrideSchema).max(512),
  })
  .strict();

export type FeatureFlagOverridesFile = z.infer<
  typeof featureFlagOverridesFileSchema
>;

export const FEATURE_FLAG_IDS = {
  terminalCommandBlocks: 'feature.terminal.commandBlocks',
  missionEventJournal: 'feature.mission.eventJournal',
  missionWarmupAdvisories: 'feature.mission.warmupAdvisories',
  missionWorkerHandoffTtl: 'feature.mission.workerHandoffTtl',
  searchMixer: 'feature.search.mixer',
  contextualPanel: 'feature.ui.contextualPanel',
  codemirrorEditor: 'feature.editor.codemirror',
  mcpHub: 'feature.mcp.hub',
  skillsCatalog: 'feature.skills.catalog',
  nexusMemory: 'feature.memory.nexusMemory',
  /** Memória agentic por workspace (retain/recall FTS5) — entrega C2. */
  workspaceMemory: 'feature.memory.workspaceMemory',
  autonomyProfiles: 'feature.autonomy.profiles',
  /** E2E relay transport for the mobile companion (blind relay + AES-256-GCM). */
  remoteRelayTransport: 'feature.remote.relayTransport',
  /** Deterministic parallel mission task scheduler (worktree fan-out). */
  parallelScheduler: 'orch.parallelScheduler',
  /** Auto-fechar panes não-worker (spawn manual / agentes de ferramenta) após idle > N s. */
  paneNonWorkerAutoClose: 'feature.pane.nonWorkerAutoClose',
} as const;

export type FeatureFlagId =
  (typeof FEATURE_FLAG_IDS)[keyof typeof FEATURE_FLAG_IDS];

/**
 * Product foundations. Na fase atual (operador único, sem usuários externos)
 * as superfícies prontas ficam default-ON para serem descobertas em uso real;
 * o painel Labs em Configurações e o kill switch mantêm a autoridade final de
 * desligamento. Permanecem default-OFF apenas as capacidades que dependem de
 * infra externa (relay E2E sem URL hospedada) ou que ainda não têm consumidor
 * no produto (autonomy.profiles) — ligá-las hoje seria um no-op. O scheduler
 * segue habilitado — seu loop de produção é fail-closed atrás de missão
 * aprovada e plano selado.
 */
export const BUILTIN_FEATURE_FLAGS: readonly FeatureFlagDefinition[] = [
  {
    id: FEATURE_FLAG_IDS.terminalCommandBlocks,
    owner: 'terminal',
    description:
      'Semantic CommandBlock layer + OSC 133 shell integration (PTY stream remains visual source of truth).',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.missionEventJournal,
    owner: 'orch',
    description:
      'Append-only mission_events journal with consumer cursors and ACK/replay.',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.missionWarmupAdvisories,
    owner: 'orch',
    description:
      'Warm-up read-only de reviewer/QA na onda 1 das missões Guided: checklist preparado enquanto o executor implementa. Kill-switch imediato via override do operador.',
    channel: 'dev',
    createdAt: '2026-08-03',
    removeAfter: '2027-03-31',
    killSwitch: false,
    telemetry: false,
    // DEFAULT-ON (paridade Bridge/Overclock multi-pane na onda 1): reviewer/QA
    // abrem em read-only enquanto o executor implementa — o grid deixa de
    // parecer "só Maestro + 1 worker". E2E real-mission que ancora PTYs deve
    // desligar via override de flag (como workerHandoffTtl).
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.missionWorkerHandoffTtl,
    owner: 'orch',
    description:
      'Worker TTL pós-handoff (paridade Overclock §a#1): worker idle com todos os handoffs consumidos é encerrado ~30s depois, liberando o pane. DEFAULT-ON — restaura a aresta close→wake incondicional. Opt-out via override de flag para E2E real-mission (ancora workers a PTYs vivos).',
    channel: 'dev',
    createdAt: '2026-08-04',
    removeAfter: '2027-03-31',
    killSwitch: false,
    telemetry: false,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.paneNonWorkerAutoClose,
    owner: 'orch',
    description:
      'Auto-fechar panes não-worker (spawn manual / agentes de ferramenta) idle além do TTL configurável (default 300s). Paridade Overclock commit 869c08f7.',
    channel: 'dev',
    createdAt: '2026-08-05',
    removeAfter: '2027-03-31',
    killSwitch: false,
    telemetry: false,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.searchMixer,
    owner: 'search',
    description:
      'Unified SearchMixer with debounce, cancel, generation counter, stable ranking.',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.contextualPanel,
    owner: 'ui',
    description: 'Unified contextual right panel (Browser/Editor/Git/Skills/…).',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.codemirrorEditor,
    owner: 'editor',
    description:
      'Workspace editor model (secure hash/dirty/limits). Textarea product path until CM6 dep lands.',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.mcpHub,
    owner: 'mcp',
    description:
      'Local MCP Hub: multi-transport config, Across Tools observe, fill-gaps sync.',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    // Ligado a pedido do operador; toda escrita em config de terceiros segue
    // click-gated (dry-run → confirmação → backup; fill-gaps nunca deleta).
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.skillsCatalog,
    owner: 'skills',
    description: 'Skills catalog UI, lockfile, attach/copy/insert flows.',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.nexusMemory,
    owner: 'memory',
    description:
      'Nexus-owned, Obsidian-readable Markdown projection of canonical memory.',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.workspaceMemory,
    owner: 'memory',
    description:
      'Workspace-scoped agentic memory (retain/recall/stats) over SQLite FTS5, shared by all hosted CLIs.',
    channel: 'dev',
    createdAt: '2026-07-15',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: true,
  },
  {
    id: FEATURE_FLAG_IDS.autonomyProfiles,
    owner: 'security',
    description: 'Explicit Inspect/Edit/Autonomous/Custom autonomy profiles.',
    channel: 'dev',
    createdAt: '2026-07-13',
    removeAfter: '2026-12-31',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: false,
  },
  {
    id: FEATURE_FLAG_IDS.remoteRelayTransport,
    owner: 'remote',
    description:
      'E2E transport for the mobile companion: blind relay rooms + AES-256-GCM sealed frames. Relay URL must be configured explicitly; never defaults to a public relay.',
    channel: 'dev',
    createdAt: '2026-07-15',
    removeAfter: '2027-06-30',
    killSwitch: false,
    telemetry: true,
    defaultEnabled: false,
  },
  {
    id: FEATURE_FLAG_IDS.parallelScheduler,
    owner: 'orch',
    description:
      'Deterministic parallel task scheduler: ready+disjoint waves via worktrees, serial MergeQueue, fail-closed ownership enforcement. Enabled and operational in release configuration.',
    channel: 'dev',
    createdAt: '2026-07-14',
    removeAfter: '2027-06-30',
    killSwitch: false,
    telemetry: true,
    // The production loop still requires an approved mission contract and a
    // sealed task plan before any worker pane or worktree is created.
    defaultEnabled: true,
  },
] as const;

const CHANNEL_RANK: Record<FeatureFlagChannel, number> = {
  dev: 0,
  dogfood: 1,
  preview: 2,
  stable: 3,
};

/**
 * Whether the runtime channel is allowed to enable a flag defined for `flagChannel`.
 * Example: flag.channel=preview is off on dogfood, on on preview/stable.
 */
export function channelAllowsFlag(
  runtimeChannel: FeatureFlagChannel,
  flagChannel: FeatureFlagChannel,
): boolean {
  return CHANNEL_RANK[runtimeChannel] >= CHANNEL_RANK[flagChannel];
}

export interface FeatureFlagResolution {
  readonly id: string;
  readonly enabled: boolean;
  readonly reason:
    | 'kill-switch'
    | 'unknown-flag'
    | 'channel-blocked'
    | 'override'
    | 'default';
}

export function resolveFeatureFlag(
  definition: FeatureFlagDefinition | undefined,
  options: {
    runtimeChannel: FeatureFlagChannel;
    override?: boolean;
  },
): FeatureFlagResolution {
  if (!definition) {
    return { id: 'unknown', enabled: false, reason: 'unknown-flag' };
  }
  if (definition.killSwitch) {
    return { id: definition.id, enabled: false, reason: 'kill-switch' };
  }
  if (!channelAllowsFlag(options.runtimeChannel, definition.channel)) {
    return { id: definition.id, enabled: false, reason: 'channel-blocked' };
  }
  if (typeof options.override === 'boolean') {
    return {
      id: definition.id,
      enabled: options.override,
      reason: 'override',
    };
  }
  return {
    id: definition.id,
    enabled: definition.defaultEnabled,
    reason: 'default',
  };
}
