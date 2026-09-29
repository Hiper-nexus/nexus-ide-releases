import fs from "node:fs";
import { canResumeMimoNativeSession } from "../adapters/mimo-session-owner";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, type WebContents } from "electron";
import {
  argvHonorsModel,
  firstDeclaredModel,
  interactiveTemplateForModel,
  sealedModelMissingFromArgvError,
} from "./agent-model-argv";
import {
  applyInitialPromptToArgv,
  initialPromptChannel,
  nativeArgvPromptFits,
} from "../../shared/cli-initial-prompt";
import { ensureUtf8Locale } from "./pty-env-locale";
import { materializeProviderState, providerStateEnvFor } from "./provider-state-env";
import { applyPaneTerminalIdentity } from "./pane-terminal-identity";
import { assertManagedClaudeAuthSupported, CLAUDE_MANAGED_AUTH_ENV } from "../adapters/managed-claude-auth";
import { ensurePrivateHomeOperatorAccess } from "./private-home-operator";
import { PTY_CHANNELS } from "../../shared/channels";
import { readKimiModelAliases } from "../adapters/kimi-runtime-env";
import { migrateModelId } from "../../shared/model-defaults";
import type { SpawnRequest, PaneSessionState } from "../../shared/types";
import {
  classifySessionLiveness,
  isConnectedAndWritable,
} from "./session-liveness";
import { createMortalityReconciler } from "./session-mortality-reconciler";
import { sessionLeaseRegistry, type SessionLease } from "./session-lease-registry";
import { warmPool, type WarmSession } from "./warm-pool";
import { requestMatchesWarmContract, warmSessionServes } from "./warm-adoption";
import {
  resolveArmsRuntimeDescriptorPath,
  resolveArmsRuntimeInstance,
} from "../orch/arms-runtime-path";
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
  WorkspaceRootMissingError,
  isMissingPathError,
} from "../orch/workspace-path";
import {
  isMissionBoundCodexWorkspaceAuthority,
  isPetStudioNativeWorkspaceAuthority,
  requiresReadOnlyNativeAuthority,
  secureAutonomousCliArgs,
  supportsEnforceableWorkspaceWriteNativeAuthority,
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
import {
  MANAGED_PROVIDER_SPECS,
  prepareCheckoutProviderHome,
  scrubManagedSessionAuth,
} from "../adapters/managed-credentials";
import { forgetAccountChoiceReceipt } from "../persistence/account-choice-receipts";
import {
  resolveSpawnBinary,
  resolveWindowsCodexNpmShimLaunch,
} from "../path-resolver";
import { windowsNpmShimSpawn } from "../adapters/windows-npm-shim";
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
import { admitAgentSpawnSync } from "../orch/pane-admission";
import { isReleaseQualifiedMissionWorkerCli } from "../orch/squad-runtime-policy";
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
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
import {
  getPersistentSessionBackend,
  planPersistentAgentSpawn,
} from "./persistent-session";
import {
  deletePersistentPty,
  upsertPersistentPty,
} from "../persistence/persistent-session-store";
import { trace } from "../observability/main-trace";

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
  /** Criação no main — período de graça do reconciliador de mortalidade. */
  spawnedAtMs: number;
  /** Main-owned identity for cli-agent panes; never sourced from pane sync. */
  agent: OwnedAgentSessionInfo | null;
  /**
   * F-212: ficha mínima do próprio spawn cli-agent (pane/adapter), separada
   * de `agent` — um pane direto do operador pode ter `agent` null e mesmo
   * assim é PTY de CLI-agente, que precisa do `agent-pty-exit` no trace.
   * Shells comuns não carregam esta ficha.
   */
  agentSpawn?: { paneId?: string; adapterId: string };
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
  /**
   * When set, the agent process lives in a tmux session. App quit detaches
   * (does not kill-session); pane close kills the tmux session.
   */
  persistentTmuxName?: string;
  /** Workspace key used in the persistent_pty_sessions registry. */
  persistentWorkspaceId?: string;
  /**
   * When false, finalize must not tmux kill-session (app-quit detach path).
   * Defaults true whenever persistentTmuxName is set.
   */
  killPersistentOnFinalize?: boolean;
  /** Unique opaque lease key issued at physical spawn time. */
  startKey?: string;
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
  /** Mão do operador adotada como orquestradora; volta a `user` no fim. */
  promotedFromUser?: true;
  /**
   * F-662: o briefing nasceu no argv one-shot (AGY `--print`, OpenCode
   * `run`). A CLI não lê o terminal e só imprime ao terminar: pergunta ou
   * mensagem digitada nesse pane nunca é respondida.
   */
  oneShot?: true;
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
  /**
   * F-212: rótulo de quem pediu a terminação, congelado quando a raiz saiu.
   * Sem o freeze, um exit natural herdaria o rótulo do drive interno de prova
   * física e pareceria morte provocada pelo Nexus.
   */
  exitTerminationOrigin?: string | null;
}
const physicalTerminationFlights = new Map<string, PhysicalTerminationFlight>();
/**
 * F-212: último pedido de terminação/kill iniciado pelo Nexus por sessão.
 * O trace final de exit carrega quem mandou matar; processo que saiu sozinho
 * registra `terminationOrigin: null`. Removido no finalize.
 */
const terminationOrigins = new Map<string, string>();

function noteTerminationRequest(sessionId: string, origin: string): void {
  terminationOrigins.set(sessionId, origin);
  trace({ kind: "agent-pty-terminate", sessionId, origin });
}
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

/**
 * Reconciliador de mortalidade (caso de campo 20/08, "pane fantasma"): um
 * exit perdido entre host e main deixava a sessão eternamente 'live' —
 * pane preto, chef esperando worker morto, missão travada. O reconciliador
 * pergunta ao host quais sessões têm handle vivo; ausência confirmada
 * (strikes consecutivos, após graça) sintetiza o exit perdido via
 * finalizeSession e o pipeline de morte existente roda inteiro. Host mudo é
 * unverifiable e nunca condena (doutrina session-liveness).
 */
const MORTALITY_TICK_MS = 10_000;
let mortalityTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionMortalityReconciler(): void {
  if (mortalityTimer) return;
  const reconciler = createMortalityReconciler({
    listCandidates: () => {
      const activeCandidates = [...sessions.entries()]
        .filter(
          ([sessionId, session]) =>
            classifySessionLiveness(session.state) === "live" &&
            !physicalTerminationFlights.has(sessionId) &&
            // tmux: o handle do host é só o cliente de attach; a vida real
            // está na sessão tmux e tem recuperação própria.
            !session.persistentTmuxName,
        )
        .map(([sessionId, session]) => ({
          sessionId,
          spawnedAtMs: session.spawnedAtMs,
        }));
      const staleLeases = sessionLeaseRegistry
        .reapStaleLeases(10 * 60_000)
        .filter((l) => {
          const s = sessions.get(l.sessionId);
          return (
            s &&
            !physicalTerminationFlights.has(l.sessionId) &&
            !s.persistentTmuxName
          );
        })
        .map((l) => ({
          sessionId: l.sessionId,
          spawnedAtMs: l.bornAtMs,
        }));
      const seen = new Set<string>();
      const combined: { sessionId: string; spawnedAtMs: number }[] = [];
      for (const c of [...activeCandidates, ...staleLeases]) {
        if (!seen.has(c.sessionId)) {
          seen.add(c.sessionId);
          combined.push(c);
        }
      }
      return combined;
    },
    probeLiveness: (sessionIds) => {
      const probe = ptyHost?.probeLiveness;
      if (!probe) return Promise.resolve(null);
      return probe.call(ptyHost, sessionIds);
    },
    condemn: (sessionId) => finalizeSession(sessionId, -1),
    log: (message) => console.error(message),
    now: Date.now,
  });
  mortalityTimer = setInterval(() => {
    void reconciler.tick();
  }, MORTALITY_TICK_MS);
  mortalityTimer.unref?.();
}

