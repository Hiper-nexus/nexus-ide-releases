import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { ensureUtf8Locale } from "./pty-env-locale";
import { PTY_CHANNELS } from "../../shared/channels";
import type { SpawnRequest, PaneSessionState } from "../../shared/types";
import type { ProjectExecutionScope } from "../../shared/types";
import type { SquadCliPolicy } from "../../shared/settings-types";
import { sharedAgentAuthFamily } from "../../shared/agent-auth-family";
import type { MissionPaneAuthoritySeal } from "../../shared/orch-types";
import { PET_STUDIO_SQUAD_ID } from "../../shared/pet-studio";
import { isAdvisoryUnconfinedCli } from "../../shared/mission-advisory";
import type { CliPtyAdapter } from "../../shared/adapter-types";
import { resolvePlaceholders } from "../../shared/adapter-types";
import type { BoundSpawnAuthority } from "../orch/spawn-authority";
import {
  isMissionBoundCodexWorkspaceAuthority,
  isPetStudioNativeWorkspaceAuthority,
  requiresReadOnlyNativeAuthority,
  secureAutonomousCliArgs,
} from "./autonomous-cli-policy";
import type {
  PtyHost,
  PtyProcHandle,
  PtySessionHandlers,
  PtySpawnSpec,
} from "./pty-host-core";
import {
  applyShellIntegrationEnv,
  cleanupShellIntegrationPaths,
  shellIntegrationSpawnArgs,
} from "../terminal/shell-integration-env";
import { scrubManagedSessionAuth } from "../adapters/managed-credentials";
import { resolveSpawnBinary } from "../path-resolver";
import {
  isBuiltinAdapter,
  resolveAdapterBinary,
} from "../adapters/adapter-registry";
import { resolveGovernedCliProfile } from "../orch/governed-cli-profile";
import {
  deliverGrantedSkillsToProviderHome,
  prepareCodexGovernedSession,
  prepareCodexOperatorMissionHome,
  type CodexGovernedProcessSandbox,
} from "../orch/cli-mcp-session-config";
import { requiresSpawnGate } from "../orch/spawn-home-policy";
import {
  codexGovernedSandboxLaunchMode,
  sealCodexPrivateProcessEnvironment,
} from "./codex-native-authority";
import {
  qualifyTrustedNativeConfinementLaunch,
  revalidateTrustedNativeConfinementLaunch,
  supportsPinnedNativeConfinementAuthenticity,
  type TrustedNativeConfinementLaunch,
} from "./trusted-native-cli-binary";
import {
  currentDarwinPtySupervisorRuntime,
  resolveDarwinPtySupervisor,
  resolvePackagedDarwinLaunchAuthorizationReadPaths,
} from "./darwin-pty-supervisor";
import { buildScopedExecPlan, createScopedSandboxHome } from "../runtime/process-sandbox";
import { linkedWorktreeGitPaths } from "../runtime/linked-worktree-git-paths";
import {
  assertAdvisoryConfinement,
  requiresAdvisoryProcessSandbox,
  resolveAdvisoryProcessSandbox,
} from "./advisory-process-sandbox";
import {
  resolveAgyNativeProfile,
  resolveNativeUserHome,
} from "./agy-native-profile";
import { resolveMissionCliExecutionPolicy } from "./mission-cli-execution-policy";
import { getOrchSettings } from "../persistence/settings-store";
import { assertSafePtyPrompt } from "../orch/pty-prompt-safety";
import {
  applyGatewayBaseUrls,
  applyGatewayCredential,
  GATEWAY_API_KEY_ENV,
  GATEWAY_OUT_OF_REACH_VARS,
  gatewayForwardsProviderCredential,
  gatewayRoutedVars,
  normalizeGatewayBaseUrl,
  resolveGatewayApiKey,
  resolveGatewayBaseUrl,
} from "./gateway-env";
import { publishObserverFrame } from "../orch/observer-bus";

/**
 * Owns every live PTY session — one per pane, addressed by an opaque id. The
 * native node-pty handles live in a separate utilityProcess (pty-host-*.ts); a
 * session's `proc` is a proxy that posts control messages there. All the
 * security-relevant work (env allowlist, argv, ownership, idle state machine,
 * orchestration taps) stays HERE, in trusted main-process code. Data streams
 * main -> renderer over IPC events; input flows renderer -> main.
 *
 * The concrete host is INJECTED (setPtyHost) rather than imported so this module
 * never pulls electron into its graph and stays unit-testable.
 */

interface Session {
  proc: PtyProcHandle;
  /**
   * Renderer currently presenting this session. Mission agents may be
   * headless (`null`): the main coordinator remains their lifecycle owner and
   * a later renderer can adopt the same PTY without restarting the provider.
   */
  wc: WebContents | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  state: PaneSessionState;
  /** Last state an agent hook asserted; "busy" suppresses the idle timer. */
  hookState?: PaneSessionState;
  /** Releases a stale hook "busy" if the matching idle signal never arrives. */
  hookBusyTimer: ReturnType<typeof setTimeout> | null;
  /** Spawn cwd — workspace attribution (media output, telemetry). */
  cwd: string;
  /** Main-owned identity for cli-agent panes; never sourced from pane sync. */
  agent: OwnedAgentSessionInfo | null;
  missionOrchestratorGrantAvailable: boolean;
  missionOrchestratorGrantExpiresAt: number | null;
  missionOrchestratorGrantTimer: ReturnType<typeof setTimeout> | null;
  outputSequence: number;
  acknowledgedSequence: number;
  replay: Array<{ sequence: number; data: string }>;
  /** Sum of `replay` data lengths — maintained incrementally, never walked. */
  replayChars: number;
  /** Throttle marker for the output-backpressure warning. */
  lastBackpressureWarnAt: number;
  /** Temp ZDOTDIR/bashrc dirs for OSC 133 — cleaned on session end. */
  shellIntegrationCleanup: string[];
}

export interface OwnedAgentSessionInfo {
  sessionId: string;
  paneId?: string;
  adapterId: string;
  model?: string;
  /** Exact main-sealed model request before adapter alias normalization. */
  requestedModel?: string;
  accountId?: string;
  effort?: string;
  cwd: string;
  scope: BoundSpawnAuthority["scope"];
  source: BoundSpawnAuthority["source"];
  role: "orchestrator" | "worker" | "user";
  missionId?: string;
  squadId?: string;
  agentName?: string;
  immediateMissionTitle?: string;
  immediateMissionGoal?: string;
  workerIncarnationId?: string;
  readOnly: boolean;
  /**
   * Provider-native mutation confinement. This is independent from `readOnly`,
   * which scopes the Nexus MCP surface and would otherwise prevent a
   * delegate-only orchestrator from spawning audited workers.
   */
  nativeReadOnly?: boolean;
  allowedTools: string[] | null;
  allowedSkills: string[] | null;
  authoritySeal?: MissionPaneAuthoritySeal;
}

const sessions = new Map<string, Session>();
interface PhysicalTerminationFlight {
  readonly sessionId: string;
  readonly session: Session;
  readonly exited: Promise<void>;
  readonly resolveExited: () => void;
  rootExit: { readonly exitCode: number; readonly signal?: number } | null;
  physicalTreeProven: boolean;
  revocationPublished: boolean;
  attempt: Promise<boolean> | null;
}
const physicalTerminationFlights = new Map<string, PhysicalTerminationFlight>();
let allSessionsTerminationFlight: Promise<TerminateAllSessionsResult> | null =
  null;
let allSessionsTerminationInProgress = false;
let allSessionsTerminationSealed = false;
let counter = 0;
const MISSION_ORCHESTRATOR_GRANT_TTL_MS = 120_000;
const MAX_NATIVE_INITIAL_PROMPT_BYTES = 64 * 1024;

let ptyHost: PtyHost | null = null;
let agentHookEndpointPath: string | null = null;

export function configureAgentHookEndpointPath(
  endpointPath: string | null,
): void {
  if (
    endpointPath !== null &&
    (!path.isAbsolute(endpointPath) || endpointPath.includes("\0"))
  ) {
    throw new Error("invalid agent hook endpoint path");
  }
  agentHookEndpointPath = endpointPath;
}

/** Wire the utilityProcess-backed host (called once at IPC bootstrap). */
export function setPtyHost(host: PtyHost): void {
  ptyHost = host;
}

function requireHost(): PtyHost {
  if (!ptyHost) throw new Error("PTY host not initialized");
  return ptyHost;
}

/** node-pty accepts `string | undefined` values; the host protocol wants a
 * plain, structured-cloneable string map — drop undefined entries. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Orchestration taps. The orchestration layer (embedded MCP server, handoff
 * parser, idle delivery) observes every session without owning any: data
 * chunks feed ring buffers + the legacy handoff parser, state changes feed
 * pane_wait_idle and idle delivery, exits clean the registries up.
 */
export type SessionDataTap = (sessionId: string, data: string) => void;
export type SessionStateTap = (
  sessionId: string,
  state: PaneSessionState,
) => void;
export type SessionExitTap = (
  sessionId: string,
  agent: OwnedAgentSessionInfo | null,
) => void;
/** Logical authority revocation starts before physical PTY exit is proven. */
export type SessionTerminationTap = (
  sessionId: string,
  agent: OwnedAgentSessionInfo | null,
) => void;

const dataTaps = new Set<SessionDataTap>();
const stateTaps = new Set<SessionStateTap>();
const exitTaps = new Set<SessionExitTap>();
const terminationTaps = new Set<SessionTerminationTap>();

export function tapSessionData(cb: SessionDataTap): () => void {
  dataTaps.add(cb);
  return () => dataTaps.delete(cb);
}

export function tapSessionState(cb: SessionStateTap): () => void {
  stateTaps.add(cb);
  return () => stateTaps.delete(cb);
}

export function tapSessionExit(cb: SessionExitTap): () => void {
  exitTaps.add(cb);
  return () => exitTaps.delete(cb);
}

export function tapSessionTermination(cb: SessionTerminationTap): () => void {
  terminationTaps.add(cb);
  return () => terminationTaps.delete(cb);
}

/** Route a non-PTY process exit through the same orchestration lifecycle. */
export function publishExternalSessionExit(sessionId: string): void {
  fireTaps(exitTaps, sessionId, null);
}

function fireTaps<T extends (...args: never[]) => void>(
  taps: Set<T>,
  ...args: Parameters<T>
): void {
  for (const tap of taps) {
    try {
      tap(...args);
    } catch (err) {
      console.warn("[pty-manager] orchestration tap threw:", err);
    }
  }
}

/**
 * Decoration applied to a cli-agent spawn by the orchestration layer: extra
 * env (MCP endpoint + auth token, HOME override when needed), extra argv entries
 * (e.g. --mcp-config), and a callback binding the minted token to the
 * concrete sessionId once the PTY exists.
 */
export interface AgentSpawnDecoration {
  /** Main-owned bearer used only for internal governed-profile preparation. */
  authorityToken: string;
  env: Record<string, string>;
  extraArgs: string[];
  /**
   * Native-profile providers (AGY 1.1): the child keeps this HOME instead of
   * the sandbox-internal private home. Auth/config resolve from the real
   * profile; the kernel boundary grants only providerState*Paths below.
   */
  processHome?: string;
  /** Private writable runtime for the sandbox, when != HOME. */
  sandboxDir?: string;
  /** Exact provider-state paths the confined process may read. */
  providerStateReadPaths?: readonly string[];
  /** Exact provider-state paths the confined process may update. */
  providerStateWritePaths?: readonly string[];
  /** Exact Main-owned mission attachment files granted read-only to the child. */
  attachmentReadPaths?: readonly string[];
  /** Private shim binaries the confined worker may execute/read. */
  missionShimReadPaths?: readonly string[];
  /** Private shim dropbox paths the confined worker may update. */
  missionShimWritePaths?: readonly string[];
  onSpawned?: (sessionId: string) => void;
  /** Spawn-local token/shim cleanup only; mission attachment seals survive retry. */
  onSpawnFailed?: () => void;
}

export type AgentSpawnHook = (
  adapter: CliPtyAdapter,
  req: SpawnRequest,
  authority: BoundSpawnAuthority,
  /** Env already prepared for this spawn (API keys, managed CODEX_HOME/…). */
  preparedEnv?: Readonly<Record<string, string>>,
) => AgentSpawnDecoration | null;

let agentSpawnHook: AgentSpawnHook | null = null;
let squadCliPolicyLookup: () => SquadCliPolicy = () =>
  getOrchSettings().squadCliPolicy;

