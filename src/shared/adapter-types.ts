import { z } from 'zod';

/**
 * Zod schemas and TypeScript types for the declarative CLI adapter system.
 * These are shared between main (validates JSON files) and renderer (receives
 * the trimmed AdapterInfo over IPC).
 *
 * Two adapter kinds:
 *  - cli-pty  : spawns a real PTY (interactive TUI agents — Claude, aider …)
 *  - api-provider : HTTP client (future chat pane — GLM, fugu …)
 */

const installSchema = z.object({
  method: z.enum(['brew', 'npm', 'pip', 'uv', 'cargo', 'manual']),
  command: z.string().min(1),
});

const authSchema = z.object({
  method: z.enum(['oauth', 'api_key', 'device_code', 'subscription', 'none']),
  envVarFallback: z.string().optional(),
  credentialStore: z.enum(['keychain', 'env']).optional(),
  loginHint: z.string().optional(),
  /**
   * Comando EXATO que autentica esta CLI num terminal (ex.: "codex login",
   * "opencode auth login"). O Nexus abre um terminal e roda isto — quem sabe o
   * fluxo é a própria CLI, nunca o Nexus. Ausente: cai no binário interativo
   * quando o método é OAuth (primeiro run pede login) ou em nada.
   */
  loginCommand: z.string().optional(),
});

const spawnConfigSchema = z.object({
  interactive: z.array(z.string()),
  headless: z.array(z.string()),
  ptyRequired: z.boolean(),
  resumeArgs: z.array(z.string()).default([]),
  extraArgs: z.array(z.string()).default([]),
  /**
   * Flag que aceita um session id DITADO pelo Nexus no spawn (ex.:
   * "--session-id" no claude). Com ele, a telemetria real de tokens atribui o
   * transcript ao pane deterministicamente, sem heurística de "spawn mais
   * recente". Omitido = o CLI gera o próprio id e a atribuição é por fallback.
   */
  sessionIdArg: z.string().optional(),
  /**
   * Flags de resume DIRECIONADO a uma sessão específica (ex.: ["--resume"] no
   * claude → `--resume <id capturado>`). Preferido sobre resumeArgs quando o
   * Nexus tem o session id real do pane; sem id capturado cai no resumeArgs.
   */
  resumeIdArgs: z.array(z.string()).optional(),
});

const envConfigSchema = z.object({
  static: z.record(z.string(), z.string()).default({}),
  passthrough: z.array(z.string()).default([]),
  ephemeralHome: z.boolean().default(false),
});

const modelsConfigSchema = z.object({
  flag: z.string(),
  list: z.array(z.string()),
  default: z.string(),
});

const promptInjectionSchema = z.object({
  method: z.enum(['stdin', 'arg', 'flag']),
  flag: z.string().optional(),
  trailingNewline: z.boolean().default(true),
  bracketedPaste: z.boolean().default(false),
});

const idlePatternSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('regex'), pattern: z.string() }),
  z.object({ type: z.literal('timeout'), ms: z.number().positive() }),
]);

const stateParsingSchema = z.object({
  idle: idlePatternSchema,
  busy: z
    .object({ type: z.literal('regex'), pattern: z.string() })
    .optional(),
  shellIntegration: z.boolean().default(false),
  exitCodes: z.record(z.string(), z.string()).default({}),
});

const quirksSchema = z
  .object({
    altScreen: z.boolean().default(false),
    requiresNoAutoUpdate: z.boolean().default(false),
    approvalFlag: z.string().optional(),
    mcpAutoload: z.boolean().default(false),
    /** Per-session Nexus MCP integration. `none` keeps the CLI worker-only. */
    nexusMcp: z
      .enum(['none', 'autoload', 'codex', 'agy', 'opencode', 'kimi', 'grok'])
      .default('none'),
  })
  .superRefine((quirks, ctx) => {
    if (quirks.nexusMcp === 'autoload' && !quirks.mcpAutoload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nexusMcp'],
        message: '`autoload` requires mcpAutoload:true',
      });
    }
  });

/**
 * Declarative control flags — how THIS CLI expresses permission mode, reasoning
 * effort and verbose output. Each CLI differs, so the mapping lives per adapter
 * and the settings UI only offers the modes an adapter actually supports.
 * Lets the user turn on "operate automatically" (yolo/bypass) per provider.
 */
const controlSchema = z
  .object({
    permission: z
      .object({
        /** Flag taking a mode value, e.g. "--permission-mode". */
        arg: z.string().optional(),
        /** Selectable mode → concrete value (e.g. { bypass:"bypassPermissions" }). */
        modes: z.record(z.string(), z.string()).default({}),
        /** Standalone full-auto args (e.g. ["--dangerously-skip-permissions"]). */
        yolo: z.array(z.string()).default([]),
        /** Explicit safe baseline overriding a dangerous user-level CLI config. */
        safe: z.array(z.string()).optional(),
        /**
         * Kernel/provider-enforced read-only confinement sequence (e.g.
         * ["--sandbox", "read-only"]). Declared only after a physical escape
         * probe proved the boundary holds; used by the governed read-only
         * lane instead of the interactive `safe` baseline.
         */
        readOnly: z.array(z.string()).optional(),
        /** Legacy adapter default. Nexus does not auto-enable non-empty modes. */
        default: z.string().default(''),
      })
      .optional(),
    effort: z
      .object({
        arg: z.string(),
        levels: z.array(z.string()).default([]),
      })
      .optional(),
    /** Flag enabling verbose output (e.g. "--verbose"). */
    verbose: z.string().optional(),
  })
  .default({});