export function stopSessionMortalityReconciler(): void {
  if (mortalityTimer) clearInterval(mortalityTimer);
  mortalityTimer = null;
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
export type SessionInputOrigin = "human" | "system";
/**
 * Input taps observe every byte that reaches a PTY (human keystrokes and
 * main-owned orchestration writes) WITHOUT owning or altering the write.
 * Consumers are read-only cronometers (token-speed meter); they must never
 * persist, log or forward the payload.
 */
export type SessionInputTap = (
  sessionId: string,
  data: string,
  origin: SessionInputOrigin,
) => void;
/** Logical authority revocation starts before physical PTY exit is proven. */
export type SessionTerminationTap = (
  sessionId: string,
  agent: OwnedAgentSessionInfo | null,
) => void;

const dataTaps = new Set<SessionDataTap>();
const inputTaps = new Set<SessionInputTap>();
const stateTaps = new Set<SessionStateTap>();
const exitTaps = new Set<SessionExitTap>();
const terminationTaps = new Set<SessionTerminationTap>();
const lastInputOrigins = new Map<string, SessionInputOrigin>();

function markSessionInputOrigin(
  sessionId: string,
  origin: SessionInputOrigin,
): void {
  lastInputOrigins.set(sessionId, origin);
}

export function getLastSessionInputOrigin(
  sessionId: string,
): SessionInputOrigin | undefined {
  return lastInputOrigins.get(sessionId);
}

export function tapSessionData(cb: SessionDataTap): () => void {
  dataTaps.add(cb);
  return () => dataTaps.delete(cb);
}

export function tapSessionInput(cb: SessionInputTap): () => void {
  inputTaps.add(cb);
  return () => inputTaps.delete(cb);
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

/** Notify input observers after a write physically reached the PTY. */
function publishSessionInput(
  sessionId: string,
  data: string,
  origin: SessionInputOrigin,
): void {
  if (inputTaps.size === 0 || data.length === 0) return;
  fireTaps(inputTaps, sessionId, data, origin);
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
  /**
   * Env keys to delete from the child env outright (e.g. an inherited or
   * adapter-passthrough var that must never reach the process). "Unset" is
   * not "empty": assigning "" still lands the variable in the child env
   * block, and CLIs that probe with `??` treat it as a real (empty) value.
   */
  envRemove?: readonly string[];
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
  } catch (err) {
    // Worktree apagado com o app aberto: nome próprio, com saída dita.
    if (isMissingPathError(err)) {
      throw new WorkspaceRootMissingError(authority.scope.rootRealPath, {
        cause: err,
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`authorized cli-agent cwd cannot be resolved: ${detail}`, {
      cause: err,
    });
  }
  try {
    cwd = fs.realpathSync(authority.cwd);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`authorized cli-agent cwd cannot be resolved: ${detail}`, {
      cause: err,
    });
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
  // TERM_PROGRAM/_VERSION NÃO passam: o pane se apresenta como Nexus
  // (pane-terminal-identity), não como o terminal que subiu o app.
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
const WINDOWS_ENV_ALLOWLIST = new Set(
  [...ENV_ALLOWLIST].map((key) => key.toUpperCase()),
);

function isAllowedChildEnvKey(key: string): boolean {
  if (
    ENV_ALLOWLIST.has(key) ||
    ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    return true;
  }
  // Windows environment variable names are case-insensitive, but Node keeps
  // the spelling inherited from the parent process (`Path`, not necessarily
  // `PATH`). Treat only allowlisted names as equivalent there; this preserves
  // the security boundary while keeping the system PATH available to shells.
  if (process.platform !== "win32") return false;
  const normalized = key.toUpperCase();
  return (
    WINDOWS_ENV_ALLOWLIST.has(normalized) ||
    ENV_ALLOW_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function baseChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isAllowedChildEnvKey(key)) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // App GUI (Finder) não herda locale do shell: sem isto o CLI filho roda em
  // locale C e prompts pt-BR viram mojibake no empacotado (bug F, 05/08).
  ensureUtf8Locale(env);
  return applyPaneTerminalIdentity(env);
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
/** Unacked output kept for recover pulls (~1M chars). */
const MAX_REPLAY_WINDOW_CHARS = 1_000_000;

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
  // Trim the oldest chunks off the running total, in batches: walking the
  // whole window (or splicing its head) on every chunk was O(window) per
  // chunk and pinned the main thread under streaming output (profiled on
  // Windows, 0.76.86). The window may overshoot by 25% before one trim.
  if (session.replayChars > MAX_REPLAY_WINDOW_CHARS * 1.25) {
    let drop = 0;
    while (
      drop < session.replay.length &&
      session.replayChars > MAX_REPLAY_WINDOW_CHARS
    ) {
      session.replayChars -= session.replay[drop].data.length;
      drop += 1;
    }
    session.replay.splice(0, drop);
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
    // F-212: congela a origem ANTES do drive interno de prova — o terminate
    // interno abaixo não é a causa da morte, não pode virar terminationOrigin.
    // `undefined` = ainda não congelado; `null` = exit natural (não regravar).
    if (pendingTermination.exitTerminationOrigin === undefined) {
      pendingTermination.exitTerminationOrigin =
        terminationOrigins.get(sessionId) ?? null;
    }
    pendingTermination.resolveExited();
    // Root exit alone does not release the agent/worktree exclusivity: a
    // captured detached descendant may still hold write authority.
    //
    // A natural exit may race immediately ahead of app shutdown. Ask the host
    // for its stable responsibility receipt now, while retaining this exact
    // main-owned identity in the shutdown inventory. On Darwin the signed
    // supervisor only exits after its whole responsibility cohort is empty.
    if (!pendingTermination.attempt) {
      void orchTerminateSession(sessionId, { origin: "pty:post-exit-proof" });
    }
    return;
  }
  // `undefined` = raiz nunca chegou por onExit (timeout do drive de prova) —
  // aí o pedido em curso no mapa ainda é a origem. `null` explícito = saída
  // natural congelada, não confundir com ausência de freeze.
  const tracedTerminationOrigin =
    pendingTermination.exitTerminationOrigin === undefined
      ? terminationOrigins.get(sessionId) ?? null
      : pendingTermination.exitTerminationOrigin;
  sessions.delete(sessionId);
  sessionLeaseRegistry.revokeLease(sessionId);
  lastInputOrigins.delete(sessionId);
  terminationOrigins.delete(sessionId);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  if (s.hookBusyTimer) clearTimeout(s.hookBusyTimer);
  if (s.missionOrchestratorGrantTimer) {
    clearTimeout(s.missionOrchestratorGrantTimer);
  }
  if (s.shellIntegrationCleanup.length > 0) {
    cleanupShellIntegrationPaths(s.shellIntegrationCleanup);
  }
  if (
    s.persistentTmuxName &&
    s.killPersistentOnFinalize !== false &&
    s.persistentWorkspaceId &&
    s.agent?.paneId
  ) {
    try {
      getPersistentSessionBackend().killSessionSync(s.persistentTmuxName);
    } catch {
      // Best-effort: attach client already exited.
    }
    deletePersistentPty(s.persistentWorkspaceId, s.agent.paneId);
  }
  // M1: scrub plaintext auth.json from the managed home now that the CLI exited.
  scrubManagedSessionAuth(sessionId);
  forgetAccountChoiceReceipt(sessionId);
  if (s.agent || s.agentSpawn) {
    // F-212: morte de agente persistida no trace — ids, números e rótulos
    // apenas; nunca argv, env ou texto do processo. `agent` null (pane direto
    // do operador) cai na ficha do próprio spawn com role 'user'.
    trace({
      kind: "agent-pty-exit",
      sessionId,
      paneId: s.agent?.paneId ?? s.agentSpawn?.paneId ?? null,
      missionId: s.agent?.missionId ?? null,
      role: s.agent?.role ?? "user",
      adapterId: s.agent?.adapterId ?? s.agentSpawn?.adapterId ?? "unknown",
      exitCode,
      signal: signal ?? null,
      uptimeMs: Math.max(0, Date.now() - s.spawnedAtMs),
      terminationOrigin: tracedTerminationOrigin,
    });
  }
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
  startKey?: string;
  resumeMode?: "exact" | "latest" | "unsupported" | "fresh-context";
}

export function operatorShellLoginArgs(
  shell: string,
  shellEnvironment: Readonly<Record<string, string>>,
): string[] {
  const shellBaseName = shell
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.toLowerCase() ?? '';
  if (
    ['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe']
      .includes(shellBaseName)
  ) {
    return [];
  }
  return shellBaseName.includes('bash') && shellEnvironment.NEXUS_BASHRC
    ? []
    : ['-l'];
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
  // Shells POSIX do operador abrem como login (-l): .zprofile/.zlogin e o
  // PATH real da conta (homebrew, ~/.local/bin) só entram nessa cadeia.
  // PowerShell e cmd não aceitam o argumento Unix.
  // bash com rcfile composto mantém o fluxo da shell integration (o composite
  // já carrega o ~/.bashrc), então o -l só entra sem NEXUS_BASHRC.
  const loginArgs = operatorShellLoginArgs(shell, shellEnv);
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
      spawnedAtMs: Date.now(),
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
    const lease = sessionLeaseRegistry.issueLease(sessionId, { kind: "shell" });
    session.startKey = lease.startKey;
    sessions.set(sessionId, session);
    return { sessionId, startKey: lease.startKey };
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

function normalizeAgentModel(
  adapter: CliPtyAdapter,
  model: string,
  failClosedOnUnusable: boolean,
  /** Kimi: canal e perfil do processo que vai subir (ver `usesKimiTransientModel`). */
  kimi: { readonly transientModel: boolean; readonly kimiCodeHome?: string } = { transientModel: false },
): string {
  const migrated = migrateModelId(model) ?? model;
  if (adapter.id === "kimi") {
    const alias =
      migrated === "kimi-for-coding" ? "kimi-code/kimi-for-coding" : migrated;
    // Canal transient (KIMI_MODEL_NAME por env, chave de API): o modelo não
    // viaja no --model, então o alias do config.toml não se aplica.
    if (kimi.transientModel) return alias;
    // `kimi --model` só aceita alias do config.toml DO PERFIL DO PANE; fora
    // dele o CLI recusa a sessão inteira ("Model … is not configured", smoke
    // 28/09) e o pane fica mudo. Sem --model ele usa o default_model. Modelo
    // selado nunca cai no default em silêncio.
    const aliases = readKimiModelAliases({ kimiCodeHome: kimi.kimiCodeHome });
    if (alias && aliases.length > 0 && !aliases.includes(alias)) {
      if (failClosedOnUnusable) {
        throw sealedModelMissingFromArgvError(adapter.label, alias);
      }
      return "";
    }
    return alias;
  }
  // OpenCode 1.17 requires provider/model. A stale unqualified preference is
  // not a valid fallback: omit --model and let OpenCode use its own configured
  // default instead of failing the pane at startup. A sealed mission model
  // must never take that silent default — fail visible.
  if (adapter.id === "opencode" && migrated && !migrated.includes("/")) {
    if (failClosedOnUnusable) {
      throw sealedModelMissingFromArgvError(adapter.label, migrated);
    }
    return "";
  }
  return migrated;
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
  // Contrato travado em session-liveness.ts (rodada 2 R1): a cerca bloqueia
  // sobre QUALQUER sessão registrada — live, exited (prova física pendente:
  // descendente destacado pode segurar a família de auth) e unverifiable.
  // "Nunca colapse 'não sei' em 'morto'" (doutrina Orca truthful liveness).
  if (authority.context?.role !== "orchestrator") return;
  const family = sharedAgentAuthFamily(adapter.id);
  if (!family) return;
  // One Maestro per mission until that process exits. A second mission in the
  // same workspace keeps its own runtime — stealing the other Maestro is what
  // made "iniciar a segunda" fechar a primeira.
  const incomingMissionId = authority.context.missionId?.trim() || null;
  const conflict = [...sessions.values()]
    .map((session) => session.agent)
    .find(
      (agent) =>
        agent?.role === "orchestrator" &&
        sharedAgentAuthFamily(agent.adapterId) === family &&
        (agent.missionId?.trim() || null) === incomingMissionId,
    );
  if (conflict) {
    throw new Error(
      `exclusive auth family ${family} already has a live orchestrator ` +
        `(${conflict.sessionId}) for this mission; physical exit proof is required before spawn`,
    );
  }
}

/**
 * Toda sessão AINDA REGISTRADA como orquestrador desta missão — incluindo
 * estados não-vivos (exited/hibernated) e cadáveres sem prova física, que a
 * cerca acima conta mas liveOrchestratorSessionId (fast-lane) não conta. Era
 * a discordância do 17/08: fast-lane decidia respawn, a cerca recusava para
 * sempre. O respawn deve terminar estas sessões (orchTerminateSession) ANTES
 * de spawnar a reposição.
 */
export function registeredOrchestratorSessionsForMission(
  missionId: string,
): ReadonlyArray<{
  readonly sessionId: string;
  readonly state: PaneSessionState;
  readonly adapterId: string;
}> {
  const wanted = missionId.trim();
  if (!wanted) return [];
  return Object.freeze(
    [...sessions.entries()]
      .filter(
        ([, session]) =>
          session.agent?.role === "orchestrator" &&
          (session.agent.missionId?.trim() || "") === wanted,
      )
      .map(([sessionId, session]) =>
        Object.freeze({
          sessionId,
          state: session.state,
          adapterId: session.agent?.adapterId ?? "",
        }),
      ),
  );
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
  // F-572: admissão de pane de agente — teto global + memória do sistema.
  // Este é o ÚNICO ponto físico por onde todo spawn de agente passa
  // ("+ Pane", nexus_pane_spawn, Via Rápida, respawn, revival e spawns
  // main-owned), então o gate mora aqui. Shells comuns (spawnSession) são
  // baratos e não contam. A recusa nomeia os panes ociosos a fechar.
  const liveAgentPanes = countLiveAgentSessions();
  const admission = admitAgentSpawnSync(liveAgentPanes, Date.now(), process.env, {
    // `authority` pode faltar num chamador inválido: a recusa "trusted spawn
    // authority" logo abaixo é quem responde, não um TypeError aqui.
    agentRequested: authority?.context?.operatorParentSessionId !== undefined,
  });
  if (!admission.ok) {
    console.warn(
      `[pane-admission] spawn recusado (${admission.reason}): ${admission.message}`,
    );
    throw new Error(admission.message);
  }
  if (admission.warning) console.warn(`[pane-admission] ${admission.warning}`);
  const cwd = requireTrustedAgentCwd(authority);
  // Warm pool (paridade Overclock): um pane já bootando serve este spawn só
  // quando o pedido é o contrato com que ele nasceu (F-642). Recursão
  // evitada: a reposição do pool não tenta tomar de si mesma.
  if (!warmSpawnInProgress() && requestMatchesWarmContract(req, overrides, authority)) {
    try {
      const warm = tryAdoptWarmSession(adapter.id, authority, cwd);
      if (warm) {
        console.warn(`[warm-pool] adotado pane=${warm.sessionId} cli=${adapter.id}`);
        return warm;
      }
    } catch (err) {
      console.warn('[warm-pool] adoção falhou; cold spawn:', err);
    }
  }
  assertExclusiveOrchestratorProcessAvailable(adapter, authority);
  const requestedModel = (req.model ?? overrides.defaultModel)?.trim() || "";
  const missionSealedModel = Boolean(
    requestedModel &&
      authority.context?.missionId?.trim() &&
      (authority.context.role === "worker" ||
        authority.context.role === "orchestrator"),
  );
  const model = normalizeAgentModel(
    adapter,
    firstDeclaredModel([
      req.model,
      overrides.defaultModel,
      adapter.models.default,
    ]),
    missionSealedModel,
    {
      transientModel: adapter.id === "kimi" && Boolean(overrides.keyEnv?.KIMI_MODEL_NAME),
      kimiCodeHome: overrides.keyEnv?.KIMI_CODE_HOME,
    },
  );
  const argv = resolvePlaceholders(
    interactiveTemplateForModel(
      adapter.spawn.interactive,
      adapter.models.flag,
      model,
    ),
    {
      MODEL: model,
      CWD: cwd,
      SESSION_ID: "",
      PROMPT: "",
    },
  ).filter((a) => a.length > 0);

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
  // silently DROP the resolved model (Codex boots on CLI 5.5, Grok on its
  // default). Append the flag whenever we have a model to honor — sealed
  // first, else adapter default — unless Kimi already carries it in env.
  const templateHasModel = adapter.spawn.interactive.some((a) =>
    a.includes("{{MODEL}}"),
  );
  const usesKimiTransientModel =
    adapter.id === "kimi" && Boolean(overrides.keyEnv?.KIMI_MODEL_NAME);
  if (
    model &&
    !templateHasModel &&
    adapter.models.flag &&
    !usesKimiTransientModel
  ) {
    args.push(adapter.models.flag, model);
  }
  if (
    missionSealedModel &&
    !adapter.models.flag &&
    !usesKimiTransientModel
  ) {
    throw sealedModelMissingFromArgvError(adapter.label, requestedModel);
  }
  if (
    req.effort?.trim() &&
    adapter.control?.effort?.levels &&
    adapter.control.effort.levels.length > 0 &&
    !adapter.control.effort.levels.includes(req.effort.trim())
  ) {
    throw new Error(
      `${adapter.label}: effort selado "${req.effort.trim()}" não é ` +
        `suportado (${adapter.control.effort.levels.join(", ")}). ` +
        "Recusando o default da CLI.",
    );
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
  if (req.resume) {
    if (authority.source === "persisted-pane") {
      let captured =
        !req.resumeLatestOnly &&
        req.paneId &&
        adapter.spawn.resumeIdArgs?.length
          ? (resumeSessionLookup?.(
              authority.coordinationScope ?? authority.scope,
              req.paneId,
              adapter.id,
              req.accountId,
            ) ?? null)
          : null;
      if (captured && adapter.id === "mimo-code" && !req.accountId && !canResumeMimoNativeSession(authority.scope, captured, overrides.keyEnv?.XIAOMI_API_KEY)) captured = null;
      if (captured) {
        args.push(...adapter.spawn.resumeIdArgs!, captured);
        trustedResumeArgs = [...adapter.spawn.resumeIdArgs!, captured];
        resumeMode = "exact";
      } else if (authority.context?.missionId) {
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
      let captured =
        !req.resumeLatestOnly &&
        req.paneId &&
        adapter.spawn.resumeIdArgs?.length
          ? (resumeSessionLookup?.(
              authority.coordinationScope ?? authority.scope,
              req.paneId,
              adapter.id,
              req.accountId,
            ) ?? null)
          : null;
      if (captured && adapter.id === "mimo-code" && !req.accountId && !canResumeMimoNativeSession(authority.scope, captured, overrides.keyEnv?.XIAOMI_API_KEY)) captured = null;
      if (captured) {
        args.push(...adapter.spawn.resumeIdArgs!, captured);
        trustedResumeArgs = [...adapter.spawn.resumeIdArgs!, captured];
        resumeMode = "exact";
      } else {
        // No captured ID is authority to select another pane's latest conversation.
        resumeMode = "fresh-context";
      }
    }
  }

  // True only when argv actually asks the provider to resume a conversation.
  // The fresh-context fallback is a FRESH spawn under the sealed contract, so
  // it dictates a new provider session id like any other fresh spawn.
  const providerResumeRequested = resumeMode === "exact";

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
  const promptChannel = initialPromptChannel({
    declared: adapter.spawn.initialPrompt,
    interactiveFlag: adapter.spawn.initialPromptFlag,
    oneshotArgs: adapter.spawn.initialPromptArgs,
    interactive: adapter.spawn.interactive,
  });
  // Canal do BINÁRIO, não allowlist de ids: glm/longcat/deepseek herdam o
  // `claude` posicional; sakana herda o `codex`. One-shot (AGY `--print`,
  // OpenCode `run`) mata o pane — só worker. Orquestrador one-shot cola.
  const nativeInitialPrompt =
    authority.source === "pending" &&
    !req.resume &&
    promptChannel.kind !== "paste" &&
    (authority.context?.role === "worker" ||
      promptChannel.kind === "positional" ||
      promptChannel.kind === "interactive-flag") &&
    // F-668: mesma regra dos chamadores, que colam o brief depois do boot.
    nativeArgvPromptFits(authority.context?.initialPrompt, process.platform)
      ? authority.context?.initialPrompt
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
    // NEXUS_PANE_KEY carries the ephemeral sessionId (hook correlation);
    // NEXUS_PANE_ID carries the stable paneId so a respawned agent can still
    // refer to its own pane. Absent paneId means no value is invented.
    const stablePaneId = req.paneId?.trim();
    for (const target of spawnEnvs) {
      target.NEXUS_AGENT_HOOK_ENDPOINT = agentHookEndpointPath;
      target.NEXUS_PANE_KEY = sessionId;
      if (stablePaneId) target.NEXUS_PANE_ID = stablePaneId;
      // OVKA-529: a CASA deste pane — o wrapper Arms usa isto para saber se
      // fala com o próprio app (e carregar callerPaneId) ou com outro. A casa
      // é a instância que abriu o pane: `npm start` publica o descriptor dev
      // (F-644), nunca o do app instalado.
      target.NEXUS_PANE_ARMS_DESCRIPTOR = resolveArmsRuntimeDescriptorPath(
        os.homedir(),
        resolveArmsRuntimeInstance(app.isPackaged),
      );
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
  if (adapter.id === "claude" && env[CLAUDE_MANAGED_AUTH_ENV]) {
    assertManagedClaudeAuthSupported(bin);
    for (const target of spawnEnvs) {
      delete target.CLAUDE_CODE_OAUTH_TOKEN;
      delete target.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
      delete target.CLAUDE_CODE_OAUTH_SCOPES;
    }
  }
  // A credencial do gateway vence a do provider e por isso entra DEPOIS do
  // keyEnv: se o operador configurou uma chave para o gateway, é ela que
  // autentica o tráfego que agora vai para lá.
  applyGatewayCredential(env, adapter, gatewayBaseUrl, gatewayApiKey);
  logGatewayRouting(adapter, gatewayBaseUrl, gatewayApiKey);

  const checkoutProviderHome = adapter.id === "agy" || adapter.id === "devin"
    ? prepareCheckoutProviderHome(adapter.id, {
        userDataPath: app.getPath("userData"),
        checkoutId: authority.scope.checkoutId,
        sourceHome: overrides.keyEnv?.[MANAGED_PROVIDER_SPECS[adapter.id].homeEnvVar]
          ?? MANAGED_PROVIDER_SPECS[adapter.id].systemHome(
            adapter.id === "agy" ? resolveNativeUserHome({ inheritedHome: env.HOME }) : os.homedir(),
          )!,
      })
    : null;
  if (checkoutProviderHome) {
    for (const target of spawnEnvs) Object.assign(target, checkoutProviderHome.env);
  }

  const tuiProviderState = providerStateEnvFor(adapter.id, {
    userDataDir: app.getPath("userData"),
    checkoutId: authority.scope.checkoutId,
    home: identityEnv.HOME ?? os.homedir(),
    platform: process.platform,
  });
  const tuiProviderSharedFiles = tuiProviderState
    ? materializeProviderState(tuiProviderState, app.getPath("userData"))
    : [];
  if (tuiProviderState) {
    for (const target of spawnEnvs) Object.assign(target, tuiProviderState.env);
  }

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
    for (const key of decoration.envRemove ?? []) delete env[key];
    args.push(...decoration.extraArgs);
  }
  // Codex preparation below still needs the selected account's home. OpenCode
  // decoration already projected that account's auth into checkout storage.
  for (const homeKey of ["CODEX_HOME", "XDG_DATA_HOME"] as const) {
    if (
      homeKey === "XDG_DATA_HOME" &&
      adapter.id === "opencode" &&
      decoration?.env.XDG_DATA_HOME
    ) continue;
    const value = overrides.keyEnv?.[homeKey];
    if (value) env[homeKey] = value;
  }
  // F-567: MCP decoration and account env must not restore native conversation stores.
  if (checkoutProviderHome) Object.assign(env, checkoutProviderHome.env);
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
          userDataPath: app.getPath("userData"),
          checkoutId: authority.scope.checkoutId,
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
  } else if (decoration && adapter.id === "codex") {
    // Every decorated Codex pane uses checkout conversations. Direct panes
    // retain the operator's MCP/profile; gated workers receive granted skills.
    try {
      const token = decoration.env.NEXUS_MCP_TOKEN;
      if (!token) {
        throw new Error("Codex CLI spawn is missing its main-owned bearer");
      }
      const operatorHome = prepareCodexOperatorMissionHome(token, {
        userDataPath: app.getPath("userData"),
        checkoutId: authority.scope.checkoutId,
        codexResumeSessionId: resumeMode === "exact" ? trustedResumeArgs[trustedResumeArgs.length - 1] : undefined,
        providerHome: env.CODEX_HOME,
        // F-572: um helper aberto pelo operador também não herda o perfil MCP
        // global dele — mesma razão do --strict-mcp-config do Claude.
        preserveUserMcp:
          !gatedSpawn &&
          authority.context?.operatorParentSessionId === undefined,
        cwd,
        workspaceRoot: authority.scope.rootRealPath,
      });
      Object.assign(env, operatorHome.env);
      if (gatedSpawn) {
        const governedProfile = resolveGovernedCliProfile(token);
        deliverGrantedSkillsToProviderHome(
          "codex",
          os.homedir(),
          path.join(operatorHome.env.CODEX_HOME, "skills"),
          governedProfile.allowedSkills,
          governedProfile.allowedTools,
        );
      }
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
    writableWorkerIntent &&
      (executionPolicy.isFrictionless ||
        // F-525: governed writer sem sandbox nativo de escrita usa o boundary
        // Autopilot (worktree isolada + merge Main-owned). Vale apenas para o
        // conjunto release-qualified — adapters fora dele continuam recusados
        // aqui embaixo (defesa em camadas com o gate de spawn authority).
        (executionPolicy.enforceWorkspaceWriteSandbox &&
          !supportsEnforceableWorkspaceWriteNativeAuthority(adapter) &&
          isReleaseQualifiedMissionWorkerCli(adapter.id))),
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
      // F-525: a exigência de resume main-owned pertence ao confinamento
      // nativo (Codex). Writers builtin sem sandbox nativo rodam no boundary
      // worktree+merge — o resume deles não precisa do selo de sessão.
      const nativeConfinedWriter =
        enforceWorkspaceWriteSandbox &&
        supportsEnforceableWorkspaceWriteNativeAuthority(adapter);
      if (
        (nativeReadOnly || nativeConfinedWriter) &&
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
    if (safeNativeInitialPrompt !== undefined) {
      // Append after governed reconstruction: Codex/Claude rebuild argv from
      // an allowlist and would drop a positional prompt injected earlier.
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
        // AGY keeps its own workspace registry and otherwise sends tool calls
        // to ~/.gemini/antigravity-cli/scratch even when cwd is correct.
        args.push("--add-dir", cwd);
      }
      args = applyInitialPromptToArgv(
        args,
        promptChannel,
        safeNativeInitialPrompt,
      );
    }
    if (
      !usesKimiTransientModel &&
      ((missionSealedModel &&
        !argvHonorsModel(
          args,
          adapter.models.flag,
          model || requestedModel,
        )) ||
        (!missionSealedModel &&
          model &&
          !argvHonorsModel(args, adapter.models.flag, model)))
    ) {
      throw sealedModelMissingFromArgvError(
        adapter.label,
        requestedModel || model,
      );
    }
    if (
      executionPolicy.enableLiveWeb &&
      adapter.id === "codex" &&
      !args.includes("--search")
    ) {
      args.push("--search");
    }
    // F-567: decoration and account overrides must not restore native TUI stores.
    if (tuiProviderState) Object.assign(env, tuiProviderState.env);
  } catch (error) {
    decoration?.onSpawnFailed?.();
    throw error;
  }

  let spawnFile = bin;
  let spawnArgs = args;
  let spawnCwd = cwd;
  let spawnEnv = cleanEnv(env);
  /** Seatbelt/Bubblewrap already owns this spawn — never wrap with tmux attach. */
  let processSandboxActive = false;
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
        processSandboxActive = true;
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
      const isAgy = adapter.id === "agy";
      const realHome = isAgy
        ? resolveNativeUserHome({ inheritedHome: spawnEnv.HOME })
        : os.homedir();
      const decorationOverrodeHome = Boolean(
        !isAgy && decoration?.env.HOME,
      );
      // Ignore any legacy AGY overlay runtime. Its writable scratch is fresh;
      // only shared auth/config files and checkout state receive exact grants.
      let advisoryRuntimeDir = isAgy
        ? undefined
        : decoration?.sandboxDir;
      let advisoryProcessHome =
        tuiProviderState?.env.HOME ??
        (isAgy ? spawnEnv.HOME : undefined) ?? decoration?.processHome;
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
        if (!isAgy) {
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
      if (advisoryProcessHome) {
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
          ...(tuiProviderState ? [tuiProviderState.stateRoot, ...tuiProviderSharedFiles] : []),
          ...(checkoutProviderHome
            ? [checkoutProviderHome.stateHome, ...checkoutProviderHome.sharedReadPaths]
            : (decoration?.providerStateReadPaths ?? [])),
          ...advisoryEphemeralGrants,
          ...advisoryReadOnlyGrants,
          ...(decoration?.missionShimReadPaths ?? []),
        ],
        providerStateWritePaths: [
          ...(tuiProviderState ? [tuiProviderState.stateRoot, ...tuiProviderSharedFiles] : []),
          ...(checkoutProviderHome
            ? [checkoutProviderHome.stateHome]
            : (decoration?.providerStateWritePaths ?? [])),
          ...advisoryEphemeralGrants,
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
            ...(checkoutProviderHome?.sharedFiles ?? []),
            ...tuiProviderSharedFiles,
            ...(decoration?.attachmentReadPaths ?? []),
          ],
          extraWritePaths: [
            ...advisorySandbox.extraWritePaths,
            ...advisorySandbox.providerStateWritePaths,
            ...(checkoutProviderHome?.sharedFiles ?? []),
            ...tuiProviderSharedFiles,
          ],
        });
        spawnFile = plan.file;
        spawnArgs = plan.args;
        spawnCwd = plan.cwd;
        spawnEnv = cleanEnv(plan.env);
        processSandboxActive = true;
      }
    } catch (error) {
      decoration?.onSpawnFailed?.();
      throw error;
    }
  }

  // npm's Windows launcher is a .cmd batch file. cmd.exe caps the command
  // line at 8K (a Codex pane's hook config alone can pass it), CUTS an
  // argument at its first newline — F-668: a worker's multi-line brief reached
  // Claude as just "## Nexus execution authority" — and expands %VAR% inside
  // the prompt text. A built-in launcher the resolver verifies (same package,
  // exact entrypoint) runs its entrypoint directly: the .exe, or node.exe +
  // script. Direct, non-sandboxed Windows path only. Never rewrite a sandbox
  // plan: its wrapper and filesystem contract must remain exactly as built.
  if (
    process.platform === "win32" &&
    isBuiltinAdapter(adapter.id) &&
    !processSandboxActive &&
    spawnFile === bin
  ) {
    const npmShimLaunch =
      (adapter.id === "codex" ? resolveWindowsCodexNpmShimLaunch(spawnFile) : null) ??
      windowsNpmShimSpawn(adapter.id, spawnFile);
    if (npmShimLaunch) {
      spawnFile = npmShimLaunch.file;
      spawnArgs = [...npmShimLaunch.argsPrefix, ...spawnArgs];
    }
  }

  const idleMs =
    adapter.stateParsing.idle.type === "timeout"
      ? adapter.stateParsing.idle.ms
      : 800;

  const workspaceId = authority.scope.rootRealPath;
  const persistencePlan = planPersistentAgentSpawn({
    enabled: getFeatureFlagRegistry().isEnabled(
      FEATURE_FLAG_IDS.ptyPersistentSession,
    ),
    workspaceId,
    paneId: req.paneId,
    cwd: spawnCwd,
    file: spawnFile,
    args: spawnArgs,
    env: spawnEnv,
    sealedNative: Boolean(trustedNativeLaunch),
    processSandboxActive,
    onMissingSession: () => {
      // Stale registry row after cold start with a dead tmux session.
      if (req.paneId) deletePersistentPty(workspaceId, req.paneId);
    },
  });
  if (persistencePlan.mode === "tmux" && persistencePlan.tmuxName && req.paneId) {
    const tracked = upsertPersistentPty({
      workspaceId,
      paneId: req.paneId,
      tmuxName: persistencePlan.tmuxName,
      cwd: spawnCwd,
      createdAt: Date.now(),
    });
    if (tracked) {
      spawnFile = persistencePlan.file;
      spawnArgs = persistencePlan.args;
    } else {
      // Registry refused (e.g. UNIQUE tmux_name) — do not attach blind;
      // tear down the session ensureSession just created and stay direct.
      try {
        getPersistentSessionBackend().killSessionSync(persistencePlan.tmuxName);
      } catch (err) {
        console.warn(
          "[pty] failed to kill untracked persistent tmux session:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // F-629: todo HOME privado do Nexus (overlay Claude, Codex shell-home,
  // MiMo, Grok, provider-state de cursor/droid/…) enxerga o keychain real —
  // senão gh/git/CLIs abrem o modal "Chaves Não Encontradas". Spawns sob
  // Seatbelt/Bubblewrap têm contrato de arquivos próprio e ficam de fora.
  // Lane gravável também recebe a identidade git/SSH/gh do operador (F-579
  // tier 1), senão o agente pede `gh auth login` com a máquina autenticada.
  if (!processSandboxActive && !codexProcessSandbox) {
    ensurePrivateHomeOperatorAccess(spawnEnv.HOME, {
      realHome: os.homedir(),
      userDataDir: app.getPath("userData"),
      writable: !nativeReadOnly && authority.context?.readOnly !== true,
    });
  }

  const spec: PtySpawnSpec = {
    sessionId,
    file: spawnFile,
    args: spawnArgs,
    cwd: spawnCwd,
    cols: req.cols,
    rows: req.rows,
    env: spawnEnv,
    ...(trustedNativeLaunch && persistencePlan.mode === "direct"
      ? { darwinExecutableSeal: trustedNativeLaunch.darwinExecutableSeal }
      : {}),
  };
  let session!: Session;
  let proc: PtyProcHandle;
  try {
    const host = requireHost();
    const handlers = sessionHandlers(sessionId, () => session);
    if (trustedNativeLaunch && persistencePlan.mode === "direct") {
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
    spawnedAtMs: Date.now(),
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
      ...(safeNativeInitialPrompt !== undefined && promptChannel.kind === "oneshot"
        ? { oneShot: true as const }
        : {}),
    },
    agentSpawn: { paneId: req.paneId, adapterId: adapter.id },
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
    ...(persistencePlan.mode === "tmux" && persistencePlan.tmuxName
      ? {
          persistentTmuxName: persistencePlan.tmuxName,
          persistentWorkspaceId: workspaceId,
          killPersistentOnFinalize: true,
        }
      : {}),
  };
  const lease = sessionLeaseRegistry.issueLease(sessionId, { kind: adapter.id });
  session.startKey = lease.startKey;
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
      void orchTerminateSession(sessionId, {
        origin: "orchestrator-grant-expired",
      });
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
  return { sessionId, startKey: lease.startKey, ...(resumeMode ? { resumeMode } : {}) };
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
    const wcMatches =
      session.wc === null || session.wc === wc || !canSend(session.wc);
    return (
      wcMatches &&
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

/**
 * Hand a headless mission PTY back to the renderer that still presents it.
 * A workspace switch detaches mission panes (presentation revoked), but the
 * renderer parks the same xterm with the same session id and, on return,
 * never respawns — so the adoption inside pty spawn never ran and every
 * keystroke was refused. The caller proves pane identity and scope; this
 * only accepts a session with no live presenter.
 */
export function reattachDetachedMissionAgentSession(
  wc: WebContents,
  sessionId: string,
  paneId: string,
): boolean {
  const session = sessions.get(sessionId);
  const info = session?.agent;
  if (
    !session ||
    !info?.missionId ||
    info.paneId !== paneId ||
    info.role === "user" ||
    info.source === "direct-user" ||
    (session.wc !== null && canSend(session.wc)) ||
    !canSend(wc) ||
    physicalTerminationFlights.get(sessionId)?.session === session
  ) {
    return false;
  }
  session.wc = wc;
  wc.send(PTY_CHANNELS.stateChange, { sessionId, state: session.state });
  return true;
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
  // Replay is ordered by sequence: drop the acknowledged prefix in place.
  let drop = 0;
  let droppedChars = 0;
  while (
    drop < session.replay.length &&
    session.replay[drop].sequence <= session.acknowledgedSequence
  ) {
    droppedChars += session.replay[drop].data.length;
    drop += 1;
  }
  if (drop > 0) {
    session.replay.splice(0, drop);
    session.replayChars -= droppedChars;
  }
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

export interface UpdateOwnedAgentSessionRoleInput {
  role: "orchestrator" | "worker";
  missionId: string;
  allowedTools: string[] | null;
  allowedSkills?: string[] | null;
  workerIncarnationId?: string | null;
}

export function updateOwnedAgentSessionRole(
  sessionId: string,
  input: UpdateOwnedAgentSessionRoleInput,
): boolean {
  const session = sessions.get(sessionId);
  const info = session?.agent;
  if (
    !session ||
    !info ||
    info.role === "user" ||
    (info.missionId && info.missionId !== input.missionId)
  ) {
    return false;
  }
  const workerIncarnationId =
    input.role === "worker" && input.workerIncarnationId
      ? input.workerIncarnationId
      : undefined;
  session.agent = {
    ...info,
    role: input.role,
    missionId: input.missionId,
    workerIncarnationId,
    allowedTools:
      input.allowedTools === null ? null : [...input.allowedTools],
    allowedSkills:
      input.allowedSkills === undefined
        ? info.allowedSkills
        : input.allowedSkills === null
          ? null
          : [...input.allowedSkills],
  };
  return true;
}

/**
 * Variante EXPLÍCITA da ficha PTY para a adoção da mão do operador (`user` sem
 * missão) como orquestradora — par de `adoptUserSessionAsMissionOrchestrator`
 * no gate. `updateOwnedAgentSessionRole` continua recusando `user`; só este
 * caminho aceita, e mantém as allowlists que o pane já tinha. Chame DEPOIS do
 * gate: uma ficha já adotada antes (missão que acabou) é readotada porque o
 * gate, que é a autoridade, já devolveu a mão ao operador.
 */
export function adoptUserAgentSessionAsMissionOrchestrator(
  sessionId: string,
  missionId: string,
): boolean {
  const session = sessions.get(sessionId);
  const info = session?.agent;
  const operatorHand =
    info?.role === "user" ? !info.missionId : info?.promotedFromUser === true;
  if (!session || !info || !operatorHand || !missionId) return false;
  session.agent = { ...info, role: "orchestrator", missionId, promotedFromUser: true };
  return true;
}

/** Desfaz a adoção acima (missão removida ou adoção incompleta). */
export function returnAdoptedAgentSessionToUser(
  sessionId: string,
  missionId: string,
): boolean {
  const session = sessions.get(sessionId);
  const info = session?.agent;
  if (!session || !info || !info.promotedFromUser || info.missionId !== missionId) {
    return false;
  }
  const { missionId: _mission, promotedFromUser: _promoted, workerIncarnationId: _worker, ...rest } = info;
  session.agent = { ...rest, role: "user" };
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

function destroySession(
  sessionId: string,
  session: Session,
  origin?: string,
): void {
  // Closing a pane/renderer is a logical request, never physical proof. Route
  // it through the same host-owned process-tree fence used by replacement and
  // app shutdown. The session stays registered and inert until the exact root
  // callback plus descendant receipt arrive; terminateAllSessions can
  // therefore still inventory/await a close racing with WebContents teardown.
  if (sessions.get(sessionId) !== session) return;
  void orchTerminateSession(sessionId, { origin });
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
  markSessionInputOrigin(sessionId, "human");
  if (session.state === "idle") {
    session.state = "busy";
    emitStateChange(wc, sessionId, "busy");
  }
  if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
  try {
    session.proc.write(data);
    publishSessionInput(sessionId, data, "human");
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

export function killSession(
  wc: WebContents,
  sessionId: string,
  options: { force?: boolean; startKey?: string; origin?: string } = {
    force: true,
  },
): void {
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
  const auth = sessionLeaseRegistry.authorizeKill(sessionId, options.startKey, {
    force: options.force ?? true,
  });
  if (!auth.ok) {
    console.warn(
      `[pty-lease] refuse kill (${auth.reason}) sessionId=${sessionId}`,
    );
    return;
  }
  destroySession(sessionId, session, options.origin);
}

export function killSessionsFor(wc: WebContents): void {
  for (const [id, session] of sessions) {
    if (session.wc !== wc) continue;
    const info = session.agent;
    if (
      info &&
      info.missionId &&
      info.role !== "user" &&
      info.source !== "direct-user"
    ) {
      // Renderer lifetime is presentation, not mission-process authority.
      // Keep the PTY and its replay buffer alive for the coordinator; a new
      // renderer may later adopt it through the sealed persisted pane.
      session.wc = null;
      continue;
    }
    destroySession(id, session, "renderer:window-close");
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
  options: {
    readonly markInputBusy?: boolean;
    readonly inputOrigin?: SessionInputOrigin;
  } = {},
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
  markSessionInputOrigin(sessionId, options.inputOrigin ?? "system");
  session.proc.write(data);
  publishSessionInput(sessionId, data, options.inputOrigin ?? "system");
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
export function orchKillSession(
  sessionId: string,
  options: { startKey?: string; force?: boolean; origin?: string } = {},
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  const auth = sessionLeaseRegistry.authorizeKill(sessionId, options.startKey, {
    force: options.force,
  });
  if (!auth.ok) {
    console.warn(
      `[pty-lease] refuse kill (${auth.reason}) sessionId=${sessionId}` +
        (options.startKey ? ` providedKey=${options.startKey}` : " (no startKey provided)"),
    );
    return false;
  }
  destroySession(sessionId, session, options.origin);
  return true;
}

export interface OrchTerminateSessionOptions {
  /** Grace window after SIGTERM. */
  readonly termTimeoutMs?: number;
  /** Final window after SIGKILL. A false result remains fail-closed. */
  readonly killTimeoutMs?: number;
  /**
   * F-212: rótulo estável de quem pediu a terminação (ex. 'pane-close',
   * 'mission-termination'). Vai para o trace e para `terminationOrigin` do
   * exit final. Sem rótulo o default é 'unlabeled'.
   */
  readonly origin?: string;
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
  origin: "app-shutdown",
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
  noteTerminationRequest(sessionId, options.origin ?? "unlabeled");
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
  // App quit: detach only — leave tmux agent sessions alive for reopen attach.
  for (const session of sessions.values()) {
    if (session.persistentTmuxName) {
      session.killPersistentOnFinalize = false;
    }
  }
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

/**
 * Stdin is writable when the session is still in the map, not in a
 * physical-termination flight, and `proc.write` accepts a no-op. Used with
 * session-liveness to decide whether a just-spawned writer is actually live.
 */
export function isSessionStdinWritable(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (physicalTerminationFlights.get(sessionId)?.session === session) {
    return false;
  }
  const proc = session.proc as PtyProcHandle & { writable?: boolean };
  if (proc.writable === false) return false;
  try {
    proc.write("");
    return true;
  } catch {
    return false;
  }
}

/**
 * Writer liveness used by Via Rápida: session is physically connected
 * (`live`) AND stdin accepts a write. `spawning` without a writable PTY
 * is not a live writer.
 */
export function isPtySessionConnectedAndWritable(sessionId: string): boolean {
  return isConnectedAndWritable(
    classifySessionLiveness(getSessionState(sessionId)),
    isSessionStdinWritable(sessionId),
  );
}

/** Criação da sessão no main (ms): o portão de regressão usa o HEAD desse instante como base. */
export function getSessionSpawnedAtMs(sessionId: string): number | null {
  return sessions.get(sessionId)?.spawnedAtMs ?? null;
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

export function inspectSessionLease(sessionId: string): SessionLease | null {
  return sessionLeaseRegistry.inspectLease(sessionId);
}

export function getSessionLeaseMetrics() {
  return sessionLeaseRegistry.getMetrics();
}

export { sessionLeaseRegistry, warmPool };

warmPool.setIsAliveFn((sessionId) => sessions.has(sessionId));
warmPool.setDestroyFn((sessionId, startKey) => {
  orchKillSession(sessionId, {
    startKey,
    force: !startKey,
    origin: "warm-pool",
  });
});

/**
 * Criação de pane warm (paridade Overclock warm-pool). Evita recursão com o
 * `take()` do spawnAgentSession enquanto o próprio pool está repondo.
 */
let warmSpawnDepth = 0;

function warmSpawnInProgress(): boolean {
  return warmSpawnDepth > 0;
}

/**
 * Adota um pane do warm pool para um spawn cujo pedido já provou ser o
 * contrato de nascimento dele (`requestMatchesWarmContract`). Nada do
 * `session.agent` é reescrito: rótulo diferente do processo seria mentira
 * (F-642). `null` = miss → cold spawn normal.
 */
export function tryAdoptWarmSession(
  cli: string,
  authority: BoundSpawnAuthority,
  cwd: string,
): SpawnedSession | null {
  const warm = warmPool.take(cli);
  if (!warm) return null;
  const session = sessions.get(warm.sessionId);
  if (!session || !session.agent || !warm.startKey) {
    try {
      orchKillSession(warm.sessionId, {
        startKey: warm.startKey || undefined,
        force: !warm.startKey,
        origin: "warm-pool:adopt-miss",
      });
    } catch {
      /* pane warm já morreu — miss honesto */
    }
    return null;
  }
  // O sessionId já tem outro lease: a entrada do pool é velha, não é nossa.
  if (session.startKey !== warm.startKey) return null;
  if (session.agent.adapterId !== cli || !warmSessionServes(warm, cli, authority, cwd)) {
    warmPool.put(warm);
    return null;
  }
  return { sessionId: warm.sessionId, startKey: warm.startKey };
}

/**
 * Registra quem sabe criar um CLI ocioso para o pool. Sem criador, o pool
 * fica vazio (take = miss) e o spawn continua frio — honesto, nunca trava.
 */
export function setWarmAgentSpawner(
  fn: ((cli: string) => Promise<WarmSession | null>) | null,
): void {
  if (!fn) {
    warmPool.setSpawnFn(async () => null);
    return;
  }
  warmPool.setSpawnFn(async (cli) => {
    if (warmSpawnInProgress()) return null;
    warmSpawnDepth += 1;
    try {
      return await fn(cli);
    } finally {
      warmSpawnDepth -= 1;
    }
  });
}

export { warmSpawnInProgress };

/**
 * F-572: footprint (RSS da árvore de processos) de cada sessão viva no host
 * PTY. `null` = host ausente/mudo ou plataforma sem `ps` — telemetria ausente,
 * nunca pressão inventada. Usado por nexus_perf_snapshot e pelo doctor.
 */
export function probePaneFootprints(): Promise<
  readonly import("./pane-footprint").SessionFootprint[] | null
> {
  const probe = ptyHost?.probeFootprints;
  if (!probe) return Promise.resolve(null);
  return probe.call(ptyHost).catch(() => null);
}

/** F-572: sessões de agente (cli-agent) vivas neste main — insumo do teto. */
export function countLiveAgentSessions(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.agent && session.state !== "exited") count += 1;
  }
  return count;
}