export function setAgentSpawnHook(hook: AgentSpawnHook | null): void {
  agentSpawnHook = hook;
}

/** Test seam for exercising both product modes without touching user settings. */
export function setSquadCliPolicyLookupForTests(
  lookup: (() => SquadCliPolicy) | null,
): void {
  squadCliPolicyLookup = lookup ?? (() => getOrchSettings().squadCliPolicy);
}

/**
 * Sessão de provider DITADA pelo Nexus no spawn (adapter.spawn.sessionIdArg):
 * a camada de telemetria real usa este id para atribuir o transcript do CLI ao
 * pane deterministicamente. Hook injetado (mesmo padrão do agentSpawnHook)
 * para o pty-manager continuar livre de dependências de cima.
 */
export interface DictatedSessionInfo {
  /** Null for providers (for example Codex) that choose their own id. */
  providerSessionId: string | null;
  ptySessionId: string;
  adapterId: string;
  cwd: string;
  /** Stable renderer pane id bound by the trusted spawn authority. */
  paneId?: string;
  /** Vault account that owns this spawn (exact resume is account-bound). */
  accountId?: string;
}

export type SessionDictationHook = (info: DictatedSessionInfo) => void;

let sessionDictationHook: SessionDictationHook | null = null;

export function setSessionDictationHook(
  hook: SessionDictationHook | null,
): void {
  sessionDictationHook = hook;
}

/**
 * Lookup injetado de sessão de provider capturada (project scope, paneId) →
 * session id real — permite resume DIRECIONADO (`--resume <id>`) em vez do
 * genérico `--continue`. O caminho local nunca seleciona o store.
 * `accountId` must match the stored owner or exact resume is denied.
 */
export type ResumeSessionLookup = (
  scope: Readonly<ProjectExecutionScope>,
  paneId: string,
  adapterId: string,
  accountId?: string,
) => string | null;

let resumeSessionLookup: ResumeSessionLookup | null = null;

export function setResumeSessionLookup(
  lookup: ResumeSessionLookup | null,
): void {
  resumeSessionLookup = lookup;
}

function requireTrustedAgentCwd(
  authority: BoundSpawnAuthority | undefined,
): string {
  if (!authority?.scope || !authority.cwd) {
    throw new Error("cli-agent spawn requires trusted spawn authority");
  }
  let root: string;
  let cwd: string;
  try {
    root = fs.realpathSync(authority.scope.rootRealPath);
    cwd = fs.realpathSync(authority.cwd);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`authorized cli-agent cwd cannot be resolved: ${detail}`);
  }
  if (root !== authority.scope.rootRealPath || cwd !== authority.cwd) {
    throw new Error("authorized cli-agent workspace identity changed on disk");
  }
  const relative = path.relative(root, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("authorized cli-agent cwd escapes project scope");
  }
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error("authorized cli-agent cwd is not a directory");
  }
  return cwd;
}

export interface ShellSpawnAuthority {
  scope: BoundSpawnAuthority["scope"];
  cwd: string;
  shell: string;
}

function requireTrustedShellAuthority(
  authority: ShellSpawnAuthority | undefined,
): ShellSpawnAuthority {
  if (!authority?.shell || !path.isAbsolute(authority.shell)) {
    throw new Error("shell spawn requires trusted main-process authority");
  }
  requireTrustedAgentCwd({
    source: "direct-user",
    context: null,
    scope: authority.scope,
    cwd: authority.cwd,
  });
  return authority;
}

/**
 * Env vars that are safe (and expected) for an interactive dev shell. This is an
 * *allowlist*, not a denylist: the main process may hold API keys for CLI-agent
 * adapters in its own `process.env`, and those must never be inherited by every
 * child shell. Only names matched here — plus the `LC_*` locale prefix — are
 * forwarded to shell panes.
 */