export const cliPtyAdapterSchema = z.object({
  kind: z.literal('cli-pty'),
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(128),
  version: z.string().min(1),
  icon: z.string().max(8).default('🤖'),
  bin: z.string().min(1),
  detect: z.string().min(1),
  install: installSchema,
  auth: authSchema,
  spawn: spawnConfigSchema,
  env: envConfigSchema,
  models: modelsConfigSchema,
  promptInjection: promptInjectionSchema,
  stateParsing: stateParsingSchema,
  quirks: quirksSchema,
  control: controlSchema,
});

export const apiProviderAdapterSchema = z.object({
  kind: z.literal('api-provider'),
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(128),
  version: z.string().min(1),
  icon: z.string().max(8).default('🌐'),
  endpoint: z.string().url(),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']),
  auth: z.object({
    method: z.literal('api_key'),
    header: z.string(),
    scheme: z.string(),
    envVar: z.string(),
    keychainKey: z.string(),
  }),
  models: modelsConfigSchema,
  streaming: z.boolean().default(true),
  quirks: z.record(z.string(), z.unknown()).default({}),
});

export const adapterSchema = z.discriminatedUnion('kind', [
  cliPtyAdapterSchema,
  apiProviderAdapterSchema,
]);

export type CliPtyAdapter = z.infer<typeof cliPtyAdapterSchema>;
export type ApiProviderAdapter = z.infer<typeof apiProviderAdapterSchema>;
export type Adapter = z.infer<typeof adapterSchema>;

type NexusMcpQuirks = {
  mcpAutoload?: boolean;
  nexusMcp?: unknown;
};

/**
 * Single capability rule shared by main-process injection and renderer
 * metadata. Legacy custom adapters with only mcpAutoload:true remain capable;
 * an inconsistent nexusMcp:autoload declaration fails closed.
 */
export function hasNexusMcpCapability(quirks: NexusMcpQuirks): boolean {
  if (quirks.mcpAutoload === true) return true;
  return (
    quirks.nexusMcp === 'codex' ||
    quirks.nexusMcp === 'opencode' ||
    quirks.nexusMcp === 'kimi' ||
    quirks.nexusMcp === 'grok'
  );
}

export type ModelAvailability =
  | 'free'
  | 'cheap'
  | 'paid'
  | 'api-only'
  | 'deprecated';

export type ModelCostTier = 'free' | 'low' | 'medium' | 'high' | 'unknown';

export interface ModelQualityEvaluation {
  /** Normalized 0..100 scores produced by a reproducible Nexus evaluation set. */
  overall: number;
  coding?: number;
  reasoning?: number;
  frontend?: number;
  security?: number;
  evaluatedAt: string;
  source: string;
}

export interface ModelCatalogEntryInfo {
  id: string;
  availability?: ModelAvailability;
  costTier?: ModelCostTier;
  source?: string;
  warning?: string;
  quality?: ModelQualityEvaluation;
}

export type ModelInfoMap = Record<string, ModelCatalogEntryInfo>;

/**
 * Operational evidence for using a CLI as the mission coordinator.
 *
 * A declared Nexus MCP route is necessary, but it is not proof that the CLI
 * completes the governed dispatch → handoff → integration lifecycle. The
 * registry assigns this level from Nexus-owned evidence; adapter plugins do
 * not self-certify it.
 */
export type OrchestrationEvidence =
  | 'verified'
  | 'experimental'
  | 'unsupported';

/**
 * Main-owned capability ladder for one adapter.
 *
 * The first four fields describe host integration mechanics. The final three
 * are release qualifications and therefore must never be copied from adapter
 * JSON or inferred from a provider/model claim in the renderer.
 */
export interface AdapterCapabilityMatrix {
  /** Nexus has a concrete terminal/RPC launch path for this adapter kind. */
  launchable: boolean;
  /** Main can deliver a bounded mission prompt through the configured path. */
  promptInjectable: boolean;
  /** Main can observe coarse or protocol-native busy/idle/exit state. */
  statusObservable: boolean;
  /** Main has a concrete latest-session or exact-session resume path. */
  resumable: boolean;
  /** Release-qualified native confinement for unattended read-only work. */
  autonomousReadOnly: boolean;
  /** Release-qualified native workspace-write confinement for workers. */
  governedWriter: boolean;
  /** Nexus release gate passed for the complete Maestro lifecycle. */
  verifiedMaestro: boolean;
}

/**
 * Replace {{KEY}} placeholders in an argv array. Unknown keys resolve to empty
 * string. This is a pure function — safe to call in tests without side effects.
 */