const ENV_ALLOWLIST = new Set<string>([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "TMPDIR",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPATH",
  "INFOPATH",
  "LSCOLORS",
  "LS_COLORS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ALLUSERSPROFILE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "TEMP",
  "TMP",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

const ENV_ALLOW_PREFIXES = ["LC_"];

function baseChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const allowed =
      ENV_ALLOWLIST.has(key) ||
      ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (allowed) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // App GUI (Finder) não herda locale do shell: sem isto o CLI filho roda em
  // locale C e prompts pt-BR viram mojibake no empacotado (bug F, 05/08).
  ensureUtf8Locale(env);
  return env;
}

/**
 * Dynamic-linker injection vars. An adapter is loaded from the user plugin dir
 * (`~/.nexus/plugins/adapters`), which is a TRUST BOUNDARY: a malicious or
 * compromised plugin must not be able to set `DYLD_INSERT_LIBRARIES` (macOS) or
 * `LD_PRELOAD`/`LD_LIBRARY_PATH` (Linux) on the child PTY to load arbitrary code
 * into the agent process. Any adapter-declared env key matching these prefixes is
 * dropped, regardless of whether it came from `static` or `passthrough`.
 */
const DANGEROUS_ENV_PREFIXES = ["DYLD_", "LD_"];

function isDangerousEnvKey(key: string): boolean {
  return DANGEROUS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Base URL do gateway de IA local: settings do orquestrador primeiro, variável
 * de ambiente como fallback (mesma cadeia das keys de voz). A settings existe
 * para o recurso ser descobrível sem reiniciar o app exportando env var.
 */
export function configuredGatewayBaseUrl(): string | null {
  const configured = normalizeGatewayBaseUrl(
    getOrchSettings().aiGatewayBaseUrl,
    "gateway de IA (configurações)",
  );
  return configured ?? resolveGatewayBaseUrl();
}

/**
 * Observabilidade do gateway: sem isto o operador aponta as CLIs para um
 * gateway e não tem NENHUMA forma de saber se alguma foi de fato roteada — o
 * único sinal existente era o warn de URL inválida. Uma linha por adapter por
 * processo (o spawn se repete muitas vezes numa missão).
 */
const gatewayRoutingLogged = new Set<string>();

function logGatewayRouting(
  adapter: CliPtyAdapter,
  gatewayBaseUrl: string | null,
  gatewayApiKey: string | null,
): void {
  if (!gatewayBaseUrl) return;
  const logKey = `${adapter.id}::${gatewayBaseUrl}`;
  if (gatewayRoutingLogged.has(logKey)) return;
  gatewayRoutingLogged.add(logKey);

  const routed = gatewayRoutedVars(adapter);
  // `static` vence o gateway (aplicado depois em agentEnv): planos com
  // endpoint próprio — GLM, LongCat — continuam no endpoint deles.
  const pinnedByPlan = routed.filter((key) => key in adapter.env.static);
  const effective = routed.filter((key) => !(key in adapter.env.static));
  const outOfReach = adapter.env.passthrough.filter((key) =>
    GATEWAY_OUT_OF_REACH_VARS.has(key),
  );

  if (effective.length === 0) {
    const reason =
      pinnedByPlan.length > 0
        ? `endpoint do plano pinado (${pinnedByPlan.join(", ")})`
        : "não declara base URL roteável";
    console.info(`[gateway] ${adapter.id}: fora do gateway — ${reason}`);
  } else {
    console.info(
      `[gateway] ${adapter.id} → ${gatewayBaseUrl} (${effective.join(", ")})`,
    );
  }
  for (const key of outOfReach) {
    console.info(
      `[gateway] ${adapter.id}: ${key} não roteada — ` +
        `${GATEWAY_OUT_OF_REACH_VARS.get(key)}`,
    );
  }
  if (
    gatewayForwardsProviderCredential(adapter, gatewayBaseUrl, gatewayApiKey)
  ) {
    console.warn(
      `[gateway] ${adapter.id}: sem ${GATEWAY_API_KEY_ENV} — a credencial do ` +
        "provider (assinatura/API key) será enviada ao gateway",
    );
  }
}

/**
 * Build the env for a cli-agent session. Starts from the base allowlist, then
 * adds adapter-declared passthrough vars and static vars. Auth env vars enter
 * ONLY this specific PTY — not all shells. Linker-injection keys from the plugin
 * are refused as a trust-boundary control (see DANGEROUS_ENV_PREFIXES).
 *
 * `gatewayBaseUrl` é parâmetro de propósito: o mesmo adapter precisa render um
 * env de TRANSPORTE (com gateway, o que a CLI realmente usa) e um env de
 * IDENTIDADE (`null`, o que responde "que plano é este?"). Ver o spawn abaixo.
 */
export function agentEnv(
  adapter: CliPtyAdapter,
  gatewayBaseUrl: string | null = configuredGatewayBaseUrl(),
): NodeJS.ProcessEnv {
  const env = baseChildEnv();
  for (const key of adapter.env.passthrough) {
    if (isDangerousEnvKey(key)) {
      console.warn(
        `[pty-manager] refusing linker-injection passthrough env "${key}" from adapter "${adapter.id}"`,
      );
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Gateway local (OmniRoute-like) entre passthrough e static: o operador
  // aponta as CLIs para o gateway com uma variável só, e um adapter que PINA o
  // próprio endpoint em static (glm, longcat) continua intocado logo abaixo.
  applyGatewayBaseUrls(env, adapter, gatewayBaseUrl);
  for (const [key, value] of Object.entries(adapter.env.static)) {
    if (isDangerousEnvKey(key)) {
      console.warn(
        `[pty-manager] refusing linker-injection static env "${key}" from adapter "${adapter.id}"`,
      );
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Whether it is safe to push an IPC event to this webContents. Guards against a
 * PTY event (data/exit/state) arriving after the owning window closed or its
 * renderer crashed. `isDestroyed()` alone is insufficient: a freshly crashed
 * renderer still reports false, and send() would then log "Render frame was
 * disposed". Such late events are silently dropped, never crash the main process.
 */
function canSend(wc: WebContents | null): wc is WebContents {
  return Boolean(wc && !wc.isDestroyed() && !wc.isCrashed());
}

/**
 * Push backpressure budget per session. `replay` holds exactly the unacked
 * chunks and is trimmed at ~1 MB chars; once unacked output exceeds half that
 * window the renderer is provably not draining, so `wc.send` pauses — a
 * wedged renderer must not queue unbounded IPC inside the MAIN process.
 * Chunks keep landing in the capped replay window; the preload recover pull
 * drains them and the resulting acks resume the push. Half the window keeps
 * the full hole pullable before eviction.
 */
const MAX_UNACKED_OUTPUT_CHARS = 512 * 1024;
const OUTPUT_BACKPRESSURE_WARN_INTERVAL_MS = 30_000;

function warnOutputBackpressureThrottled(
  sessionId: string,
  session: Session,
): void {
  const now = Date.now();
  if (
    now - session.lastBackpressureWarnAt <
    OUTPUT_BACKPRESSURE_WARN_INTERVAL_MS
  ) {
    return;
  }
  session.lastBackpressureWarnAt = now;
  console.warn(
    `[pty-manager] output backpressure for ${sessionId}: ` +
      `${session.replayChars} unacked chars exceed ${MAX_UNACKED_OUTPUT_CHARS}; ` +
      `push paused until the renderer drains`,
  );
}

function emitStateChange(
  wc: WebContents | null,
  sessionId: string,
  state: PaneSessionState,
): void {
  if (canSend(wc)) {
    wc.send(PTY_CHANNELS.stateChange, { sessionId, state });
  }
  fireTaps(stateTaps, sessionId, state);
}

/**
 * An agent hook can assert "busy" to hold a pane out of idle during long,
 * silent internal work. Hooks are best-effort, though: if the matching idle
 * signal is lost (agent SIGKILLed, hook script crashed, Stop hook never ran)
 * while the process stays alive, `hookState` would pin the pane "busy" forever.
 * This watchdog bounds that — an actively working agent re-publishes hook
 * events per tool call (re-arming it), while a truly abandoned "busy" is
 * released so a quiet session can settle to idle instead of showing work that
 * has finished.
 */
const HOOK_BUSY_MAX_MS = 5 * 60_000;

function armHookBusyWatchdog(sessionId: string, session: Session): void {
  if (session.hookBusyTimer) clearTimeout(session.hookBusyTimer);
  session.hookBusyTimer = setTimeout(() => {
    session.hookBusyTimer = null;
    if (!sessions.has(sessionId)) return;
    if (session.hookState !== "busy") return;
    session.hookState = undefined;
    // Settle now only if the PTY is already quiet (no pending idle timer);
    // otherwise the in-flight idle timer settles once output stops.
    if (!session.idleTimer && session.state === "busy") {
      session.state = "idle";
      emitStateChange(session.wc, sessionId, "idle");
    }
  }, HOOK_BUSY_MAX_MS);
}

function armIdleTimer(sessionId: string, session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.idleTimeoutMs <= 0) return;
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (!sessions.has(sessionId)) return;
    if (session.hookState === "busy") return;
    session.state = "idle";
    emitStateChange(session.wc, sessionId, "idle");
  }, session.idleTimeoutMs);
}

function makeSessionId(): string {
  return `pty-${Date.now().toString(36)}-${++counter}`;
}

/**
 * Handle one data chunk from the host: push to the renderer, feed the
 * orchestration taps, and drive the busy/idle state machine. Extracted from the
 * old attachProc so a spawn path can build the host session handlers without
 * ever holding a live node-pty handle.
 */
function onSessionData(
  session: Session,
  sessionId: string,
  data: string,
): void {
  if (physicalTerminationFlights.get(sessionId)?.session === session) {
    // Authority is already revoked and physical teardown is in flight. Late
    // bytes from the old provider must not drive UI state, hooks or handoffs.
    return;
  }
  session.outputSequence += 1;
  const event = { sessionId, data, sequence: session.outputSequence };
  session.replay.push({ sequence: event.sequence, data });
  session.replayChars += data.length;
  let bufferedChars = 0;
  for (let index = session.replay.length - 1; index >= 0; index -= 1) {
    bufferedChars += session.replay[index].data.length;
    if (bufferedChars > 1_000_000) {
      session.replay.splice(0, index + 1);
      session.replayChars =
        bufferedChars - session.replay[index].data.length;
      break;
    }
  }
  if (canSend(session.wc)) {
    if (session.replayChars > MAX_UNACKED_OUTPUT_CHARS) {
      // Renderer is not draining: pause the push. The chunk above still
      // landed in the replay window, so the recover pull catches up and its
      // acks resume the push — no data loss, no unbounded main-side IPC queue.
      warnOutputBackpressureThrottled(sessionId, session);
    } else {
      session.wc.send(PTY_CHANNELS.data, event);
    }
  }
  fireTaps(dataTaps, sessionId, data);
  if (session.state !== "busy") {
    session.state = "busy";
    emitStateChange(session.wc, sessionId, "busy");
  }
  if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
}

/** Session lifecycle callbacks handed to the host at spawn time. */
function sessionHandlers(
  sessionId: string,
  getSession: () => Session,
): PtySessionHandlers {
  return {
    onData: (data) => onSessionData(getSession(), sessionId, data),
    onExit: (exitCode, signal) => finalizeSession(sessionId, exitCode, signal),
  };
}

/**
 * Teardown idempotente: notifica renderer + exit taps EXATAMENTE uma vez.
 * destroySession removia a sessão do Map antes do onExit, que então retornava
 * cedo — pty:exit nunca chegava ao renderer, waitForIdle pendurava até o
 * timeout e artefatos do gate (~/.nexus/ephemeral, mcp-configs) vazavam.
 */
function finalizeSession(
  sessionId: string,
  exitCode: number,
  signal?: number,
): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  let pendingTermination = physicalTerminationFlights.get(sessionId);
  if (!pendingTermination || pendingTermination.session !== s) {
    pendingTermination = ensurePhysicalTerminationFlight(sessionId, s);
  }
  if (!pendingTermination.physicalTreeProven) {
    pendingTermination.rootExit ??= {
      exitCode,
      ...(signal === undefined ? {} : { signal }),
    };
    pendingTermination.resolveExited();
    // Root exit alone does not release the agent/worktree exclusivity: a
    // captured detached descendant may still hold write authority.
    //
    // A natural exit may race immediately ahead of app shutdown. Ask the host
    // for its stable responsibility receipt now, while retaining this exact
    // main-owned identity in the shutdown inventory. On Darwin the signed
    // supervisor only exits after its whole responsibility cohort is empty.
    if (!pendingTermination.attempt) {
      void orchTerminateSession(sessionId);
    }
    return;
  }
  sessions.delete(sessionId);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  if (s.hookBusyTimer) clearTimeout(s.hookBusyTimer);
  if (s.missionOrchestratorGrantTimer) {
    clearTimeout(s.missionOrchestratorGrantTimer);
  }
  if (s.shellIntegrationCleanup.length > 0) {
    cleanupShellIntegrationPaths(s.shellIntegrationCleanup);
  }
  // M1: scrub plaintext auth.json from the managed home now that the CLI exited.
  scrubManagedSessionAuth(sessionId);
  if (canSend(s.wc)) {
    s.wc.send(PTY_CHANNELS.exit, { sessionId, exitCode, signal });
  }
  fireTaps(exitTaps, sessionId, s.agent ? cloneAgentInfo(s.agent) : null);
  const termination = physicalTerminationFlights.get(sessionId);
  if (termination?.session === s) {
    physicalTerminationFlights.delete(sessionId);
    termination.resolveExited();
  }
}

export interface SpawnedSession {
  sessionId: string;
  resumeMode?: "exact" | "latest" | "unsupported" | "fresh-context";
}

/** Spawn a shell PTY. */
export function spawnSession(
  wc: WebContents,
  req: SpawnRequest,
  authority: ShellSpawnAuthority,
): SpawnedSession {
  if (allSessionsTerminationInProgress) {
    throw new Error("PTY shutdown is in progress; new sessions are blocked");
  }
  const trusted = requireTrustedShellAuthority(authority);
  const shell = trusted.shell;
  const cwd = trusted.cwd;
  const sessionId = makeSessionId();
  const baseEnv = cleanEnv(baseChildEnv());
  const { env: shellEnv, cleanupPaths } = applyShellIntegrationEnv(
    baseEnv,
    shell,
  );
  const shellArgs = shellIntegrationSpawnArgs(shell, shellEnv);
  // Pane do operador abre como login shell (-l): .zprofile/.zlogin e o PATH
  // real da conta (homebrew, ~/.local/bin) só entram na cadeia de login.
  // bash com rcfile composto mantém o fluxo da shell integration (o composite
  // já carrega o ~/.bashrc), então o -l só entra sem NEXUS_BASHRC.
  const shellBaseName = path.basename(shell).toLowerCase();
  const loginArgs =
    shellBaseName.includes('bash') && shellEnv.NEXUS_BASHRC
      ? []
      : ['-l'];
  const spec: PtySpawnSpec = {
    sessionId,
    file: shell,
    args: [...loginArgs, ...shellArgs],
    cwd,
    cols: req.cols,
    rows: req.rows,
    env: shellEnv,
  };
  let session!: Session;
  try {
    const proc = requireHost().spawn(
      spec,
      sessionHandlers(sessionId, () => session),
    );
    session = {
      proc,
      wc,
      idleTimer: null,
      hookBusyTimer: null,
      idleTimeoutMs: 0,
      state: "spawning",
      cwd,
      agent: null,
      missionOrchestratorGrantAvailable: false,
      missionOrchestratorGrantExpiresAt: null,
      missionOrchestratorGrantTimer: null,
      outputSequence: 0,
      acknowledgedSequence: 0,
      replay: [],
      replayChars: 0,
      lastBackpressureWarnAt: 0,
      shellIntegrationCleanup: [...cleanupPaths],
    };
    sessions.set(sessionId, session);
    return { sessionId };
  } catch (err) {
    cleanupShellIntegrationPaths(cleanupPaths);
    throw err;
  }
}

/** User overrides from the provider settings hub, applied at spawn time. */
export interface AgentSpawnOverrides {
  binPath?: string | null;
  defaultModel?: string | null;
  extraArgs?: string[];
  keyEnv?: Record<string, string>;
  /**
   * Env vars stripped AFTER the adapter env is built — an authenticated
   * subscription CLI must not inherit e.g. ANTHROPIC_API_KEY, which would
   * silently divert billing from the plan to the API.
   */
  suppressEnv?: string[];
}

function normalizeAgentModel(adapter: CliPtyAdapter, model: string): string {
  if (adapter.id === "kimi" && model === "kimi-for-coding") {
    return "kimi-code/kimi-for-coding";
  }
  // OpenCode 1.17 requires provider/model. A stale unqualified preference is
  // not a valid fallback: omit --model and let OpenCode use its own configured
  // default instead of failing the pane at startup.
  if (adapter.id === "opencode" && model && !model.includes("/")) {
    return "";
  }
  return model;
}

function configOverrideValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if ((arg === "-c" || arg === "--config") && args[index + 1]) {
      values.push(args[index + 1]!);
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      values.push(arg.slice("--config=".length));
    }
  }
  return values;
}

function codexHookLoopbackNetworkEndpoint(
  env: Readonly<Record<string, string>>,
): { readonly executablePath: string; readonly port: number } | null {
  const raw = env.NEXUS_HOOK_URL;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Codex hook endpoint must be an absolute loopback URL");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.pathname !== "/hook/status" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Codex hook endpoint escaped the sealed loopback status route");
  }
  return {
    executablePath: "/usr/bin/curl",
    port,
  };
}

function assertExclusiveOrchestratorProcessAvailable(
  adapter: CliPtyAdapter,
  authority: BoundSpawnAuthority,
): void {
  if (authority.context?.role !== "orchestrator") return;
  const family = sharedAgentAuthFamily(adapter.id);
  if (!family) return;
  const conflict = [...sessions.values()]
    .map((session) => session.agent)
    .find(
      (agent) =>
        agent?.role === "orchestrator" &&
        sharedAgentAuthFamily(agent.adapterId) === family,
    );
  if (conflict) {
    throw new Error(
      `exclusive auth family ${family} already has a live orchestrator ` +
        `(${conflict.sessionId}); physical exit proof is required before spawn`,
    );
  }
}

/** Spawn a cli-agent PTY from a validated adapter. */
export function spawnAgentSession(
  wc: WebContents | null,
  req: SpawnRequest,
  adapter: CliPtyAdapter,
  overrides: AgentSpawnOverrides = {},
  authority: BoundSpawnAuthority,
): SpawnedSession {
  if (allSessionsTerminationInProgress) {
    throw new Error("PTY shutdown is in progress; new sessions are blocked");
  }
  const cwd = requireTrustedAgentCwd(authority);
  assertExclusiveOrchestratorProcessAvailable(adapter, authority);
  const model = normalizeAgentModel(
    adapter,
    req.model ?? overrides.defaultModel ?? adapter.models.default,
  );
  const argv = resolvePlaceholders(adapter.spawn.interactive, {
    MODEL: model,
    CWD: cwd,
    SESSION_ID: "",
    PROMPT: "",
  }).filter((a) => a.length > 0);

  // Absolute path only — bare names re-search PATH inside the PTY host, which
  // often has a minimal Finder PATH and misses ~/.kimi-code/bin, Homebrew, etc.
  const resolvedBin = resolveSpawnBinary(adapter.bin, overrides.binPath);
  let bin = resolvedBin?.binPath ?? null;
  if (!bin || !path.isAbsolute(bin)) {
    throw new Error(
      `${adapter.label}: missing absolute binary path for spawn ` +
        `(adapter.bin="${adapter.bin}"). Re-scan CLIs or set binPath in settings.`,
    );
  }
  let args = argv.slice(1);
  // Adapters whose interactive argv has no {{MODEL}} placeholder would
  // silently DROP the requested model (route_task picks grok-code-fast-1,
  // grok boots on its default). When a model was explicitly requested and the
  // adapter declares a model flag, append it.
  const explicitModel = req.model ?? overrides.defaultModel;
  const templateHasModel = adapter.spawn.interactive.some((a) =>
    a.includes("{{MODEL}}"),
  );
  const usesKimiTransientModel =
    adapter.id === "kimi" && Boolean(overrides.keyEnv?.KIMI_MODEL_NAME);
  if (
    explicitModel &&
    model &&
    !templateHasModel &&
    adapter.models.flag &&
    !usesKimiTransientModel
  ) {
    args.push(adapter.models.flag, model);
  }
  // Resume only when the captured provider session belongs to this account.
  // Cross-account failover must spawn fresh + inject a continuity pack instead.
  let resumeMode: SpawnedSession["resumeMode"];
  let trustedResumeArgs: string[] = [];
  // A persisted mission pane whose exact provider session died with the app
  // must not fail into a dead pane: the sealed mission contract stays the
  // authority, so the pane respawns FRESH under the same contract (no resume
  // argv) and the renderer delivers the mission continuity path. Same
  // philosophy as the cross-account failover above.
  let persistedMissionFreshContext = false;
  if (req.resume) {
    if (authority.source === "persisted-pane") {
      const captured =
        !req.resumeLatestOnly &&
        req.paneId &&
        adapter.spawn.resumeIdArgs?.length
          ? (resumeSessionLookup?.(
              authority.scope,
              req.paneId,
              adapter.id,
              req.accountId,
            ) ?? null)
          : null;
      if (captured) {
        args.push(...adapter.spawn.resumeIdArgs!, captured);
        trustedResumeArgs = [...adapter.spawn.resumeIdArgs!, captured];
        resumeMode = "exact";
      } else if (authority.context?.missionId) {
        persistedMissionFreshContext = true;
        resumeMode = "fresh-context";
      } else {
        // Authority anomaly, NOT physical death: a persisted pane without a
        // mission contract has no sanctioned fresh-context respawn.
        throw new Error(
          "persisted pane authority is not bound to a mission contract, so " +
            "no fresh-context respawn is authorized — retome a missão pelo card",
        );
      }
    } else {
      const captured =
        !req.resumeLatestOnly &&
        req.paneId &&
        adapter.spawn.resumeIdArgs?.length
          ? (resumeSessionLookup?.(
              authority.scope,
              req.paneId,
              adapter.id,
              req.accountId,
            ) ?? null)
          : null;
      if (captured) {
        args.push(...adapter.spawn.resumeIdArgs!, captured);
        trustedResumeArgs = [...adapter.spawn.resumeIdArgs!, captured];
        resumeMode = "exact";
      } else if (adapter.spawn.resumeArgs.length > 0) {
        args.push(...adapter.spawn.resumeArgs);
        resumeMode = "latest";
      } else {
        resumeMode = "unsupported";
      }
    }
  }

  // True only when argv actually asks the provider to resume a conversation.
  // The fresh-context fallback is a FRESH spawn under the sealed contract, so
  // it dictates a new provider session id like any other fresh spawn.
  const providerResumeRequested =
    req.resume === true && !persistedMissionFreshContext;

  // Telemetria real: dita o session id do provider em spawns FRESCOS (num
  // resume o CLI decide o id — a atribuição fica com o watcher de transcript).
  let dictatedSessionId: string | null = null;
  let trustedSessionArgs: string[] = [];
  if (adapter.spawn.sessionIdArg && !providerResumeRequested) {
    dictatedSessionId = randomUUID();
    args.push(adapter.spawn.sessionIdArg, dictatedSessionId);
    trustedSessionArgs = [adapter.spawn.sessionIdArg, dictatedSessionId];
  }
  if (overrides.extraArgs && overrides.extraArgs.length > 0) {
    args.push(...overrides.extraArgs);
  }
  const nativeInitialPrompt =
    (adapter.id === "agy" ||
      adapter.id === "codex" ||
      adapter.id === "claude" ||
      adapter.id === "opencode") &&
    authority.source === "pending" &&
    // Via Rápida: coordenação também larga com o prompt nativo — a colagem
    // pós-boot falhava contra TUIs reais (8/8 panes mudos, missão 10/08) e o
    // argumento de largada é o único canal que não depende de timing.
    (authority.context?.role === "worker" ||
      authority.context?.role === "orchestrator") &&
    Boolean(authority.context.missionId?.trim()) &&
    !req.resume
      ? authority.context.initialPrompt
      : undefined;
  let safeNativeInitialPrompt: string | undefined;
  if (nativeInitialPrompt !== undefined) {
    const safeInitialPrompt = assertSafePtyPrompt(nativeInitialPrompt);
    if (
      !safeInitialPrompt ||
      Buffer.byteLength(safeInitialPrompt, "utf8") >
        MAX_NATIVE_INITIAL_PROMPT_BYTES
    ) {
      throw new Error(
        `${adapter.label} initial prompt must contain ` +
          `1-${MAX_NATIVE_INITIAL_PROMPT_BYTES} bytes`,
      );
    }
    safeNativeInitialPrompt = safeInitialPrompt;
    if (adapter.id === "agy") {
      if (
        args.some(
          (arg) =>
            arg === "--print" ||
            arg.startsWith("--print=") ||
            arg === "--prompt-interactive" ||
            arg.startsWith("--prompt-interactive="),
        )
      ) {
        throw new Error(
          "AGY initial prompt conflicts with provider settings extraArgs",
        );
      }
      // Mission workers are one-shot jobs. `--prompt-interactive` executes the
      // first turn and then deliberately keeps the provider TUI alive; without
      // an AGY-native Stop hook that left the mission waiting forever while
      // terminal repaints kept echoing the fallback example. `--print` retains
      // PTY output (and therefore the physical handoff parser) but exits after
      // the governed task, so exit enforcement can also degrade explicitly.
      // AGY keeps its own workspace registry and otherwise sends tool calls to
      // ~/.gemini/antigravity-cli/scratch even when the child process cwd is
      // correct. Bind the exact Main-authorized root into that registry.
      args.push("--add-dir", cwd);
      args.push("--print", safeInitialPrompt);
    } else if (adapter.id === "claude") {
      // `claude [PROMPT]` abre o primeiro turno interativo já executando, sem
      // corrida com o editor da TUI fria — mesma forma do codex (linha ~1545).
      //
      // Sem varredura de "posicional já existente": o argv interativo do claude
      // é `--model <valor>` + extraArgs `--disallowedTools Task`, e VALORES de
      // flag são indistinguíveis de posicionais por inspeção ingênua — o
      // primeiro rascunho deste guard reprovou o próprio caminho feliz. O
      // prompt vem da autoridade selada do Main, que é a única fonte, e por
      // isso é anexado por último, como no codex.
      args.push(safeInitialPrompt);
    } else if (adapter.id === "opencode") {
      if (args.includes("run")) {
        throw new Error(
          "OpenCode initial prompt conflicts with provider settings extraArgs",
        );
      }
      // Mission advisors are one-shot workers. OpenCode's native headless
      // route retains PTY output and MCP tools while avoiding the Bun/OpenTUI
      // renderer that can segfault during terminal-capability negotiation.
      args.unshift("run");
      args.push(safeInitialPrompt);
    }
  }
  const sessionId = makeSessionId();
  const gatewayBaseUrl = configuredGatewayBaseUrl();
  const gatewayApiKey = resolveGatewayApiKey();
  // TRANSPORTE: o env que a CLI realmente recebe, com as base URLs no gateway.
  const env = agentEnv(adapter, gatewayBaseUrl);
  // IDENTIDADE: o mesmo env SEM o gateway. É ele que responde "que plano é
  // este?" para o spawn hook (HOME efêmero, credencial nativa, third-party).
  // O gateway é infraestrutura do próprio operador, não outro plano: se
  // vazasse para cá, o Claude de assinatura seria classificado como provider
  // de terceiro e spawnaria com HOME isolado e SEM credencial nenhuma — o
  // /login no meio da missão.
  const identityEnv = gatewayBaseUrl ? agentEnv(adapter, null) : env;
  const spawnEnvs = identityEnv === env ? [env] : [env, identityEnv];
  if (agentHookEndpointPath) {
    for (const target of spawnEnvs) {
      target.NEXUS_AGENT_HOOK_ENDPOINT = agentHookEndpointPath;
      target.NEXUS_PANE_KEY = sessionId;
    }
  }
  // Subscription-first: strip inherited key/token vars before any injection.
  for (const name of overrides.suppressEnv ?? []) {
    for (const target of spawnEnvs) delete target[name];
  }
  // Inject the keychain-stored API key as the adapter's auth env var. Linker
  // vars are still refused (isDangerousEnvKey) as a defense-in-depth check.
  for (const [key, value] of Object.entries(overrides.keyEnv ?? {})) {
    if (isDangerousEnvKey(key)) continue;
    for (const target of spawnEnvs) target[key] = value;
  }
  // A credencial do gateway vence a do provider e por isso entra DEPOIS do
  // keyEnv: se o operador configurou uma chave para o gateway, é ela que
  // autentica o tráfego que agora vai para lá.
  applyGatewayCredential(env, adapter, gatewayBaseUrl, gatewayApiKey);
  logGatewayRouting(adapter, gatewayBaseUrl, gatewayApiKey);

  // Orchestration decoration: MCP endpoint env, optional HOME override and
  // extra argv (e.g. --mcp-config). The hook is trusted main-process code.
  // Pass prepared env so MCP overlays (Grok/Kimi) can source managed-account homes.
  const preparedEnvSnapshot = cleanEnv(identityEnv);
  const decoration = agentSpawnHook
    ? agentSpawnHook(adapter, req, authority, preparedEnvSnapshot)
    : null;
  const trustedWorkspaceConfigOverrides =
    adapter.id === "codex" && decoration
      ? configOverrideValues(decoration.extraArgs)
      : [];
  const trustedDecorationArgs = decoration
    ? [...decoration.extraArgs]
    : [];
  const requestedNativeReadOnly = requiresReadOnlyNativeAuthority({
    source: authority.source,
    adapterId: adapter.id,
    role: authority.context?.role,
    missionId: authority.context?.missionId,
    squadId: authority.context?.squadId,
    agentName: authority.context?.agentName,
    allowedTools: authority.context?.allowedTools,
    allowedSkills: authority.context?.allowedSkills,
    contextRevision: authority.context?.contextRevision,
    authoritySeal: authority.context?.authoritySeal,
    readOnly: authority.context?.readOnly,
    nativeReadOnly: authority.context?.nativeReadOnly,
  });
  const petStudioWritableOrchestrator =
    isPetStudioNativeWorkspaceAuthority({
      source: authority.source,
      adapterId: adapter.id,
      role: authority.context?.role,
      missionId: authority.context?.missionId,
      squadId: authority.context?.squadId,
      agentName: authority.context?.agentName,
      allowedTools: authority.context?.allowedTools,
      allowedSkills: authority.context?.allowedSkills,
      contextRevision: authority.context?.contextRevision,
      authoritySeal: authority.context?.authoritySeal,
      readOnly: authority.context?.readOnly,
      nativeReadOnly: authority.context?.nativeReadOnly,
    });
  const missionBoundWritableWorker =
    isMissionBoundCodexWorkspaceAuthority({
      source: authority.source,
      adapterId: adapter.id,
      role: authority.context?.role,
      missionId: authority.context?.missionId,
      squadId: authority.context?.squadId,
      agentName: authority.context?.agentName,
      allowedTools: authority.context?.allowedTools,
      allowedSkills: authority.context?.allowedSkills,
      contextRevision: authority.context?.contextRevision,
      authoritySeal: authority.context?.authoritySeal,
      readOnly: authority.context?.readOnly,
      nativeReadOnly: authority.context?.nativeReadOnly,
    });
  if (
    authority.source === "persisted-pane" &&
    authority.context?.squadId === PET_STUDIO_SQUAD_ID &&
    !petStudioWritableOrchestrator
  ) {
    decoration?.onSpawnFailed?.();
    throw new Error(
      "persisted Pet Studio resume requires its exact current main-owned " +
        "Codex maker authority and pane seal",
    );
  }
  const writableWorkerIntent = Boolean(
    authority.context?.role === "worker" &&
      authority.context?.readOnly !== true &&
      authority.context?.nativeReadOnly !== true &&
      (authority.context?.missionId?.trim() ||
        authority.context?.contextRevision),
  );
  const isMissionParticipant = Boolean(
    authority.context &&
      (authority.context.missionId?.trim() ||
        authority.context.squadId?.trim() ||
        authority.context.contextRevision),
  );
  const executionPolicy = resolveMissionCliExecutionPolicy({
    squadCliPolicy: squadCliPolicyLookup(),
    isMissionParticipant,
    requestsNativeReadOnly: requestedNativeReadOnly,
    requestsWorkspaceWriteSandbox:
      writableWorkerIntent || petStudioWritableOrchestrator,
    requiresAdvisorySandbox: requiresAdvisoryProcessSandbox(
      adapter.id,
      authority.context?.readOnly === true,
    ),
    isPetStudioWorkspaceWriter: petStudioWritableOrchestrator,
  });
  const nativeReadOnly = executionPolicy.enforceNativeReadOnly;
  const governedWorkspaceWriter = Boolean(
    executionPolicy.enforceWorkspaceWriteSandbox &&
      (missionBoundWritableWorker || petStudioWritableOrchestrator),
  );
  if (decoration) {
    Object.assign(env, decoration.env);
    args.push(...decoration.extraArgs);
  }
  // Managed-home env from keyEnv must survive overlays that only care about MCP
  // config content (e.g. OpenCode XDG_DATA_HOME). Grok/Kimi intentionally
  // replace *_HOME with an ephemeral overlay built FROM that managed home.
  for (const homeKey of ["CODEX_HOME", "XDG_DATA_HOME"] as const) {
    const value = overrides.keyEnv?.[homeKey];
    if (value) env[homeKey] = value;
  }
  const gatedSpawn = requiresSpawnGate(authority.context);
  const governedProfile = Boolean(
    decoration &&
      executionPolicy.preparePrivateCodexProfile &&
      (gatedSpawn ||
        missionBoundWritableWorker ||
        petStudioWritableOrchestrator),
  );
  let trustedCodexPermissionProfile: string | undefined;
  let codexProcessSandbox: CodexGovernedProcessSandbox | undefined;
  if (governedProfile) {
    try {
      const token = decoration!.authorityToken;
      if (!token) {
        throw new Error("governed CLI spawn is missing its main-owned bearer");
      }
      const policy = resolveGovernedCliProfile(token);
      if (adapter.id === "codex") {
        const codex = prepareCodexGovernedSession(token, {
          providerHome: env.CODEX_HOME,
          allowedSkills: [...policy.allowedSkills],
          cwd,
          workspaceRoot: authority.scope.rootRealPath,
          // Pre-fill immutable config with the sealed model so the TUI does not
          // try to rewrite default-model / migration prefs under Seatbelt deny.
          model: model || undefined,
          codexResumeSessionId:
            resumeMode === "exact"
              ? trustedResumeArgs[trustedResumeArgs.length - 1]
              : undefined,
          codexNativeAuthority: governedWorkspaceWriter
            ? "workspace-write"
            : nativeReadOnly
              ? "read-only"
              : undefined,
        });
        Object.assign(env, codex.env);
        args.push(...codex.extraArgs);
        trustedCodexPermissionProfile =
          codex.codexPermissionProfile;
        codexProcessSandbox = codex.codexProcessSandbox;
      }
    } catch (error) {
      decoration?.onSpawnFailed?.();
      throw error;
    }
  } else if (
    decoration &&
    adapter.id === "codex" &&
    gatedSpawn &&
    executionPolicy.isFrictionless
  ) {
    // Autopiloto: não prepara o perfil governado completo (Seatbelt/deny),
    // mas AINDA isola mcp_servers ambient do ~/.codex real — senão cloudflare/
    // figma/higgsfield não autenticados travam o boot antes do prompt. Skills
    // concedidas caem no CODEX_HOME privado, não no perfil do operador.
    try {
      const token = decoration.env.NEXUS_MCP_TOKEN;
      if (!token) {
        throw new Error("gated CLI spawn is missing its main-owned bearer");
      }
      const operatorHome = prepareCodexOperatorMissionHome(token, {
        providerHome: env.CODEX_HOME,
      });
      Object.assign(env, operatorHome.env);
      const governedProfile = resolveGovernedCliProfile(token);
      deliverGrantedSkillsToProviderHome(
        "codex",
        os.homedir(),
        path.join(operatorHome.env.CODEX_HOME, "skills"),
        governedProfile.allowedSkills,
        governedProfile.allowedTools,
      );
    } catch (error) {
      // Isolamento de MCP ambient é disponibilidade do worker, não
      // confinamento: falha visível + spawn abortado bate fail-closed em
      // vez de herdar servers quebrados e travar a missão em silêncio.
      decoration?.onSpawnFailed?.();
      throw error;
    }
  }
  // Adapter-enforced argv is included before the autonomous policy. The final
  // policy removes inherited YOLO/bypass flags and is therefore the last word.
  args.push(...adapter.spawn.extraArgs);
  const unattendedNexusMcp = Boolean(
    adapter.id === "codex" &&
    authority.context?.missionId &&
    nativeReadOnly,
  );
  const enforceWorkspaceWriteSandbox =
    executionPolicy.enforceWorkspaceWriteSandbox;
  // Advisory-unconfined lane (for example kimi/agy/opencode read_only mission
  // workers): MCP read-only authority only, no native confinement claim.
  const advisoryUnconfinedParticipation = Boolean(
    !nativeReadOnly &&
      !enforceWorkspaceWriteSandbox &&
      authority.context?.readOnly === true &&
      authority.context?.role === "worker" &&
      authority.context?.missionId?.trim() &&
      isAdvisoryUnconfinedCli(adapter.id),
  );
  const operatorChoiceWorkspaceWrite = Boolean(
    executionPolicy.isFrictionless && writableWorkerIntent,
  );
  const frictionlessMissionWorker = Boolean(
    executionPolicy.isFrictionless &&
      authority.context?.role === "worker" &&
      authority.context?.missionId?.trim(),
  );
  const trustedCodexExternalProcessSandbox = Boolean(
    adapter.id === "codex" &&
      codexProcessSandbox &&
      process.platform === "darwin" &&
      codexGovernedSandboxLaunchMode(process.platform) === "outer-process",
  );
  let trustedNativeRuntimeReadPaths: string[] = [];
  let trustedNativeLaunch: TrustedNativeConfinementLaunch | null = null;
  try {
    if (
      (writableWorkerIntent || frictionlessMissionWorker) &&
      !authority.coordinationScope
    ) {
      throw new Error(
        "mission-bound worker requires a main-owned coordination scope",
      );
    }
    // O isolamento por worktree é do modo CONCORRENTE (opt-in), não de toda
    // missão. No caminho simples — o padrão desde 06/08 — o worker roda no
    // próprio workspace, e este guard não se aplica. A mensagem agora nomeia o
    // caminho em conflito e o que fazer, em vez de só declarar a exigência.
    if (
      authority.context?.isolatedWriter === true &&
      (writableWorkerIntent || frictionlessMissionWorker) &&
      authority.scope.rootRealPath ===
        authority.coordinationScope?.rootRealPath
    ) {
      throw new Error(
        "autopilot mission worker requires a physically distinct execution worktree: " +
          `execução e coordenação apontam para o mesmo caminho (${authority.scope.rootRealPath}). ` +
          "Este worker foi marcado como escritor concorrente (isolatedWriter), que exige " +
          "worktree própria. Rode a missão no modo simples (sem isolatedWriter) ou " +
          "verifique o provisionamento da worktree desta tarefa.",
      );
    }
    if (
      (nativeReadOnly || enforceWorkspaceWriteSandbox) &&
      !isBuiltinAdapter(adapter.id)
    ) {
      throw new Error(
        `adapter ${adapter.id} is not a trusted builtin for native confinement`,
      );
    }
    if (nativeReadOnly || enforceWorkspaceWriteSandbox) {
      if (
        providerResumeRequested &&
        trustedResumeArgs.length === 0
      ) {
        throw new Error(
          "governed native confinement resume requires an exact main-owned provider session",
        );
      }
      // Sealed Darwin image pin (Team ID + CDHash + release) is only for
      // adapters with an authenticity root (Codex/Claude today). Grok and
      // peers declare mechanical read-only via provider argv
      // (`--sandbox read-only`) without a Nexus pin — keep argv confinement
      // and leave `darwinExecutableSeal` unset. Unpinned adapters that
      // request workspace-write still fail closed in secureAutonomousCliArgs
      // (not here), so the error names the missing confinement profile.
      if (supportsPinnedNativeConfinementAuthenticity(adapter.id)) {
        trustedNativeLaunch = qualifyTrustedNativeConfinementLaunch({
          adapterId: adapter.id,
          requestedBinPath: bin,
          canonicalBinPath: resolveAdapterBinary(adapter.id),
        });
        bin = trustedNativeLaunch.executablePath;
        trustedNativeRuntimeReadPaths = [
          ...trustedNativeLaunch.runtimeReadPaths,
        ];
      }
    }
    args = secureAutonomousCliArgs(adapter, args, nativeReadOnly, {
      unattendedNexusMcp,
      enforceWorkspaceWriteSandbox,
      trustedWorkspaceConfigOverrides,
      trustedWorkspaceModel: model || undefined,
      trustedResumeArgs,
      trustedSessionArgs,
      trustedDecorationArgs,
      trustedCodexPermissionProfile,
      trustedCodexExternalProcessSandbox,
      advisoryUnconfinedParticipation,
      operatorChoiceWorkspaceWrite,
      operatorChoiceParticipation: executionPolicy.isFrictionless,
    });
    if (adapter.id === "codex" && safeNativeInitialPrompt !== undefined) {
      // `codex [PROMPT]` starts the first interactive turn without racing the
      // cold TUI editor. Append only after the governed argv allowlist has
      // reconstructed every option: this prompt came from Main's sealed
      // mission authority and must remain the sole positional argument.
      args.push(safeNativeInitialPrompt);
    }
    if (
      executionPolicy.enableLiveWeb &&
      adapter.id === "codex" &&
      !args.includes("--search")
    ) {
      args.push("--search");
    }
    if (
      executionPolicy.isFrictionless &&
      adapter.id === "agy" &&
      isMissionParticipant
    ) {
      // AGY authenticates against the native macOS account profile. Release
      // E2E runs Electron with an isolated HOME, so letting that environment
      // escape into the provider makes the preflight see a valid Keychain
      // session while the actual CLI falls back to OAuth and waits forever.
      // Resolve only HOME here: frictionless mode must still let a user open
      // AGY to authenticate when its provider-state directories do not exist.
      const nativeHome = resolveNativeUserHome({ inheritedHome: env.HOME });
      env.HOME = nativeHome;
      env.USERPROFILE = nativeHome;
      delete env.GEMINI_CLI_HOME;
    }
  } catch (error) {
    decoration?.onSpawnFailed?.();
    throw error;
  }

  let spawnFile = bin;
  let spawnArgs = args;
  let spawnCwd = cwd;
  let spawnEnv = cleanEnv(env);
  if (codexProcessSandbox) {
    try {
      if (adapter.id !== "codex" || !trustedCodexPermissionProfile) {
        throw new Error(
          "Codex outer sandbox requires a sealed native permission profile",
        );
      }
      if (
        process.platform === "darwin" &&
        trustedNativeLaunch?.providerNetworkProcessPaths.length !== 1
      ) {
        throw new Error(
          "Codex outer sandbox requires one pinned provider network process",
        );
      }
      spawnEnv = cleanEnv(
        sealCodexPrivateProcessEnvironment(spawnEnv, codexProcessSandbox),
      );
      if (
        codexGovernedSandboxLaunchMode(process.platform) === "outer-process"
      ) {
        // The utility process inserts this exact main-owned helper as the
        // Seatbelt target before it launches the authenticated vendor-native.
        // Resolve it under the same dev/packaged signature policy in Main.
        // Packaged launches additionally grant read-only access to the signed
        // .app because Security.framework needs its sealed bundle metadata to
        // authenticate the live Main/Helper launch-authority chain.
        const darwinPtySupervisorReadPaths =
          process.platform === "darwin"
            ? (() => {
                const runtime =
                  currentDarwinPtySupervisorRuntime(__dirname);
                return [
                  resolveDarwinPtySupervisor(runtime),
                  ...resolvePackagedDarwinLaunchAuthorizationReadPaths(runtime),
                ];
              })()
            : [];
        const worktreeGit = nativeReadOnly
          ? { readPaths: [], writePaths: [], protectedPaths: [] }
          : linkedWorktreeGitPaths(authority.scope.rootRealPath);
        const plan = buildScopedExecPlan({
          platform: process.platform,
          executable: bin,
          args,
          cwd,
          rootRealPath: authority.scope.rootRealPath,
          sandboxDir: codexProcessSandbox.sandboxDir,
          privateHome: codexProcessSandbox.processHome,
          privateTmp: codexProcessSandbox.processTmp,
          env: spawnEnv,
          readOnlyRoot: nativeReadOnly,
          // Codex's pinned vendor-native process needs the provider API and
          // loopback Nexus MCP. The inherited Seatbelt denies network to every
          // other descendant, including shell/package tools. Codex's inner
          // Seatbelt is disabled to avoid an unusable nested profile.
          sandboxProfile: "workspace-only",
          networkAllowedProcessPaths:
            process.platform === "darwin"
              ? trustedNativeLaunch?.providerNetworkProcessPaths
              : undefined,
          networkAllowedProcessEndpoints:
            process.platform === "darwin"
              ? (() => {
                  const endpoint =
                    codexHookLoopbackNetworkEndpoint(spawnEnv);
                  return endpoint ? [endpoint] : undefined;
                })()
              : undefined,
          // A linked worktree keeps its git metadata in the PARENT repo,
          // outside this execution scope root. Without these exact subtrees the
          // governed worker cannot commit its own work — and it needs BOTH
          // sides: without read, git cannot even recognise the directory
          // (`fatal: not a git repository`); without write it dies later on
          // `<repo>/.git/worktrees/<id>/index.lock`. Either way the worker
          // correctly refuses to report success and the mission blocks with the
          // file already produced. Read-only lanes never commit, so they get
          // neither.
          extraReadPaths: [
            ...codexProcessSandbox.providerStatePaths,
            ...(decoration?.missionShimReadPaths ?? []),
            ...(decoration?.attachmentReadPaths ?? []),
            ...trustedNativeRuntimeReadPaths,
            ...darwinPtySupervisorReadPaths,
            ...worktreeGit.readPaths,
          ],
          extraWritePaths: [
            ...codexProcessSandbox.providerStatePaths,
            ...(decoration?.missionShimWritePaths ?? []),
            ...worktreeGit.writePaths,
          ],
          protectedWritePaths: [
            ...codexProcessSandbox.protectedWritePaths,
            ...worktreeGit.protectedPaths,
          ],
        });
        spawnFile = plan.file;
        spawnArgs = plan.args;
        spawnCwd = plan.cwd;
        spawnEnv = cleanEnv(plan.env);
      }
    } catch (error) {
      decoration?.onSpawnFailed?.();
      throw error;
    }
  } else if (executionPolicy.applyAdvisorySandbox) {
    // Advisory CLIs have no native read-only profile, so a prompt is the only
    // thing asking them to behave — and a prompt is not a boundary. Nexus wraps
    // them in its OWN Seatbelt profile instead: the kernel mounts the execution
    // scope read-only, the per-session private runtime stays writable for auth
    // and session state, and only the CLI binary may reach the network. Failure
    // to build that boundary must abort the spawn, never downgrade it.
    //
    // Writable-runtime resolution (never the real user home):
    //  - decoration.sandboxDir present → that explicitly minted runtime;
    //  - decoration overrode HOME to an ephemeral overlay →
    //    the overlay itself is the private runtime;
    //  - HOME is still the real user home (Kimi/Grok/OpenCode carry their state
    //    in provider env vars, not HOME) → mint a fresh private runtime, keep
    //    the real HOME as processHome, and grant only the Nexus ephemeral
    //    artifact tree. The real home is NEVER the writable sandbox root.
    try {
      const isAgyNativeProfile = adapter.id === "agy";
      const agyNativeProfile = isAgyNativeProfile
        ? resolveAgyNativeProfile({ inheritedHome: spawnEnv.HOME })
        : null;
      const realHome = agyNativeProfile?.processHome ?? os.homedir();
      // AGY 1.1 resolves OAuth/config from the OS account profile, never from
      // Electron's isolated HOME or the historical Gemini CLI env override.
      if (isAgyNativeProfile) delete spawnEnv.GEMINI_CLI_HOME;
      const decorationOverrodeHome = Boolean(
        !isAgyNativeProfile && decoration?.env.HOME,
      );
      // Ignore any legacy AGY overlay runtime. Its writable scratch is fresh;
      // the native profile is exposed only through exact Seatbelt grants.
      let advisoryRuntimeDir = isAgyNativeProfile
        ? undefined
        : decoration?.sandboxDir;
      let advisoryProcessHome =
        agyNativeProfile?.processHome ?? decoration?.processHome;
      const advisoryEphemeralGrants: string[] = [];
      const advisoryReadOnlyGrants: string[] = [];
      if (!advisoryRuntimeDir && !decorationOverrodeHome) {
        const runtime = createScopedSandboxHome({
          projectId: sessionId,
          checkoutId: `advisory-${adapter.id}`,
        });
        advisoryRuntimeDir = runtime.dir;
        advisoryProcessHome = advisoryProcessHome ?? spawnEnv.HOME ?? realHome;
        // These providers carry their MCP/session state in a provider env var
        // that points into the Nexus ephemeral tree (never HOME). Grant exactly
        // those per-session dirs — not the whole ephemeral root, so one advisor
        // cannot read a sibling session's bearer-bearing config.
        if (!isAgyNativeProfile) {
          const ephemeralRoot = path.join(realHome, ".nexus", "ephemeral");
          for (const envVar of [
            "KIMI_CODE_HOME",
            "GROK_HOME",
            "OPENCODE_CONFIG_DIR",
            "XDG_DATA_HOME",
            "GEMINI_CLI_HOME",
          ]) {
            const value = spawnEnv[envVar];
            if (!value || !path.isAbsolute(value)) continue;
            let real: string;
            try {
              real = fs.realpathSync.native(value);
            } catch {
              continue;
            }
            if (
              real.startsWith(`${ephemeralRoot}${path.sep}`) &&
              fs.statSync(real).isDirectory()
            ) {
              advisoryEphemeralGrants.push(real);
            }
          }
        }
      }
      // Native-home advisory spawns (AGY, Kimi, …) authenticate via macOS
      // Keychain. AGY 1.1 reads the Keychain DB file directly — not only via
      // securityd — so without a read grant the CLI silently falls into the
      // OAuth re-login flow (physically verified). READ-ONLY, never writable.
      if (advisoryProcessHome && !isAgyNativeProfile) {
        const keychainsDir = path.join(realHome, "Library", "Keychains");
        try {
          if (fs.statSync(keychainsDir).isDirectory()) {
            advisoryReadOnlyGrants.push(keychainsDir);
          }
        } catch {
          // No Keychain dir on this host; nothing to grant.
        }
      }
      const advisorySandbox = resolveAdvisoryProcessSandbox({
        adapterId: adapter.id,
        readOnlyLane: true,
        privateHome: spawnEnv.HOME,
        privateTmp: spawnEnv.TMPDIR,
        binaryPath: bin,
        processHome: advisoryProcessHome,
        runtimeDir: advisoryRuntimeDir,
        providerStateReadPaths: [
          ...(agyNativeProfile
            ? agyNativeProfile.providerStateReadPaths
            : [
                ...(decoration?.providerStateReadPaths ?? []),
                ...advisoryEphemeralGrants,
                ...advisoryReadOnlyGrants,
              ]),
          ...(decoration?.missionShimReadPaths ?? []),
        ],
        providerStateWritePaths: [
          ...(agyNativeProfile
            ? agyNativeProfile.providerStateWritePaths
            : [
                ...(decoration?.providerStateWritePaths ?? []),
                ...advisoryEphemeralGrants,
              ]),
          ...(decoration?.missionShimWritePaths ?? []),
        ],
      });
      assertAdvisoryConfinement(
        adapter.id,
        true,
        advisorySandbox,
        process.platform,
      );
      if (advisorySandbox) {
        const plan = buildScopedExecPlan({
          platform: process.platform,
          executable: bin,
          args,
          cwd,
          rootRealPath: authority.scope.rootRealPath,
          sandboxDir: advisorySandbox.sandboxDir,
          privateHome: advisorySandbox.sandboxDir,
          processHome: advisorySandbox.processHome,
          env: spawnEnv,
          readOnlyRoot: true,
          // The boundary that matters for an advisor is WRITE: it reviews and
          // scouts, it never edits. Network stays open (workspace-net) because
          // an advisor is regularly asked to go fetch the reference the
          // operator dropped mid-mission — a page, a doc, an example — and
          // clamping the network would only push that work back to the human
          // without protecting the workspace any further. Denying the net here
          // also broke helper subprocesses while leaving the CLI itself online,
          // which is inconsistent rather than safe.
          sandboxProfile: "workspace-net",
          extraReadPaths: [
            ...advisorySandbox.extraWritePaths,
            ...advisorySandbox.providerStateReadPaths,
            ...(decoration?.attachmentReadPaths ?? []),
          ],
          extraWritePaths: [
            ...advisorySandbox.extraWritePaths,
            ...advisorySandbox.providerStateWritePaths,
          ],
        });
        spawnFile = plan.file;
        spawnArgs = plan.args;
        spawnCwd = plan.cwd;
        spawnEnv = cleanEnv(plan.env);
      }
    } catch (error) {
      decoration?.onSpawnFailed?.();
      throw error;
    }
  }

  const idleMs =
    adapter.stateParsing.idle.type === "timeout"
      ? adapter.stateParsing.idle.ms
      : 800;

  const spec: PtySpawnSpec = {
    sessionId,
    file: spawnFile,
    args: spawnArgs,
    cwd: spawnCwd,
    cols: req.cols,
    rows: req.rows,
    env: spawnEnv,
    ...(trustedNativeLaunch
      ? { darwinExecutableSeal: trustedNativeLaunch.darwinExecutableSeal }
      : {}),
  };
  let session!: Session;
  let proc: PtyProcHandle;
  try {
    const host = requireHost();
    const handlers = sessionHandlers(sessionId, () => session);
    if (trustedNativeLaunch) {
      revalidateTrustedNativeConfinementLaunch(trustedNativeLaunch);
    }
    proc = host.spawn(spec, handlers);
  } catch (err) {
    // The host itself is unavailable (never initialized / failed to fork), so
    // no session will exist — free the minted token + on-disk artifacts here,
    // otherwise a valid bearer token leaks in memory and on disk. A spawn that
    // fails INSIDE the host instead arrives as an async exit, and the exit tap
    // runs the very same cleanup.
    decoration?.onSpawnFailed?.();
    throw err;
  }
  const missionOrchestratorGrantAvailable =
    authority.source === "legacy-squad" &&
    authority.context?.role === "orchestrator" &&
    Boolean(authority.context.squadId);
  session = {
    proc,
    wc,
    idleTimer: null,
    hookBusyTimer: null,
    idleTimeoutMs: idleMs,
    state: "spawning",
    cwd,
    agent: {
      sessionId,
      paneId: req.paneId,
      adapterId: adapter.id,
      model: model || undefined,
      requestedModel: req.model,
      accountId: req.accountId,
      effort: req.effort,
      cwd,
      scope: Object.freeze({ ...authority.scope }),
      source: authority.source,
      role: authority.context?.role ?? "user",
      missionId: authority.context?.missionId,
      squadId: authority.context?.squadId,
      agentName: authority.context?.agentName,
      immediateMissionTitle: authority.context?.immediateMissionTitle,
      immediateMissionGoal: authority.context?.immediateMissionGoal,
      workerIncarnationId: authority.context?.workerIncarnationId,
      readOnly: authority.context?.readOnly === true,
      // Report the authority actually applied to the provider process. The
      // default autopilot deliberately does not enforce the read-only profile;
      // persisting the pre-policy request here would make the live session
      // diverge from its approved runtime snapshot and fail reattachment.
      nativeReadOnly,
      allowedTools:
        authority.context?.allowedTools === null ||
        authority.context?.allowedTools === undefined
          ? null
          : [...authority.context.allowedTools],
      allowedSkills:
        authority.context?.allowedSkills === null ||
        authority.context?.allowedSkills === undefined
          ? null
          : [...authority.context.allowedSkills],
      authoritySeal: authority.context?.authoritySeal
        ? Object.freeze({ ...authority.context.authoritySeal })
        : undefined,
    },
    missionOrchestratorGrantAvailable,
    missionOrchestratorGrantExpiresAt: missionOrchestratorGrantAvailable
      ? Date.now() + MISSION_ORCHESTRATOR_GRANT_TTL_MS
      : null,
    missionOrchestratorGrantTimer: null,
    outputSequence: 0,
    acknowledgedSequence: 0,
    replay: [],
    replayChars: 0,
    lastBackpressureWarnAt: 0,
    shellIntegrationCleanup: [],
  };
  sessions.set(sessionId, session);
  publishObserverFrame({
    sessionId,
    ...(req.paneId ? { paneId: req.paneId } : {}),
    ...(authority.context?.missionId
      ? { missionId: authority.context.missionId }
      : {}),
    at: Date.now(),
    kind: "session_spawned",
    payload: {
      adapterId: adapter.id,
      role: session.agent?.role ?? "user",
    },
  });
  if (missionOrchestratorGrantAvailable) {
    session.missionOrchestratorGrantTimer = setTimeout(() => {
      const live = sessions.get(sessionId);
      if (
        live !== session ||
        !live.missionOrchestratorGrantAvailable ||
        live.agent?.missionId
      ) {
        return;
      }
      live.missionOrchestratorGrantAvailable = false;
      live.missionOrchestratorGrantExpiresAt = null;
      live.missionOrchestratorGrantTimer = null;
      void orchTerminateSession(sessionId);
    }, MISSION_ORCHESTRATOR_GRANT_TTL_MS);
    session.missionOrchestratorGrantTimer.unref?.();
  }
  emitStateChange(wc, sessionId, "spawning");
  decoration?.onSpawned?.(sessionId);
  if (sessionDictationHook) {
    try {
      sessionDictationHook({
        providerSessionId: dictatedSessionId,
        ptySessionId: sessionId,
        adapterId: adapter.id,
        cwd,
        paneId: req.paneId,
        accountId: req.accountId,
      });
    } catch (err) {
      console.warn("[pty-manager] session dictation hook threw:", err);
    }
  }
  return { sessionId, ...(resumeMode ? { resumeMode } : {}) };
}