export function resolvePlaceholders(
  args: readonly string[],
  vars: Readonly<Record<string, string>>,
): string[] {
  return args.map((arg) =>
    arg.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? ''),
  );
}

/**
 * Trimmed adapter summary that crosses the IPC boundary to the renderer.
 * The full adapter config (including auth env vars) never leaves the main process.
 */
export interface AdapterInfo {
  id: string;
  kind: 'cli-pty' | 'api-provider';
  label: string;
  icon: string;
  models: { list: string[]; default: string; info?: ModelInfoMap };
  installed: boolean;
  /**
   * Absolute path of the discovered CLI binary (same path spawn will use).
   * Null when not installed or for api-provider adapters.
   */
  resolvedBinPath?: string | null;
  installCommand: string;
  loginHint?: string;
  idleTimeoutMs: number;
  /**
   * Compatibility flag: true when the CLI declares a per-session Nexus MCP
   * route. Declaration alone is not operational proof; inspect
   * orchestrationEvidence before presenting it as verified.
   */
  orchestratorCapable: boolean;
  /**
   * Main can observe a terminal completion block and bind it to the exact
   * mission worker session. Unlike orchestratorCapable, this does not imply
   * that arbitrary Nexus review/context tools are available to the CLI.
   */
  taskHandoffCapable?: boolean;
  /**
   * Main owns a bidirectional PTY action/result channel for this CLI. The
   * channel can invoke the governed Nexus tool dispatcher and return a final
   * physical handoff without relying on provider MCP configuration.
   *
   * This is deliberately separate from taskHandoffCapable: a CLI may remain a
   * worker/reviewer even when it cannot safely coordinate a whole mission.
   */
  missionControlCapable?: boolean;
  /**
   * Main-owned release qualification for autonomous writes in a task
   * worktree. Optional for rolling compatibility; absence always means false.
   * This is stronger than cwd/worktree isolation and requires a provider
   * filesystem sandbox whose writable root is mechanically bounded.
   */
  autonomousWorkspaceWriteCapable?: boolean;
  /**
   * Nexus-owned confidence in the full coordinator lifecycle. Optional while
   * older renderer/main bundles coexist during an update.
   */
  orchestrationEvidence?: OrchestrationEvidence;
  /**
   * Explicit capability ladder projected by the main-owned registry.
   * Optional only for rolling renderer/main compatibility.
   */
  capabilities?: AdapterCapabilityMatrix;
}

/**
 * Safe compatibility read for AdapterInfo produced by an older main process:
 * a declared route is experimental until explicit evidence says otherwise.
 */
export function orchestrationEvidenceOf(
  adapter: Pick<AdapterInfo, 'orchestratorCapable' | 'orchestrationEvidence'>,
): OrchestrationEvidence {
  return (
    adapter.orchestrationEvidence ??
    (adapter.orchestratorCapable ? 'experimental' : 'unsupported')
  );
}

const EMPTY_ADAPTER_CAPABILITIES: AdapterCapabilityMatrix = Object.freeze({
  launchable: false,
  promptInjectable: false,
  statusObservable: false,
  resumable: false,
  autonomousReadOnly: false,
  governedWriter: false,
  verifiedMaestro: false,
});

/**
 * Safe reader for mixed-version AdapterInfo snapshots.
 *
 * Legacy release-owned writer/orchestration fields may prove the capabilities
 * they already represented. Missing lower-level facts such as resume remain
 * false instead of being guessed from an adapter id or label.
 */
export function adapterCapabilityMatrixOf(
  adapter:
    | Pick<
        AdapterInfo,
        | 'kind'
        | 'installed'
        | 'orchestratorCapable'
        | 'autonomousWorkspaceWriteCapable'
        | 'orchestrationEvidence'
        | 'capabilities'
      >
    | null
    | undefined,
): AdapterCapabilityMatrix {
  if (!adapter) return EMPTY_ADAPTER_CAPABILITIES;
  const explicit = adapter.capabilities;
  const governedWriter =
    explicit?.governedWriter === true ||
    adapter.autonomousWorkspaceWriteCapable === true;
  const verifiedMaestro =
    explicit?.verifiedMaestro === true &&
    orchestrationEvidenceOf(adapter) === 'verified'
      ? true
      : explicit === undefined &&
        orchestrationEvidenceOf(adapter) === 'verified';
  const autonomousReadOnly =
    explicit?.autonomousReadOnly === true ||
    (explicit === undefined && verifiedMaestro);
  return Object.freeze({
    launchable:
      explicit?.launchable === true ||
      (explicit === undefined &&
        adapter.installed &&
        adapter.kind === 'cli-pty'),
    promptInjectable:
      explicit?.promptInjectable === true ||
      (explicit === undefined &&
        (governedWriter || autonomousReadOnly || verifiedMaestro)),
    statusObservable:
      explicit?.statusObservable === true ||
      (explicit === undefined &&
        (governedWriter || autonomousReadOnly || verifiedMaestro)),
    resumable: explicit?.resumable === true,
    autonomousReadOnly,
    governedWriter,
    verifiedMaestro,
  });
}