/**
 * Spawn a physical mission PTY under main-process ownership. This is the
 * renderer-independent lane used by the orchestration coordinator when no
 * pane grid is alive. It deliberately accepts only an already-bound mission
 * authority and stable pane identity; direct/user sessions stay renderer
 * owned.
 */
export function spawnMainOwnedAgentSession(
  req: SpawnRequest,
  adapter: CliPtyAdapter,
  overrides: AgentSpawnOverrides,
  authority: BoundSpawnAuthority,
): SpawnedSession {
  if (
    req.kind !== "cli-agent" ||
    !req.paneId ||
    !authority.context?.missionId ||
    (authority.context.role !== "orchestrator" &&
      authority.context.role !== "worker")
  ) {
    throw new Error(
      "main-owned PTY spawn requires a stable mission pane authority",
    );
  }
  return spawnAgentSession(null, req, adapter, overrides, authority);
}

export interface MainOwnedAgentSessionClaim {
  readonly paneId: string;
  readonly adapterId: string;
  readonly missionId: string;
  readonly role: "orchestrator" | "worker";
  readonly workerIncarnationId?: string;
  readonly model?: string;
  readonly accountId?: string;
  readonly effort?: string;
  readonly cwd: string;
  readonly agentName?: string;
  readonly readOnly: boolean;
  readonly nativeReadOnly: boolean;
  readonly allowedTools: readonly string[] | null;
  readonly allowedSkills: readonly string[] | null;
  readonly authoritySeal?: MissionPaneAuthoritySeal;
  readonly scope: Readonly<ProjectExecutionScope>;
}

export interface AdoptedMainOwnedAgentSession {
  readonly sessionId: string;
  readonly state: PaneSessionState;
}

function sameSessionScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath &&
    left.workspaceRootDevice === right.workspaceRootDevice &&
    left.workspaceRootInode === right.workspaceRootInode
  );
}

function sameOptionalList(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAuthoritySeal(
  left: MissionPaneAuthoritySeal | undefined,
  right: MissionPaneAuthoritySeal | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Transfer presentation ownership of one headless mission PTY to a renderer.
 * Every identity field comes from persisted/main-owned authority at the IPC
 * boundary. A guessed pane id, cross-project renderer, or session owned by a
 * DIFFERENT renderer cannot be adopted. A session already owned by the
 * requesting renderer reattaches: after a page reload (HMR, Cmd+R, crash
 * recovery) the WebContents survives but the renderer lost its session map,
 * and refusing the reattach used to dead-end the pane on the physical-exit
 * fence while its own process was still alive.
 */
export function adoptMainOwnedAgentSession(
  wc: WebContents,
  claim: MainOwnedAgentSessionClaim,
): AdoptedMainOwnedAgentSession | null {
  const matches = [...sessions.entries()].filter(([, session]) => {
    const info = session.agent;
    return (
      (session.wc === null || session.wc === wc) &&
      info?.paneId === claim.paneId &&
      info.adapterId === claim.adapterId &&
      info.missionId === claim.missionId &&
      info.role === claim.role &&
      info.workerIncarnationId === claim.workerIncarnationId &&
      info.requestedModel === claim.model &&
      info.accountId === claim.accountId &&
      info.effort === claim.effort &&
      info.cwd === claim.cwd &&
      info.agentName === claim.agentName &&
      info.readOnly === claim.readOnly &&
      info.nativeReadOnly === claim.nativeReadOnly &&
      sameOptionalList(info.allowedTools, claim.allowedTools) &&
      sameOptionalList(info.allowedSkills, claim.allowedSkills) &&
      sameAuthoritySeal(info.authoritySeal, claim.authoritySeal) &&
      sameSessionScope(info.scope, claim.scope)
    );
  });
  if (matches.length !== 1) return null;
  const [sessionId, session] = matches[0]!;
  session.wc = wc;
  if (canSend(wc)) {
    wc.send(PTY_CHANNELS.stateChange, { sessionId, state: session.state });
  }
  return Object.freeze({ sessionId, state: session.state });
}

/** Revoke renderer presentation ownership while preserving a mission PTY. */
export function detachOwnedMissionAgentSession(
  wc: WebContents,
  sessionId: string,
): boolean {
  const session = ownedSession(wc, sessionId);
  const info = session?.agent;
  if (
    !session ||
    !info?.missionId ||
    info.role === "user" ||
    info.source === "direct-user"
  ) {
    return false;
  }
  session.wc = null;
  return true;
}

function ownedSession(wc: WebContents, sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session || session.wc !== wc) return null;
  return session;
}

function cloneAgentInfo(info: OwnedAgentSessionInfo): OwnedAgentSessionInfo {
  return {
    ...info,
    scope: Object.freeze({ ...info.scope }),
    allowedTools: info.allowedTools === null ? null : [...info.allowedTools],
    allowedSkills: info.allowedSkills === null ? null : [...info.allowedSkills],
    authoritySeal: info.authoritySeal
      ? Object.freeze({ ...info.authoritySeal })
      : undefined,
  };
}

export function isSessionOwnedBy(wc: WebContents, sessionId: string): boolean {
  return ownedSession(wc, sessionId) !== null;
}

export function acknowledgeSessionOutput(
  wc: WebContents,
  sessionId: string,
  sequence: number,
): void {
  const session = ownedSession(wc, sessionId);
  if (!session) return;
  session.acknowledgedSequence = Math.max(
    session.acknowledgedSequence,
    Math.min(sequence, session.outputSequence),
  );
  const kept: Array<{ sequence: number; data: string }> = [];
  let keptChars = 0;
  for (const entry of session.replay) {
    if (entry.sequence > session.acknowledgedSequence) {
      kept.push(entry);
      keptChars += entry.data.length;
    }
  }
  session.replay = kept;
  session.replayChars = keptChars;
}

export function recoverSessionOutput(
  wc: WebContents,
  sessionId: string,
  afterSequence: number,
): Array<{ sessionId: string; sequence: number; data: string }> {
  const session = ownedSession(wc, sessionId);
  if (!session) return [];
  return session.replay
    .filter((entry) => entry.sequence > afterSequence)
    .map((entry) => ({ sessionId, ...entry }));
}

export function getOwnedAgentSessionInfo(
  wc: WebContents,
  sessionId: string,
): OwnedAgentSessionInfo | null {
  const info = ownedSession(wc, sessionId)?.agent;
  return info ? cloneAgentInfo(info) : null;
}

/** Trusted main-process lookup for internal services that receive an exact PTY id. */
export function getAgentSessionInfo(
  sessionId: string,
): OwnedAgentSessionInfo | null {
  const info = sessions.get(sessionId)?.agent;
  return info ? cloneAgentInfo(info) : null;
}

/** Main-owned physical inventory; renderer layout visibility is irrelevant. */
export function listAgentSessionsForPane(
  paneId: string,
): OwnedAgentSessionInfo[] {
  return [...sessions.values()]
    .map((session) => session.agent)
    .filter((info): info is OwnedAgentSessionInfo =>
      Boolean(info && info.paneId === paneId),
    )
    .map(cloneAgentInfo);
}

/** Complete main-owned physical agent inventory, including detached sessions. */
export function listAgentSessions(): OwnedAgentSessionInfo[] {
  return [...sessions.values()]
    .map((session) => session.agent)
    .filter((info): info is OwnedAgentSessionInfo => Boolean(info))
    .map(cloneAgentInfo);
}

/** Consume the single main-owned grant attached to an initial squad spawn. */
function hasLiveMissionOrchestratorGrant(
  session: Session | null,
  squadId: string,
): session is Session & { agent: OwnedAgentSessionInfo } {
  const info = session?.agent;
  if (
    !session ||
    !info ||
    !session.missionOrchestratorGrantAvailable ||
    session.missionOrchestratorGrantExpiresAt === null ||
    info.source !== "legacy-squad" ||
    info.role !== "orchestrator" ||
    info.squadId !== squadId
  ) {
    return false;
  }
  if (session.missionOrchestratorGrantExpiresAt <= Date.now()) {
    session.missionOrchestratorGrantAvailable = false;
    session.missionOrchestratorGrantExpiresAt = null;
    return false;
  }
  return true;
}

export function consumeMissionOrchestratorGrant(
  wc: WebContents,
  sessionId: string,
  squadId: string,
): OwnedAgentSessionInfo | null {
  const session = ownedSession(wc, sessionId);
  if (!hasLiveMissionOrchestratorGrant(session, squadId)) return null;
  session.missionOrchestratorGrantAvailable = false;
  session.missionOrchestratorGrantExpiresAt = null;
  if (session.missionOrchestratorGrantTimer) {
    clearTimeout(session.missionOrchestratorGrantTimer);
    session.missionOrchestratorGrantTimer = null;
  }
  return cloneAgentInfo(session.agent);
}

export function hasMissionOrchestratorGrant(
  wc: WebContents,
  sessionId: string,
  squadId: string,
): boolean {
  const session = ownedSession(wc, sessionId);
  return hasLiveMissionOrchestratorGrant(session, squadId);
}

export function bindOwnedAgentSessionMission(
  wc: WebContents,
  sessionId: string,
  missionId: string,
): boolean {
  const session = ownedSession(wc, sessionId);
  const info = session?.agent;
  if (!session || !info || (info.missionId && info.missionId !== missionId)) {
    return false;
  }
  session.agent = { ...info, missionId };
  return true;
}

export function rollbackOwnedAgentSessionMission(
  wc: WebContents,
  sessionId: string,
  missionId: string,
): boolean {
  const session = ownedSession(wc, sessionId);
  const info = session?.agent;
  if (!session || !info || info.missionId !== missionId) return false;
  const { missionId: _discarded, ...restored } = info;
  session.agent = restored;
  return true;
}

function destroySession(sessionId: string, session: Session): void {
  // Closing a pane/renderer is a logical request, never physical proof. Route
  // it through the same host-owned process-tree fence used by replacement and
  // app shutdown. The session stays registered and inert until the exact root
  // callback plus descendant receipt arrive; terminateAllSessions can
  // therefore still inventory/await a close racing with WebContents teardown.
  if (sessions.get(sessionId) !== session) return;
  void orchTerminateSession(sessionId);
}

export function writeSession(
  wc: WebContents,
  sessionId: string,
  data: string,
): boolean {
  const session = ownedSession(wc, sessionId);
  if (!session) return false;
  if (physicalTerminationFlights.get(sessionId)?.session === session) {
    return false;
  }
  if (
    session.agent &&
    session.agent.role !== "user" &&
    session.agent.source !== "direct-user"
  ) {
    // Renderer ownership is presentation authority only for orchestrated
    // agents. Kickoff, handoff and operator actions must enter through an
    // explicit main-owned lane (orchWriteSession), never raw terminal IPC.
    return false;
  }
  // User wrote input → re-arm the idle timer if applicable.
  if (session.state === "idle") {
    session.state = "busy";
    emitStateChange(wc, sessionId, "busy");
  }
  if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
  try {
    session.proc.write(data);
    return true;
  } catch {
    return false;
  }
}

export function resizeSession(
  wc: WebContents,
  sessionId: string,
  cols: number,
  rows: number,
): void {
  const session = ownedSession(wc, sessionId);
  if (!session) return;
  try {
    session.proc.resize(cols, rows);
  } catch {
    // A resize racing with process exit can throw; safe to ignore.
  }
}

export function killSession(wc: WebContents, sessionId: string): void {
  const session = ownedSession(wc, sessionId);
  if (!session) return;
  if (
    session.agent &&
    session.agent.role !== "user" &&
    session.agent.source !== "direct-user"
  ) {
    // A renderer may close its visual leaf, but mission process lifecycle is
    // owned by the coordinator and explicit main-process control APIs.
    return;
  }
  destroySession(sessionId, session);
}

export function killSessionsFor(wc: WebContents): void {
  for (const [id, session] of sessions) {
    if (session.wc !== wc) continue;
    const info = session.agent;
    if (
      info?.missionId &&
      info.role !== "user" &&
      info.source !== "direct-user"
    ) {
      // Renderer lifetime is presentation, not mission-process authority.
      // Keep the PTY and its replay buffer alive for the coordinator; a new
      // renderer may later adopt it through the sealed persisted pane.
      session.wc = null;
      continue;
    }
    destroySession(id, session);
  }
}

export function liveSessionSummary(wc?: WebContents): {
  total: number;
  busy: number;
} {
  let total = 0;
  let busy = 0;
  for (const session of sessions.values()) {
    if (wc && session.wc !== wc) continue;
    total += 1;
    if (session.state === "busy" || session.state === "spawning") busy += 1;
  }
  return { total, busy };
}

/**
 * Trusted main-process write used by the orchestration layer (MCP pane_write,
 * idle handoff delivery, voice→orchestrator routing). Bypasses WebContents
 * ownership — the caller is the main process itself, not a renderer.
 */
export function orchWriteSession(
  sessionId: string,
  data: string,
  options: { readonly markInputBusy?: boolean } = {},
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (physicalTerminationFlights.get(sessionId)?.session === session) {
    return false;
  }
  if (options.markInputBusy !== false && session.state === "idle") {
    session.state = "busy";
    emitStateChange(session.wc, sessionId, "busy");
  }
  if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
  session.proc.write(data);
  return true;
}

/** Trusted main-process resize (remote bridge / orchestration utilities). */
export function orchResizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  try {
    session.proc.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}

/** Trusted main-process kill (MCP pane_close on a session-only target). */
export function orchKillSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  destroySession(sessionId, session);
  return true;
}

export interface OrchTerminateSessionOptions {
  /** Grace window after SIGTERM. */
  readonly termTimeoutMs?: number;
  /** Final window after SIGKILL. A false result remains fail-closed. */
  readonly killTimeoutMs?: number;
}

/**
 * App-quit / packaged-smoke fence. Darwin's signed supervisor has no give-up
 * deadline once SIGTERM is delivered; main only needs a generous transport
 * fence for the exit event that is ordered ahead of the host proof. Short
 * 1.5s defaults left real shell panes stuck as "sessão sem prova física".
 */
export const APP_SHUTDOWN_PTY_TERMINATION = Object.freeze({
  termTimeoutMs: 10_000,
  killTimeoutMs: 20_000,
});

function ensurePhysicalTerminationFlight(
  sessionId: string,
  session: Session,
): PhysicalTerminationFlight {
  const existing = physicalTerminationFlights.get(sessionId);
  if (existing?.session === session) return existing;
  let resolveExited!: () => void;
  const flight: PhysicalTerminationFlight = {
    sessionId,
    session,
    exited: new Promise<void>((resolve) => {
      resolveExited = resolve;
    }),
    resolveExited: () => resolveExited(),
    rootExit: null,
    physicalTreeProven: false,
    revocationPublished: true,
    attempt: null,
  };
  physicalTerminationFlights.set(sessionId, flight);
  fireTaps(
    terminationTaps,
    sessionId,
    session.agent ? cloneAgentInfo(session.agent) : null,
  );
  return flight;
}

function boundedTerminationTimeout(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 30_000) {
    throw new Error("invalid PTY termination timeout");
  }
  return value;
}

async function exitsWithin(
  exited: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drivePhysicalTermination(
  flight: PhysicalTerminationFlight,
  options: OrchTerminateSessionOptions,
): Promise<boolean> {
  const termTimeoutMs = boundedTerminationTimeout(options.termTimeoutMs, 1_500);
  const killTimeoutMs = boundedTerminationTimeout(options.killTimeoutMs, 1_500);
  try {
    const proof = await flight.session.proc.terminate({
      termTimeoutMs,
      killTimeoutMs,
    });
    const fullProof =
      proof.ok && proof.rootExited && proof.descendantsExited;
    // Root is gone when the host saw exit (even without a descendant receipt)
    // or main already processed onExit. Completing the inventory is required
    // for app quit: the next step destroys the PTY utility host, which reaps
    // remaining in-host children. Leaving the session registered forever is
    // what produces the permanent "sessões sem prova física" dialog.
    const rootKnownDead = proof.rootExited || flight.rootExit !== null;
    if (!fullProof && !rootKnownDead) {
      console.error(
        `[pty] termination proof failed session=${flight.sessionId}`,
        proof,
      );
      return false;
    }
    if (!(await exitsWithin(flight.exited, killTimeoutMs))) {
      flight.rootExit ??= {
        exitCode: fullProof || proof.rootExited ? 0 : -1,
      };
      flight.resolveExited();
    }
    const rootExit = flight.rootExit;
    if (!rootExit) {
      console.error(
        `[pty] termination missing rootExit session=${flight.sessionId}`,
        proof,
      );
      return false;
    }
    flight.physicalTreeProven = true;
    finalizeSession(flight.sessionId, rootExit.exitCode, rootExit.signal);
    return sessions.get(flight.sessionId) !== flight.session;
  } catch (error) {
    console.error(
      `[pty] termination threw session=${flight.sessionId}`,
      error,
    );
    // A missing/broken process-inventory lane is never physical exit proof.
    return false;
  }
}

/**
 * Authority-critical, main-owned termination. Unlike `orchKillSession`, this
 * keeps the session registered and inert until the isolated PTY host reports
 * its actual root exit AND a bounded identity-fenced descendant inventory.
 * Callers MUST await `true` before spawning or adopting a replacement process.
 */
export function orchTerminateSession(
  sessionId: string,
  options: OrchTerminateSessionOptions = {},
): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve(true);
  const flight = ensurePhysicalTerminationFlight(sessionId, session);
  if (flight.attempt) return flight.attempt;
  // A termination listener is not expected to drive the PTY, but preserve
  // single-flight semantics even if one does so synchronously.
  let settleAttempt!: (result: boolean) => void;
  const pendingAttempt = new Promise<boolean>((resolve) => {
    settleAttempt = resolve;
  });
  let attempt!: Promise<boolean>;
  attempt = pendingAttempt.finally(() => {
    // A stubborn process stays registered/inert and may be retried by the
    // trailing reconciler. Only finalizeSession removes the flight.
    if (
      physicalTerminationFlights.get(sessionId) === flight &&
      flight.attempt === attempt
    ) {
      flight.attempt = null;
    }
  });
  flight.attempt = attempt;
  // Set the flight before calling the host: a deterministic/failing host can
  // publish onExit synchronously from terminate(), and that callback must join
  // this attempt rather than start a duplicate physical termination.
  void drivePhysicalTermination(flight, options).then(
    settleAttempt,
    () => settleAttempt(false),
  );
  return attempt;
}

export interface TerminateAllSessionsResult {
  readonly ok: boolean;
  readonly attemptedSessionIds: readonly string[];
  readonly terminatedSessionIds: readonly string[];
  readonly failedSessionIds: readonly string[];
}

/** Close PTY admission synchronously before any asynchronous shutdown work. */
export function sealPtySessionAdmissionForShutdown(): void {
  allSessionsTerminationInProgress = true;
}

/**
 * App-shutdown fence. Capture the complete main-owned inventory while new
 * spawns are synchronously blocked, then drive every physical process-tree
 * termination concurrently through the same proof lane used by replacement
 * spawning. A failed session remains registered and authority-revoked so the
 * caller can report it and retry without manufacturing an exit.
 */
export function terminateAllSessions(
  options: OrchTerminateSessionOptions = {},
): Promise<TerminateAllSessionsResult> {
  if (allSessionsTerminationFlight) return allSessionsTerminationFlight;
  sealPtySessionAdmissionForShutdown();
  const attemptedSessionIds = [...sessions.keys()];

  let completedWithPhysicalProof = false;
  let flight!: Promise<TerminateAllSessionsResult>;
  flight = (async () => {
    const outcomes = new Map<string, boolean>();
    await Promise.all(
      attemptedSessionIds.map(async (sessionId) => {
        try {
          outcomes.set(
            sessionId,
            await orchTerminateSession(sessionId, options),
          );
        } catch {
          // Invalid host responses/options are not physical-exit proof. The
          // still-registered inventory below remains authoritative.
          outcomes.set(sessionId, false);
        }
      }),
    );
    const failed = new Set(
      attemptedSessionIds.filter(
        (sessionId) =>
          outcomes.get(sessionId) !== true || sessions.has(sessionId),
      ),
    );
    // The spawn fence should make this impossible, but an unexpected inventory
    // entry is itself a shutdown failure and must be surfaced by exact id.
    for (const sessionId of sessions.keys()) failed.add(sessionId);
    const failedSessionIds = [...failed];
    const terminatedSessionIds = attemptedSessionIds.filter(
      (sessionId) => !failed.has(sessionId),
    );
    const result = {
      ok: failedSessionIds.length === 0 && sessions.size === 0,
      attemptedSessionIds,
      terminatedSessionIds,
      failedSessionIds,
    };
    completedWithPhysicalProof = result.ok;
    if (completedWithPhysicalProof) {
      // Keep the spawn fence closed across the promise continuation in
      // shutdownPtyRuntimeWithProof and the subsequent host destruction. A
      // queued IPC/microtask must not create a process outside the proven
      // inventory in that gap.
      allSessionsTerminationSealed = true;
    }
    return result;
  })().finally(() => {
    if (
      allSessionsTerminationFlight === flight &&
      !completedWithPhysicalProof
    ) {
      // A shutdown attempt permanently revokes PTY spawn admission for this
      // process lifetime, even when physical proof fails and the app remains
      // open to report/retry. The same sticky fail-closed contract applies;
      // reopening only this lane would let a new process escape the retained
      // shutdown inventory. Clear only the completed flight so a retry can
      // drive the still-registered sessions again.
      allSessionsTerminationFlight = null;
    }
  });
  allSessionsTerminationFlight = flight;
  return flight;
}

/**
 * Test-only isolation hook. Production's successful shutdown seal is
 * intentionally irreversible: replacing/restarting the host must never reopen
 * process admission after the physical inventory was declared complete.
 */
export function __resetPtyShutdownLifecycleForTests(): void {
  if (
    sessions.size > 0 ||
    physicalTerminationFlights.size > 0 ||
    (allSessionsTerminationInProgress && !allSessionsTerminationSealed)
  ) {
    throw new Error("cannot reset PTY lifecycle with active physical authority");
  }
  allSessionsTerminationFlight = null;
  allSessionsTerminationInProgress = false;
  allSessionsTerminationSealed = false;
}

/** Current lifecycle state of a session, or null if it is gone. */

/**
 * Publish a session activity state from non-PTY sources (e.g. agent hooks).
 * Fires the same state taps / IPC path as idle/busy transitions so pane-registry
 * and the renderer observe hook activity. Does NOT authorize evidence.
 */
export function publishSessionActivityState(
  sessionId: string,
  state: PaneSessionState,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    fireTaps(stateTaps, sessionId, state);
    return false;
  }
  session.hookState = state;
  if (state === "busy") {
    armHookBusyWatchdog(sessionId, session);
  } else if (session.hookBusyTimer) {
    clearTimeout(session.hookBusyTimer);
    session.hookBusyTimer = null;
  }
  // Skip IPC when the pane already shows this state — rapid hook re-asserts
  // (tool loop) used to thrash the toolbar/terminal chrome.
  if (session.state === state) return true;
  session.state = state;
  emitStateChange(session.wc, sessionId, state);
  return true;
}

export function getSessionState(sessionId: string): PaneSessionState | null {
  return sessions.get(sessionId)?.state ?? null;
}

/** Spawn cwd of a live session — the caller's workspace dir. */
export function getSessionCwd(sessionId: string): string | null {
  return sessions.get(sessionId)?.cwd ?? null;
}

export function getLiveSessionCount(): number {
  return sessions.size;
}

/**
 * Inventário (sessionId, cwd) das sessões vivas. Alimenta a varredura de PTY do
 * teardown de worktree, que precisa PROVAR quais processos moram dentro de um
 * worktree liberado antes de encerrá-los.
 */
export function listLiveSessionLocations(): ReadonlyArray<{
  readonly sessionId: string;
  readonly cwd: string | null;
}> {
  return Object.freeze(
    [...sessions.entries()].map(([sessionId, session]) =>
      Object.freeze({ sessionId, cwd: session.cwd ?? null }),
    ),
  );
}
