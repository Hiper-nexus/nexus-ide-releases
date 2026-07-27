import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { PTY_CHANNELS } from '../../shared/channels';
import {
  OMP_RPC_CHANNELS,
  ompRpcPromptRequestSchema,
  ompRpcRespondUiRequestSchema,
  ompRpcSessionRefSchema,
  ompRpcSetModelRequestSchema,
  ompRpcStartRequestSchema,
  type OmpApprovalPolicy,
  type OmpHostToolDefinition,
  type OmpRpcCommandResult,
  type OmpRpcEventEnvelope,
  type OmpRpcGetStateResult,
  type OmpRpcListModelsResult,
  type OmpRpcPushEvent,
  type OmpRpcSessionLifecycle,
  type OmpRpcStartResult,
  type OmpRpcStateSnapshot,
} from '../../shared/omp-rpc-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { auditSuccess } from '../jarvis/audit-log';
import {
  bindTokenToSession,
  mintToken,
  releaseSession,
  releaseSessionByToken,
  type AgentGateContext,
} from '../orch/gate';
import { dispatchToolCall } from '../orch/mcp-dispatch';
import type { McpRegistry } from '../orch/mcp-protocol';
import { runInsideOmpRpcHostCall } from '../orch/http-mcp-boundary';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import { buildToolset } from '../orch/tools';
import {
  publishExternalSessionExit,
  publishSessionActivityState,
} from '../pty/pty-manager';
import {
  registerExternalWorkerSession,
  unregisterExternalWorkerSession,
} from '../orch/external-worker-session-registry';
import {
  getRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  OmpRpcSession,
  buildOmpChildEnv,
  waitForOmpSessionReady,
  type OmpAutoApprovalRecord,
} from './omp-rpc-service';
import {
  preflightOmpRpcSpawn,
  type OmpCredentialScope,
} from '../pty/pre-spawn-probe';

/**
 * IPC do domínio ompRpc: hospeda sessões `omp --mode rpc-ui` como agentes de
 * primeira classe (sem PTY). Cada sessão ganha um token de gate REAL
 * (mintToken) restrito às host tools abaixo; host_tool_call passa pelo
 * dispatcher MCP existente — mesmo enforcement de allowlist + auditoria.
 */

/**
 * Host tools exposed to omp via set_host_tools. Keep this a curated worker
 * surface (not the full 100+ toolset): situational awareness + handoff +
 * read/write workspace + light git. Destructive mission control stays on PTY
 * panes with full MCP inject.
 */
export const OMP_HOST_TOOL_NAMES = [
  'nexus_pane_list',
  'nexus_mission_get',
  'nexus_mission_list',
  'nexus_workflow_get',
  'nexus_handoff_list',
  'nexus_handoff_submit',
  'nexus_route_task',
  'nexus_file_read',
  'nexus_file_search',
  'nexus_file_write',
  'nexus_git_status',
  'nexus_git_diff',
  'nexus_git_log',
  'nexus_git_add',
  'nexus_git_commit',
] as const;

/**
 * A renderer-started panel is not a mission worker. Its host surface is
 * deliberately observational: a compromised renderer cannot turn a chat
 * drawer into a file/git/orchestration mutation path.
 */
export const OMP_PANEL_HOST_TOOL_NAMES = [
  'nexus_pane_list',
  'nexus_mission_get',
  'nexus_mission_list',
  'nexus_workflow_get',
  'nexus_handoff_list',
  'nexus_file_read',
  'nexus_file_search',
  'nexus_git_status',
  'nexus_git_diff',
  'nexus_git_log',
] as const;

const HOST_TOOL_NAMES = OMP_HOST_TOOL_NAMES;

const MAX_SESSIONS_PER_RENDERER = 4;

interface HostedSession {
  session: OmpRpcSession;
  gateCtx: AgentGateContext;
  gateSessionId: string;
  /** Renderer that started the session (null = mission-side worker). */
  owner: WebContents | null;
  scope: ProjectExecutionScope;
  /** Synthetic pane id for mission composition / fleet (`omp-rpc:<uuid>`). */
  paneId: string;
  kind: 'panel' | 'mission';
  title: string;
  /**
   * Exact launcher credential material present in this already-running
   * process. Kept main-only and never serialized/logged. A live model switch
   * is allowed only when its exact preflight resolves to the same scope;
   * otherwise the process must be restarted so old/new providers cannot
   * share an environment.
   */
  launchCredentialEnv: Readonly<Record<string, string>>;
  /**
   * Secret-free provider/auth authority for the running child. Environment
   * equality alone is insufficient: two broker-backed providers both have an
   * empty launcher env but still represent distinct credential authorities.
   */
  launchCredentialScope: OmpCredentialScope;
  /** Logical capability revocation may precede physical process exit. */
  revoked?: boolean;
  /** One physical tree fence per hosted identity; false proofs remain retryable. */
  termination?: Promise<boolean>;
}

function sameCredentialEnv(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && left[key] === right[key],
    )
  );
}

function sameCredentialScope(
  left: OmpCredentialScope,
  right: OmpCredentialScope,
): boolean {
  const leftEnvNames = [...left.envNames].sort();
  const rightEnvNames = [...right.envNames].sort();
  return (
    left.modelProvider === right.modelProvider &&
    left.source === right.source &&
    left.authorityProviderId === right.authorityProviderId &&
    leftEnvNames.length === rightEnvNames.length &&
    leftEnvNames.every(
      (envName, index) => envName === rightEnvNames[index],
    )
  );
}

const sessions = new Map<string, HostedSession>();
const ownerCleanup = new Map<WebContents, () => void>();
let disposeAllFlight: Promise<OmpRpcShutdownResult> | null = null;
let ompLifecycleEpoch = 0;
let ompShutdownRequested = false;

interface OmpSpawnFence {
  readonly epoch: number;
  /** True once the child has entered the stable `sessions` inventory. */
  materialized: boolean;
  revoked: boolean;
  released: boolean;
  readonly settled: Promise<void>;
  settle(): void;
}

const inFlightSpawns = new Set<OmpSpawnFence>();

function acquireOmpSpawnFence(): OmpSpawnFence {
  if (ompShutdownRequested || disposeAllFlight) {
    throw new Error('OMP shutdown is in progress; new sessions are blocked');
  }
  let settle!: () => void;
  const fence: OmpSpawnFence = {
    epoch: ompLifecycleEpoch,
    materialized: false,
    revoked: false,
    released: false,
    settled: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    settle: () => settle(),
  };
  inFlightSpawns.add(fence);
  return fence;
}

function assertOmpSpawnFence(fence: OmpSpawnFence): void {
  if (
    fence.released ||
    fence.revoked ||
    fence.epoch !== ompLifecycleEpoch ||
    ompShutdownRequested
  ) {
    throw new Error('OMP spawn authority was revoked by shutdown');
  }
}

function releaseOmpSpawnFence(fence: OmpSpawnFence): void {
  if (fence.released) return;
  fence.released = true;
  inFlightSpawns.delete(fence);
  fence.settle();
}

let registry: McpRegistry | null = null;

function hostRegistry(): McpRegistry {
  if (!registry) {
    registry = {
      tools: buildToolset(),
      serverName: 'nexus-ide-omp-host',
      serverVersion: '1.0.0',
    };
  }
  return registry;
}

/**
 * Deriva as definições de host tool dos registros MCP existentes.
 * When `allowedToolNames` is set, only those names (∩ host catalog) are
 * advertised via set_host_tools — never advertise tools the gate will deny.
 */
export function buildOmpHostToolDefinitions(
  source: McpRegistry = hostRegistry(),
  allowedToolNames?: readonly string[] | null,
): OmpHostToolDefinition[] {
  const byName = new Map(source.tools.map((tool) => [tool.name, tool]));
  const allow = allowedToolNames == null ? null : new Set(allowedToolNames);
  const defs: OmpHostToolDefinition[] = [];
  for (const name of HOST_TOOL_NAMES) {
    if (allow && !allow.has(name)) continue;
    const tool = byName.get(name);
    if (!tool) continue;
    defs.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    });
  }
  return defs;
}

function resolveWorkspaceRoot(
  scope: ProjectExecutionScope,
  requested: string | undefined,
): string {
  if (!requested) return scope.rootRealPath;
  const resolved = path.resolve(requested);
  if (
    resolved !== scope.rootRealPath &&
    !resolved.startsWith(scope.rootRealPath + path.sep)
  ) {
    throw new Error('workspaceRoot fora do escopo de projeto autorizado');
  }
  return resolved;
}

function sessionsForOwner(owner: WebContents): number {
  let count = 0;
  for (const hosted of sessions.values()) {
    if (hosted.owner === owner) count += 1;
  }
  return count;
}

function revokeHostedSession(sessionId: string, hosted: HostedSession): void {
  if (hosted.revoked) return;
  hosted.revoked = true;
  // Synchronous ordering matters: lifecycle resolves the exact gate context
  // and durable dispatch before either registry is removed.
  publishExternalSessionExit(sessionId);
  unregisterExternalWorkerSession(sessionId);
  releaseSession(hosted.gateSessionId);
}

async function terminateHostedSession(
  sessionId: string,
  hosted: HostedSession,
  options: TerminateOmpRpcSessionOptions = {},
): Promise<boolean> {
  if (sessions.get(sessionId) !== hosted) return true;
  if (hosted.termination) return hosted.termination;
  revokeHostedSession(sessionId, hosted);
  const stream = paneStreams.get(sessionId);
  if (stream) stream.disposed = true;
  const operation = (async () => {
    const proof = await hosted.session.terminate({
      ...(options.timeoutMs !== undefined
        ? { termTimeoutMs: options.timeoutMs }
        : {}),
      ...(options.killTimeoutMs !== undefined
        ? { killTimeoutMs: options.killTimeoutMs }
        : {}),
      ...(options.snapshotTimeoutMs !== undefined
        ? { snapshotTimeoutMs: options.snapshotTimeoutMs }
        : {}),
    });
    if (!proof.ok || !proof.rootExited || !proof.descendantsExited) {
      console.warn(
        `[omp-rpc:${sessionId}] physical process-tree exit not proven: ` +
          (proof.error ?? 'root/descendant proof incomplete'),
      );
      return false;
    }
    paneStreams.delete(sessionId);
    if (sessions.get(sessionId) === hosted) sessions.delete(sessionId);
    return true;
  })().catch((error) => {
    console.warn(
      `[omp-rpc:${sessionId}] physical process-tree fence failed:`,
      error,
    );
    return false;
  });
  hosted.termination = operation;
  const terminated = await operation;
  if (!terminated && hosted.termination === operation) {
    hosted.termination = undefined;
  }
  return terminated;
}

/**
 * Synchronous lifecycle callers may request revocation, but this return value
 * means only "known and termination started". Physical success is available
 * exclusively through terminateOmpRpcSession/disposeAllOmpRpcSessions.
 */
function disposeSession(sessionId: string): boolean {
  const hosted = sessions.get(sessionId);
  if (!hosted) return false;
  void terminateHostedSession(sessionId, hosted);
  return true;
}

function assertLiveRendererOwner(owner: WebContents): void {
  try {
    if (owner.isDestroyed() || owner.isCrashed()) {
      throw new Error('renderer owner disappeared during OMP spawn');
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'renderer owner disappeared during OMP spawn'
    ) {
      throw error;
    }
    throw new Error('renderer owner became unavailable during OMP spawn');
  }
}

function watchOwner(owner: WebContents): void {
  if (ownerCleanup.has(owner)) return;
  const onDestroyed = () => {
    ownerCleanup.delete(owner);
    for (const [sessionId, hosted] of [...sessions.entries()]) {
      // Mission workers outlive a single renderer; only dispose panel sessions.
      if (hosted.owner === owner && hosted.kind === 'panel') {
        disposeSession(sessionId);
      }
    }
  };
  ownerCleanup.set(owner, onDestroyed);
  owner.once('destroyed', onDestroyed);
}

function sendOmpEvent(wc: WebContents, envelope: OmpRpcEventEnvelope): void {
  if (wc.isDestroyed()) return;
  try {
    wc.send(OMP_RPC_CHANNELS.event, envelope);
  } catch {
    // Window tearing down — ignore.
  }
}

/**
 * Push routing (hardening): envelopes carry message deltas — real session
 * CONTENT — so they must stay inside the session trust boundary instead of
 * hitting every window of every project.
 * - panel sessions → only the owning renderer (mirrors requireSession, which
 *   is owner-scoped for panel kind);
 * - mission workers → only windows bound to the same project scope, so
 *   fleet/rail/panel of sibling windows stay in sync while foreign projects
 *   and scope-less auxiliary windows never receive a byte.
 */
function pushEvent(hosted: HostedSession, event: OmpRpcPushEvent): void {
  const envelope: OmpRpcEventEnvelope = {
    sessionId: hosted.session.sessionId,
    event,
  };
  if (hosted.kind === 'panel') {
    if (hosted.owner) sendOmpEvent(hosted.owner, envelope);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const rendererScope = getRendererWorkspaceScope(win.webContents);
    if (rendererScope && sameProjectScope(rendererScope, hosted.scope)) {
      sendOmpEvent(win.webContents, envelope);
    }
  }
}

function requireObservableSession(
  owner: WebContents,
  raw: unknown,
): HostedSession {
  const parsed = ompRpcSessionRefSchema.safeParse(raw);
  if (!parsed.success) throw new Error('payload inválido');
  const hosted = sessions.get(parsed.data.sessionId);
  if (!hosted) {
    throw new Error('sessão omp desconhecida para este renderer');
  }
  // Panel sessions are owner-scoped; mission workers are project-scoped for
  // observation only (mutation is fenced by requireRendererMutableSession).
  if (hosted.kind === 'panel' && hosted.owner !== owner) {
    throw new Error('sessão omp desconhecida para este renderer');
  }
  if (hosted.kind === 'mission') {
    const rendererScope = getRendererWorkspaceScope(owner);
    if (!rendererScope || !sameProjectScope(rendererScope, hosted.scope)) {
      throw new Error('sessão omp de missão fora do escopo deste projeto');
    }
  }
  return hosted;
}

/**
 * Renderer mutation is owner-scoped to panel sessions. Mission rpc-ui
 * sessions belong to the main scheduler even when their output/state is
 * observable by same-project windows.
 */
function requireRendererMutableSession(
  owner: WebContents,
  raw: unknown,
): HostedSession {
  const hosted = requireObservableSession(owner, raw);
  if (hosted.kind === 'mission') {
    throw new Error(
      'sessão de missão OMP é controlada exclusivamente pelo scheduler main',
    );
  }
  return hosted;
}

function isRendererUiRejection(
  response: { value: string } | { confirmed: boolean } | { cancelled: true },
): boolean {
  return (
    ('confirmed' in response && response.confirmed === false) ||
    ('cancelled' in response && response.cancelled === true)
  );
}

export interface OmpSessionSummary {
  sessionId: string;
  paneId: string;
  kind: 'panel' | 'mission';
  title: string;
  missionId?: string;
  state: OmpRpcSessionLifecycle;
  snapshot: OmpRpcStateSnapshot;
}

/** Trusted main-only identity for teardown/reconciliation. Never exposed by IPC. */
export interface OmpRpcSessionAuthority {
  readonly sessionId: string;
  readonly paneId: string;
  readonly kind: 'panel' | 'mission';
  readonly missionId?: string;
  readonly workerIncarnationId?: string;
  readonly role: AgentGateContext['role'];
  readonly scope: Readonly<ProjectExecutionScope>;
}

export function getOmpRpcSessionAuthority(
  sessionId: string,
): OmpRpcSessionAuthority | null {
  const hosted = sessions.get(sessionId);
  if (!hosted) return null;
  return Object.freeze({
    sessionId,
    paneId: hosted.paneId,
    kind: hosted.kind,
    ...(hosted.gateCtx.missionId
      ? { missionId: hosted.gateCtx.missionId }
      : {}),
    ...(hosted.gateCtx.workerIncarnationId
      ? { workerIncarnationId: hosted.gateCtx.workerIncarnationId }
      : {}),
    role: hosted.gateCtx.role,
    scope: Object.freeze({ ...hosted.scope }),
  });
}

/** Live omp rpc-ui sessions for fleet / ops surfaces. */
export function listOmpRpcSessions(owner?: WebContents): OmpSessionSummary[] {
  const rendererScope = owner ? getRendererWorkspaceScope(owner) : null;
  return [...sessions.values()]
    .filter((hosted) => {
      if (!owner) return true;
      // Same trust boundary as requireObservableSession/pushEvent: panel → owning
      // renderer only; mission → same-project windows only.
      if (hosted.kind === 'panel') return hosted.owner === owner;
      return (
        rendererScope !== null && sameProjectScope(rendererScope, hosted.scope)
      );
    })
    .map((hosted) => ({
      sessionId: hosted.session.sessionId,
      paneId: hosted.paneId,
      kind: hosted.kind,
      title: hosted.title,
      missionId: hosted.gateCtx.missionId,
      state: hosted.session.state,
      snapshot: hosted.session.snapshot(),
    }));
}

export interface OmpRpcRuntimeSummary {
  readonly total: number;
  readonly busy: number;
}

const OMP_RUNTIME_BUSY_STATES = new Set<OmpRpcSessionLifecycle>([
  'spawning',
  'ready',
  'busy',
]);

/**
 * Complete global OMP admission + process inventory for native close/quit.
 * A preflight awaiting provider discovery is already an admitted spawn and
 * must count as busy: once its await resumes it may construct a child before
 * renderer teardown observers can run. Materialized fences are excluded
 * because their child is already represented in `sessions`.
 */
export function liveOmpRpcRuntimeSummary(): OmpRpcRuntimeSummary {
  const pending = [...inFlightSpawns].filter(
    (fence) => !fence.released && !fence.materialized,
  ).length;
  return Object.freeze({
    total: sessions.size + pending,
    busy:
      pending +
      [...sessions.values()].filter((hosted) =>
        OMP_RUNTIME_BUSY_STATES.has(hosted.session.state),
      ).length,
  });
}

export interface MissionOmpWorkerInput {
  scope: ProjectExecutionScope;
  /**
   * Concrete filesystem authority for this worker. It may be a task worktree
   * while `scope` remains the mission's coordination checkout.
   */
  executionScope: ProjectExecutionScope;
  missionId?: string;
  model?: string;
  title?: string;
  agentName?: string;
  workerIncarnationId?: string;
  prompt?: string;
  approvalPolicy?: OmpApprovalPolicy;
  allowedTools?: string[] | null;
  /** Dispatch cancellation/revocation propagated from the parent MCP call. */
  signal?: AbortSignal;
  /** Exact live-authority assertion at asynchronous linearization points. */
  assertCurrentAuthority?: () => void;
  /**
   * Durable bind fence. Called after bootstrap proves the child ready and
   * before the first prompt can produce agent_start/host_tool_call.
   */
  onSessionReady?: (paneId: string, sessionId: string) => void;
  /** Persist pane composition only after prompt acceptance is proven. */
  onAccepted?: (paneId: string, sessionId: string) => void;
}

function assertMissionOmpSpawnAuthority(
  input: Pick<MissionOmpWorkerInput, 'signal' | 'assertCurrentAuthority'>,
): void {
  input.assertCurrentAuthority?.();
  if (!input.signal?.aborted) return;
  if (input.signal.reason instanceof Error) throw input.signal.reason;
  throw new Error(
    typeof input.signal.reason === 'string'
      ? input.signal.reason
      : 'session_authority_revoked',
  );
}

async function awaitMissionOmpSpawnStep<T>(
  promise: Promise<T>,
  input: Pick<MissionOmpWorkerInput, 'signal' | 'assertCurrentAuthority'>,
): Promise<T> {
  assertMissionOmpSpawnAuthority(input);
  const signal = input.signal;
  if (!signal) {
    const value = await promise;
    assertMissionOmpSpawnAuthority(input);
    return value;
  }
  let onAbort: (() => void) | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          try {
            assertMissionOmpSpawnAuthority(input);
          } catch (error) {
            reject(error);
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    assertMissionOmpSpawnAuthority(input);
    return value;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Failure fence for the dual OMP transport. `sideEffectStarted=false` is the
 * only class the `auto` mode may safely redirect to PTY. Once construction of
 * the rpc-ui child has begun, delivery is ambiguous until reconciled, so an
 * automatic second spawn would risk duplicate workers.
 */
export class OmpMissionSpawnError extends Error {
  readonly sideEffectStarted: boolean;

  constructor(error: unknown, sideEffectStarted: boolean) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'OmpMissionSpawnError';
    this.sideEffectStarted = sideEffectStarted;
  }
}

export function isSafeOmpMissionPreflightFailure(error: unknown): boolean {
  return error instanceof OmpMissionSpawnError && !error.sideEffectStarted;
}

function assertMissionExecutionScope(
  coordinationScope: ProjectExecutionScope,
  executionScope: ProjectExecutionScope,
): void {
  if (
    executionScope.installationId !== coordinationScope.installationId ||
    executionScope.projectId !== coordinationScope.projectId ||
    executionScope.checkoutId !== coordinationScope.checkoutId
  ) {
    throw new Error(
      'OMP execution scope must belong to the coordination scope',
    );
  }
  if (
    !path.isAbsolute(executionScope.rootRealPath) ||
    path.normalize(executionScope.rootRealPath) !== executionScope.rootRealPath
  ) {
    throw new Error('OMP execution root must be an absolute normalized path');
  }
}

/**
 * Spawn omp --mode rpc-ui as a mission worker (no PTY). Used when
 * orch.ompMissionTransport is `rpc` or `auto`.
 */
export async function spawnMissionOmpRpcWorker(
  input: MissionOmpWorkerInput,
): Promise<{ paneId: string; sessionId: string }> {
  let spawnFence: OmpSpawnFence;
  try {
    spawnFence = acquireOmpSpawnFence();
  } catch (error) {
    throw new OmpMissionSpawnError(error, false);
  }
  try {
    return await spawnMissionOmpRpcWorkerWithFence(input, spawnFence);
  } finally {
    releaseOmpSpawnFence(spawnFence);
  }
}

async function spawnMissionOmpRpcWorkerWithFence(
  input: MissionOmpWorkerInput,
  spawnFence: OmpSpawnFence,
): Promise<{ paneId: string; sessionId: string }> {
  // Exact provider/model auth + version pin happen before minting any gate
  // token or constructing the agent process.
  let preflight: Awaited<ReturnType<typeof preflightOmpRpcSpawn>>;
  try {
    assertMissionExecutionScope(input.scope, input.executionScope);
    if (sessions.size >= MAX_SESSIONS_PER_RENDERER * 2) {
      throw new Error('limite global de sessões omp atingido');
    }
    preflight = await awaitMissionOmpSpawnStep(
      preflightOmpRpcSpawn(input.model),
      input,
    );
    assertMissionOmpSpawnAuthority(input);
    assertOmpSpawnFence(spawnFence);
  } catch (error) {
    throw new OmpMissionSpawnError(error, false);
  }
  const sessionId = randomUUID();
  const paneId = `omp-rpc:${sessionId}`;
  // The dispatcher, handoff store and gate must share the exact same opaque
  // physical identity. `paneId` remains namespaced for UI presentation.
  const gateSessionId = sessionId;
  // Gate allowlist ∩ host tools. Null/undefined = full curated host set.
  // Explicit roster allowlist keeps only tools both sides accept.
  const hostSet = new Set<string>(HOST_TOOL_NAMES);
  const allowedTools =
    input.allowedTools === null || input.allowedTools === undefined
      ? [...HOST_TOOL_NAMES]
      : input.allowedTools.filter((name) => hostSet.has(name));
  const gateCtx = mintToken({
    label: input.agentName ?? 'omp-rpc-mission',
    role: 'worker',
    providerId: 'omp',
    missionId: input.missionId,
    workerIncarnationId: input.workerIncarnationId,
    scope: input.scope,
    executionScope: input.executionScope,
    allowedTools,
    allowedSkills: [],
  });
  try {
    bindTokenToSession(gateCtx.token, gateSessionId);
  } catch (err) {
    releaseSessionByToken(gateCtx.token);
    throw err;
  }

  const hostedRef: { current: HostedSession | null } = { current: null };
  let session: OmpRpcSession;
  try {
    assertMissionOmpSpawnAuthority(input);
    // Mission workers run unattended: yolo + audited auto-approve. `safe` would
    // hang on extension_ui_request because the panel only mirrors one session.
    session = new OmpRpcSession(
      {
        sessionId,
        workspaceRoot: input.executionScope.rootRealPath,
        approvalPolicy: input.approvalPolicy ?? 'yolo',
        binPath: preflight.binPath,
        governed: true,
        model: preflight.model,
        env: {
          ...buildOmpChildEnv(),
          ...preflight.keyEnv,
        },
        credentialSecrets: Object.values(preflight.keyEnv),
      },
      {
        hostTools: buildOmpHostToolDefinitions(hostRegistry(), allowedTools),
        dispatchHostTool: async (toolName, args, physicalCall) => {
          const outcome = await runInsideOmpRpcHostCall(
            physicalCall,
            gateCtx,
            toolName,
            () =>
              dispatchToolCall(
                'omp-rpc-stdio',
                hostRegistry(),
                toolName,
                args,
                gateCtx,
              ),
          );
          return outcome.ok
            ? { ok: true, result: outcome.result }
            : { ok: false, error: outcome.error ?? 'tool negada' };
        },
        auditAutoApproval: (record: OmpAutoApprovalRecord) => {
          auditSuccess(
            { scope: input.scope, missionId: input.missionId },
            gateSessionId,
            'omp_ui_auto_approval',
            {
              requestId: record.requestId,
              method: record.method,
              title: record.title,
              decision: record.decision,
              ...(record.detail ? { detail: record.detail } : {}),
              policy: 'yolo',
            },
            0,
            false,
            'omp-rpc-stdio',
          );
        },
        onPush: (event) => {
          const hosted = hostedRef.current;
          if (hosted) pushEvent(hosted, event);
          if (event.kind === 'status') {
            publishSessionActivityState(
              sessionId,
              event.state === 'busy' ? 'busy' : 'idle',
            );
          } else if (
            event.kind === 'text-delta' ||
            event.kind === 'thinking-delta' ||
            event.kind === 'tool' ||
            event.kind === 'message-end'
          ) {
            publishSessionActivityState(sessionId, 'busy');
          }
          if (event.kind === 'exit') disposeSession(sessionId);
        },
      },
    );
  } catch (err) {
    releaseSession(gateSessionId);
    throw new OmpMissionSpawnError(err, true);
  }

  const hosted: HostedSession = {
    session,
    gateCtx,
    gateSessionId,
    owner: null,
    scope: input.scope,
    paneId,
    kind: 'mission',
    title: input.title ?? input.agentName ?? 'Oh My Pi',
    launchCredentialEnv: preflight.keyEnv,
    launchCredentialScope: preflight.credentialScope,
  };
  hostedRef.current = hosted;
  sessions.set(sessionId, hosted);
  spawnFence.materialized = true;
  // The child and its physical identity are now synchronously inventoried.
  // Releasing here lets shutdown terminate it instead of waiting on readiness.
  releaseOmpSpawnFence(spawnFence);
  if (session.state === 'exited') {
    const terminated = await terminateHostedSession(sessionId, hosted);
    throw new OmpMissionSpawnError(
      new Error(
        terminated
          ? 'processo omp encerrou durante o spawn'
          : 'processo omp encerrou durante o spawn sem prova física completa; substituição bloqueada',
      ),
      true,
    );
  }
  if (input.missionId) {
    try {
      registerExternalWorkerSession({
        sessionId,
        missionId: input.missionId,
        workerIncarnationId: input.workerIncarnationId,
        scope: input.scope,
      });
    } catch (error) {
      await terminateHostedSession(sessionId, hosted);
      throw new OmpMissionSpawnError(error, true);
    }
  }

  try {
    await awaitMissionOmpSpawnStep(waitForOmpSessionReady(session), input);
    assertMissionOmpSpawnAuthority(input);
    input.onSessionReady?.(paneId, sessionId);
    if (input.prompt) {
      await awaitMissionOmpSpawnStep(
        session.promptAndWaitForAgentStart(input.prompt),
        input,
      );
    }
    assertMissionOmpSpawnAuthority(input);
    if ((session.state as OmpRpcSessionLifecycle) === 'exited') {
      throw new Error('processo omp encerrou durante o aceite do worker');
    }
    input.onAccepted?.(paneId, sessionId);
  } catch (err) {
    // A failed readiness/prompt transaction is not a live worker. Tear down
    // the child and its gate token so retries do not leak fleet slots.
    await terminateHostedSession(sessionId, hosted);
    throw new OmpMissionSpawnError(err, true);
  }
  return { paneId, sessionId };
}

/* ---------------------------------------------------------------------------
 * Grid panes (cli-rpc): an RPC session presented to the grid as an ordinary
 * terminal pane. Text streams through PTY data events with per-session
 * sequences plus a replay buffer, so the preload's Orca gap-recovery works
 * unchanged; busy/idle derives from protocol status events (never the 800ms
 * PTY timeout); line-buffered terminal input maps to prompts; kill → dispose
 * with a synthetic exit. Policy is yolo + audited auto-approve: the terminal
 * view cannot render interactive ui-request dialogs, so `safe` would hang
 * unanswered (documented divergence from the drawer panel).
 * ------------------------------------------------------------------------- */

interface RpcPaneStream {
  paneId: string;
  /** Null after main detaches a mission pane from a renderer presentation. */
  owner: WebContents | null;
  nextSequence: number;
  replay: Array<{ sequence: number; data: string }>;
  inputBuffer: string;
  disposed: boolean;
}

const paneStreams = new Map<string, RpcPaneStream>();

/** Ring cap so a long session cannot grow the replay buffer unbounded. */
const RPC_PANE_REPLAY_CAP = 4096;

function emitRpcPaneData(
  stream: RpcPaneStream,
  sessionId: string,
  data: string,
): void {
  const owner = stream.owner;
  if (stream.disposed || !owner || owner.isDestroyed()) return;
  const sequence = stream.nextSequence;
  stream.nextSequence += 1;
  stream.replay.push({ sequence, data });
  if (stream.replay.length > RPC_PANE_REPLAY_CAP) stream.replay.shift();
  try {
    owner.send(PTY_CHANNELS.data, { sessionId, sequence, data });
  } catch {
    // Window tearing down — the replay buffer still has the chunk.
  }
}

function emitRpcPaneExit(
  stream: RpcPaneStream,
  sessionId: string,
  code: number | null,
): void {
  const owner = stream.owner;
  if (!owner || owner.isDestroyed()) return;
  try {
    owner.send(PTY_CHANNELS.exit, {
      sessionId,
      exitCode: code ?? 0,
    });
  } catch {
    // Window tearing down.
  }
}

/** Dim single-line marker for non-text protocol events (tool runs, notices). */
function rpcPaneMarkerLine(text: string): string {
  return `[2m${text}[0m\r\n`;
}

export interface OmpRpcPaneInput {
  owner: WebContents;
  scope: ProjectExecutionScope;
  workspaceRoot: string;
  /** Real pane id from the layout flow; synthetic `omp-rpc:<uuid>` fallback. */
  paneId?: string;
  title?: string;
  agentName?: string;
  workerIncarnationId?: string;
  model?: string;
  missionId?: string;
  prompt?: string;
  allowedTools?: string[] | null;
  /**
   * Main-owned live-grant assertion. Provider discovery may await; this fence
   * runs after that await and immediately before token/process creation.
   */
  assertAuthority?: () => void;
}

export type OmpRpcPaneResult =
  { ok: true; sessionId: string } | { ok: false; error: string };

/**
 * Spawn `omp --mode rpc-ui` as a first-class GRID pane (kind panel, real
 * paneId, owner-bound): the terminal cell streams the session like any PTY
 * pane, but lifecycle is protocol-driven. Mirrors spawnMissionOmpRpcWorker
 * for gate/audit semantics.
 */
export async function spawnOmpRpcPane(
  input: OmpRpcPaneInput,
): Promise<OmpRpcPaneResult> {
  let spawnFence: OmpSpawnFence;
  try {
    spawnFence = acquireOmpSpawnFence();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    return await spawnOmpRpcPaneWithFence(input, spawnFence);
  } finally {
    releaseOmpSpawnFence(spawnFence);
  }
}

async function spawnOmpRpcPaneWithFence(
  input: OmpRpcPaneInput,
  spawnFence: OmpSpawnFence,
): Promise<OmpRpcPaneResult> {
  try {
    assertLiveRendererOwner(input.owner);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (sessionsForOwner(input.owner) >= MAX_SESSIONS_PER_RENDERER) {
    return { ok: false, error: 'limite de sessões omp atingido' };
  }
  let preflight: Awaited<ReturnType<typeof preflightOmpRpcSpawn>>;
  try {
    preflight = await preflightOmpRpcSpawn(input.model);
    input.assertAuthority?.();
    assertOmpSpawnFence(spawnFence);
    assertLiveRendererOwner(input.owner);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const sessionId = randomUUID();
  const paneId = input.paneId ?? `omp-rpc:${sessionId}`;
  const gateSessionId = sessionId;
  const hostSet = new Set<string>(HOST_TOOL_NAMES);
  const allowedTools =
    input.allowedTools === null || input.allowedTools === undefined
      ? [...HOST_TOOL_NAMES]
      : input.allowedTools.filter((name) => hostSet.has(name));
  const gateCtx = mintToken({
    label: input.agentName ?? 'omp-rpc-pane',
    role: 'worker',
    providerId: 'omp',
    missionId: input.missionId,
    workerIncarnationId: input.workerIncarnationId,
    scope: input.scope,
    allowedTools,
    allowedSkills: [],
  });
  try {
    bindTokenToSession(gateCtx.token, gateSessionId);
  } catch (err) {
    releaseSessionByToken(gateCtx.token);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const stream: RpcPaneStream = {
    paneId,
    owner: input.owner,
    nextSequence: 1,
    replay: [],
    inputBuffer: '',
    disposed: false,
  };

  const hostedRef: { current: HostedSession | null } = { current: null };
  let session: OmpRpcSession;
  try {
    session = new OmpRpcSession(
      {
        sessionId,
        workspaceRoot: input.workspaceRoot,
        approvalPolicy: 'yolo',
        binPath: preflight.binPath,
        governed: true,
        model: preflight.model,
        env: {
          ...buildOmpChildEnv(),
          ...preflight.keyEnv,
        },
        credentialSecrets: Object.values(preflight.keyEnv),
      },
      {
        hostTools: buildOmpHostToolDefinitions(hostRegistry(), allowedTools),
        dispatchHostTool: async (toolName, args, physicalCall) => {
          const outcome = await runInsideOmpRpcHostCall(
            physicalCall,
            gateCtx,
            toolName,
            () =>
              dispatchToolCall(
                'omp-rpc-stdio',
                hostRegistry(),
                toolName,
                args,
                gateCtx,
              ),
          );
          return outcome.ok
            ? { ok: true, result: outcome.result }
            : { ok: false, error: outcome.error ?? 'tool negada' };
        },
        auditAutoApproval: (record: OmpAutoApprovalRecord) => {
          auditSuccess(
            { scope: input.scope, missionId: input.missionId },
            gateSessionId,
            'omp_ui_auto_approval',
            {
              requestId: record.requestId,
              method: record.method,
              title: record.title,
              decision: record.decision,
              ...(record.detail ? { detail: record.detail } : {}),
              policy: 'yolo',
            },
            0,
            false,
            'omp-rpc-stdio',
          );
        },
        onPush: (event) => {
          const hosted = hostedRef.current;
          if (hosted) pushEvent(hosted, event);
          switch (event.kind) {
            case 'text-delta':
            case 'thinking-delta':
              emitRpcPaneData(stream, sessionId, event.delta);
              break;
            case 'tool':
              emitRpcPaneData(
                stream,
                sessionId,
                rpcPaneMarkerLine(
                  `⚙ ${event.name} · ${event.status} — ${event.argsPreview}`,
                ),
              );
              break;
            case 'notice':
              emitRpcPaneData(
                stream,
                sessionId,
                rpcPaneMarkerLine(`[${event.level}] ${event.message}`),
              );
              break;
            case 'status':
              publishSessionActivityState(
                sessionId,
                event.state === 'busy' ? 'busy' : 'idle',
              );
              break;
            case 'exit':
              publishSessionActivityState(sessionId, 'idle');
              emitRpcPaneExit(stream, sessionId, event.code);
              stream.disposed = true;
              disposeSession(sessionId);
              break;
            default:
              break;
          }
        },
      },
    );
  } catch (err) {
    releaseSession(gateSessionId);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const hosted: HostedSession = {
    session,
    gateCtx,
    gateSessionId,
    owner: input.owner,
    scope: input.scope,
    paneId,
    kind: input.missionId ? 'mission' : 'panel',
    title: input.title ?? input.agentName ?? 'Oh My Pi · RPC',
    launchCredentialEnv: preflight.keyEnv,
    launchCredentialScope: preflight.credentialScope,
  };
  hostedRef.current = hosted;
  sessions.set(sessionId, hosted);
  spawnFence.materialized = true;
  paneStreams.set(sessionId, stream);
  // Registration is atomic with child construction; shutdown can now own the
  // physical termination without a process escaping between inventories.
  releaseOmpSpawnFence(spawnFence);
  if (session.state === 'exited') {
    const terminated = await terminateHostedSession(sessionId, hosted);
    return {
      ok: false,
      error: terminated
        ? 'processo omp encerrou durante o spawn'
        : 'processo omp encerrou durante o spawn sem prova física completa; substituição bloqueada',
    };
  }

  try {
    await waitForOmpSessionReady(session);
    publishSessionActivityState(sessionId, 'idle');
    if (input.prompt) {
      await session.prompt(input.prompt);
    }
  } catch (err) {
    stream.disposed = true;
    await terminateHostedSession(sessionId, hosted);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, sessionId };
}

/** True when sessionId belongs to a live RPC grid pane. */
export function isOmpRpcPaneSession(sessionId: string): boolean {
  return paneStreams.has(sessionId);
}

/** Includes headless mission workers, which intentionally have no paneStream. */
export function isOmpRpcSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/**
 * Panel-scope ownership check: only the owning renderer may drive, kill or
 * replay a grid RPC pane (mirrors the PTY per-WebContents session binding).
 */
export function isOmpRpcPaneOwnedBy(
  sessionId: string,
  owner: WebContents,
): boolean {
  const stream = paneStreams.get(sessionId);
  return stream !== undefined && stream.owner === owner;
}

/**
 * Revoke renderer presentation ownership without terminating a main-controlled
 * mission worker. The stream stops emitting PTY-shaped data to that renderer;
 * protocol events remain observable only by windows in the mission scope.
 */
export function detachOmpRpcMissionPane(
  owner: WebContents,
  sessionId: string,
): boolean {
  const hosted = sessions.get(sessionId);
  const stream = paneStreams.get(sessionId);
  if (
    !hosted ||
    !stream ||
    hosted.kind !== 'mission' ||
    !hosted.gateCtx.missionId ||
    hosted.owner !== owner ||
    stream.owner !== owner
  ) {
    return false;
  }
  hosted.owner = null;
  stream.owner = null;
  return true;
}

/**
 * Grid ownership permits observation/replay. Raw renderer input and kill are
 * narrower: only an ordinary panel (never a mission worker) is mutable.
 */
export function canRendererControlOmpRpcPane(
  sessionId: string,
  owner: WebContents,
): boolean {
  const stream = paneStreams.get(sessionId);
  const hosted = sessions.get(sessionId);
  return Boolean(
    stream &&
    hosted &&
    stream.owner === owner &&
    hosted.owner === owner &&
    hosted.kind === 'panel' &&
    !hosted.gateCtx.missionId,
  );
}

/** Replay provider for the PTY recover channel (preload gap-pull). */
export function recoverOmpRpcPaneOutput(
  sessionId: string,
  afterSequence: number,
): Array<{ sessionId: string; sequence: number; data: string }> {
  const stream = paneStreams.get(sessionId);
  if (!stream) return [];
  return stream.replay
    .filter((entry) => entry.sequence > afterSequence)
    .map((entry) => ({ sessionId, ...entry }));
}

/**
 * Line-buffered terminal input → prompt. Keystrokes accumulate until Enter;
 * anything already streaming keeps flowing (prompts queue in the RPC layer).
 * Returns false when the session is unknown (caller falls back to PTY write).
 */
export function writeOmpRpcPaneInput(sessionId: string, data: string): boolean {
  const stream = paneStreams.get(sessionId);
  const hosted = sessions.get(sessionId);
  if (!stream || !hosted || stream.disposed) return false;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      const line = stream.inputBuffer.trim();
      stream.inputBuffer = '';
      if (line) {
        emitRpcPaneData(stream, sessionId, `\r\n`);
        void hosted.session
          .prompt(line)
          .catch((err) =>
            emitRpcPaneData(
              stream,
              sessionId,
              rpcPaneMarkerLine(
                `[erro] ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
          );
      }
    } else if (ch === '') {
      stream.inputBuffer = stream.inputBuffer.slice(0, -1);
    } else if (ch >= ' ') {
      stream.inputBuffer += ch;
    }
  }
  return true;
}

/** Ack from the preload — accepted for protocol parity (no throttling yet). */
export function acknowledgeOmpRpcPaneOutput(sessionId: string): boolean {
  return paneStreams.has(sessionId);
}

/** Kill a grid RPC pane: dispose the session and mark the terminal dead. */
export function killOmpRpcPane(sessionId: string): boolean {
  const stream = paneStreams.get(sessionId);
  if (!stream) return false;
  if (!stream.disposed) {
    stream.disposed = true;
    publishSessionActivityState(sessionId, 'idle');
    emitRpcPaneExit(stream, sessionId, 0);
  }
  disposeSession(sessionId);
  return true;
}

export interface TerminateOmpRpcSessionOptions {
  /** Backward-compatible SIGTERM grace budget. */
  readonly timeoutMs?: number;
  /** Deprecated polling knob retained for callers; no longer a proof source. */
  readonly pollMs?: number;
  readonly killTimeoutMs?: number;
  readonly snapshotTimeoutMs?: number;
}

/**
 * Main-owned authority teardown. Capability tokens are revoked immediately,
 * but success is returned only after the shared process inventory proves the
 * exact root callback and all captured/late descendants exited. A false proof
 * leaves the hosted record present/revoked, preventing replacement.
 */
export async function terminateOmpRpcSession(
  sessionId: string,
  options: TerminateOmpRpcSessionOptions = {},
): Promise<boolean> {
  const hosted = sessions.get(sessionId);
  if (!hosted) return true;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 10;
  const killTimeoutMs = options.killTimeoutMs;
  const snapshotTimeoutMs = options.snapshotTimeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 1_000 ||
    (killTimeoutMs !== undefined &&
      (!Number.isInteger(killTimeoutMs) ||
        killTimeoutMs < 0 ||
        killTimeoutMs > 30_000)) ||
    (snapshotTimeoutMs !== undefined &&
      (!Number.isInteger(snapshotTimeoutMs) ||
        snapshotTimeoutMs < 0 ||
        snapshotTimeoutMs > 30_000))
  ) {
    throw new Error('invalid OMP termination timeout');
  }
  return terminateHostedSession(sessionId, hosted, {
    timeoutMs,
    pollMs,
    ...(killTimeoutMs !== undefined ? { killTimeoutMs } : {}),
    ...(snapshotTimeoutMs !== undefined ? { snapshotTimeoutMs } : {}),
  });
}

/** Test-only: drop all pane streams (sessions go through disposeAll). */
export function __resetOmpRpcPaneStreamsForTests(): void {
  paneStreams.clear();
}

function toCommandResult(err: unknown): OmpRpcCommandResult {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

async function startSession(
  owner: WebContents,
  raw: unknown,
): Promise<OmpRpcStartResult> {
  let spawnFence: OmpSpawnFence;
  try {
    spawnFence = acquireOmpSpawnFence();
  } catch (err) {
    return toCommandResult(err);
  }
  try {
    return await startSessionWithFence(owner, raw, spawnFence);
  } finally {
    releaseOmpSpawnFence(spawnFence);
  }
}

async function startSessionWithFence(
  owner: WebContents,
  raw: unknown,
  spawnFence: OmpSpawnFence,
): Promise<OmpRpcStartResult> {
  const parsed = ompRpcStartRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'payload inválido' };
  try {
    assertLiveRendererOwner(owner);
  } catch (err) {
    return toCommandResult(err);
  }
  const scope = requireRendererWorkspaceScope(owner);
  if (sessionsForOwner(owner) >= MAX_SESSIONS_PER_RENDERER) {
    return { ok: false, error: 'limite de sessões omp atingido' };
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = resolveWorkspaceRoot(scope, parsed.data.workspaceRoot);
  } catch (err) {
    return toCommandResult(err);
  }

  // Exact provider/model auth and version pin before gate token/process spawn.
  let preflight: Awaited<ReturnType<typeof preflightOmpRpcSpawn>>;
  try {
    const requestedModel = parsed.data.model
      ? `${parsed.data.model.provider}/${parsed.data.model.modelId}`
      : undefined;
    preflight = await preflightOmpRpcSpawn(requestedModel);
    assertOmpSpawnFence(spawnFence);
    assertLiveRendererOwner(owner);
  } catch (err) {
    return toCommandResult(err);
  }

  const sessionId = randomUUID();
  const gateSessionId = sessionId;
  const gateCtx = mintToken({
    label: 'omp-rpc',
    role: 'worker',
    providerId: 'omp',
    scope,
    allowedTools: [...OMP_PANEL_HOST_TOOL_NAMES],
    allowedSkills: [],
  });
  try {
    bindTokenToSession(gateCtx.token, gateSessionId);
  } catch (err) {
    releaseSessionByToken(gateCtx.token);
    return toCommandResult(err);
  }

  const hostedRef: { current: HostedSession | null } = { current: null };
  let session: OmpRpcSession;
  try {
    session = new OmpRpcSession(
      {
        sessionId,
        workspaceRoot,
        approvalPolicy: 'safe',
        binPath: preflight.binPath,
        model: preflight.model,
        env: {
          ...buildOmpChildEnv(),
          ...preflight.keyEnv,
        },
        credentialSecrets: Object.values(preflight.keyEnv),
      },
      {
        hostTools: buildOmpHostToolDefinitions(
          hostRegistry(),
          OMP_PANEL_HOST_TOOL_NAMES,
        ),
        dispatchHostTool: async (toolName, args, physicalCall) => {
          // Gate real: o dispatcher aplica allowlist, intent-gate e auditoria
          // com o contexto mintado desta sessão — nunca bypassa.
          const outcome = await runInsideOmpRpcHostCall(
            physicalCall,
            gateCtx,
            toolName,
            () =>
              dispatchToolCall(
                'omp-rpc-stdio',
                hostRegistry(),
                toolName,
                args,
                gateCtx,
              ),
          );
          return outcome.ok
            ? { ok: true, result: outcome.result }
            : { ok: false, error: outcome.error ?? 'tool negada' };
        },
        auditAutoApproval: (record: OmpAutoApprovalRecord) => {
          // Defensive callback required by the service contract. A safe
          // session does not auto-approve; if that invariant ever changes,
          // retain an append-only trace rather than approving invisibly.
          auditSuccess(
            { scope },
            gateSessionId,
            'omp_ui_auto_approval',
            {
              requestId: record.requestId,
              method: record.method,
              title: record.title,
              decision: record.decision,
              ...(record.detail ? { detail: record.detail } : {}),
              policy: 'safe',
            },
            0,
            false,
            'omp-rpc-stdio',
          );
        },
        onPush: (event) => {
          const hosted = hostedRef.current;
          if (hosted) pushEvent(hosted, event);
          if (event.kind === 'exit') disposeSession(sessionId);
        },
      },
    );
  } catch (err) {
    releaseSession(gateSessionId);
    return toCommandResult(err);
  }

  const hosted: HostedSession = {
    session,
    gateCtx,
    gateSessionId,
    owner,
    scope,
    paneId: `omp-rpc:${sessionId}`,
    kind: 'panel',
    title: 'OMP · RPC',
    launchCredentialEnv: preflight.keyEnv,
    launchCredentialScope: preflight.credentialScope,
  };
  hostedRef.current = hosted;
  sessions.set(sessionId, hosted);
  spawnFence.materialized = true;
  releaseOmpSpawnFence(spawnFence);
  if (session.state === 'exited') {
    const terminated = await terminateHostedSession(sessionId, hosted);
    return {
      ok: false,
      error: terminated
        ? 'processo omp encerrou durante o spawn'
        : 'processo omp encerrou durante o spawn sem prova física completa; substituição bloqueada',
    };
  }
  watchOwner(owner);
  return { ok: true, sessionId };
}

export function registerOmpRpcIpc(): void {
  ipcMain.handle(
    OMP_RPC_CHANNELS.start,
    (event, raw): Promise<OmpRpcStartResult> => startSession(event.sender, raw),
  );

  ipcMain.handle(OMP_RPC_CHANNELS.listSessions, (event): OmpSessionSummary[] =>
    listOmpRpcSessions(event.sender),
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.prompt,
    async (event, raw): Promise<OmpRpcCommandResult> => {
      try {
        const parsed = ompRpcPromptRequestSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, error: 'payload inválido' };
        const hosted = requireRendererMutableSession(event.sender, {
          sessionId: parsed.data.sessionId,
        });
        await hosted.session.prompt(parsed.data.message, parsed.data.behavior);
        return { ok: true };
      } catch (err) {
        return toCommandResult(err);
      }
    },
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.abort,
    async (event, raw): Promise<OmpRpcCommandResult> => {
      try {
        const hosted = requireRendererMutableSession(event.sender, raw);
        await hosted.session.abort();
        return { ok: true };
      } catch (err) {
        return toCommandResult(err);
      }
    },
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.setModel,
    async (event, raw): Promise<OmpRpcCommandResult> => {
      try {
        const parsed = ompRpcSetModelRequestSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, error: 'payload inválido' };
        const hosted = requireRendererMutableSession(event.sender, {
          sessionId: parsed.data.sessionId,
        });
        const preflight = await preflightOmpRpcSpawn(
          `${parsed.data.provider}/${parsed.data.modelId}`,
        );
        if (
          !sameCredentialScope(
            hosted.launchCredentialScope,
            preflight.credentialScope,
          ) ||
          !sameCredentialEnv(
            hosted.launchCredentialEnv,
            preflight.keyEnv,
          )
        ) {
          throw new Error(
            'o novo modelo exige outro escopo de credencial; reinicie a sessão OMP',
          );
        }
        await hosted.session.setModel(
          preflight.model.provider,
          preflight.model.modelId,
        );
        return { ok: true };
      } catch (err) {
        return toCommandResult(err);
      }
    },
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.getState,
    (event, raw): OmpRpcGetStateResult => {
      try {
        const hosted = requireObservableSession(event.sender, raw);
        return { ok: true, snapshot: hosted.session.snapshot() };
      } catch (err) {
        return { ok: false, error: toCommandResult(err).error };
      }
    },
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.listModels,
    async (event, raw): Promise<OmpRpcListModelsResult> => {
      try {
        const hosted = requireObservableSession(event.sender, raw);
        return { ok: true, models: await hosted.session.listModels() };
      } catch (err) {
        return { ok: false, models: [], error: toCommandResult(err).error };
      }
    },
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.respondUi,
    (event, raw): OmpRpcCommandResult => {
      try {
        const parsed = ompRpcRespondUiRequestSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, error: 'payload inválido' };
        const hosted = requireRendererMutableSession(event.sender, {
          sessionId: parsed.data.sessionId,
        });
        if (!isRendererUiRejection(parsed.data.response)) {
          return {
            ok: false,
            error:
              'aprovação positiva OMP exige uma boundary main-owned; o painel só pode negar ou cancelar',
          };
        }
        const accepted = hosted.session.respondUi(
          parsed.data.requestId,
          parsed.data.response,
        );
        return accepted
          ? { ok: true }
          : { ok: false, error: 'pedido de aprovação não está pendente' };
      } catch (err) {
        return toCommandResult(err);
      }
    },
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.dispose,
    async (event, raw): Promise<OmpRpcCommandResult> => {
      try {
        const hosted = requireRendererMutableSession(event.sender, raw);
        const terminated = await terminateHostedSession(
          hosted.session.sessionId,
          hosted,
        );
        return terminated
          ? { ok: true }
          : {
              ok: false,
              error:
                'o encerramento físico do processo OMP e seus descendentes não foi comprovado',
            };
      } catch (err) {
        return toCommandResult(err);
      }
    },
  );
}

export interface OmpRpcShutdownResult {
  readonly ok: boolean;
  readonly attemptedSessionIds: readonly string[];
  readonly terminatedSessionIds: readonly string[];
  readonly failedSessionIds: readonly string[];
}

/**
 * Synchronously closes OMP admission and revokes every preflight fence. The
 * pending operations remain inventoried until disposeAllOmpRpcSessions awaits
 * their settlement, so no child can materialize after a close snapshot.
 */
export function sealOmpRpcAdmissionForShutdown(): void {
  if (!ompShutdownRequested) {
    ompShutdownRequested = true;
    ompLifecycleEpoch += 1;
  }
  for (const spawnFence of inFlightSpawns) spawnFence.revoked = true;
}

/**
 * App shutdown fence. It coalesces concurrent quit attempts and never clears a
 * hosted identity until root + descendants are physically proven gone.
 */
export function disposeAllOmpRpcSessions(): Promise<OmpRpcShutdownResult> {
  if (disposeAllFlight) return disposeAllFlight;
  // Close the admission gate synchronously. Existing asynchronous provider
  // discovery cannot cross this epoch and create a child after inventory.
  sealOmpRpcAdmissionForShutdown();
  const pendingSpawns = [...inFlightSpawns];
  const operation = (async (): Promise<OmpRpcShutdownResult> => {
    await Promise.all(pendingSpawns.map((spawnFence) => spawnFence.settled));
    const attemptedSessionIds = [...sessions.keys()];
    const outcomes = await Promise.all(
      attemptedSessionIds.map(async (sessionId) => {
        const hosted = sessions.get(sessionId);
        return {
          sessionId,
          terminated: hosted
            ? await terminateHostedSession(sessionId, hosted)
            : true,
        };
      }),
    );
    const terminatedSessionIds = outcomes
      .filter((outcome) => outcome.terminated)
      .map((outcome) => outcome.sessionId);
    const failedSessionIds = outcomes
      .filter((outcome) => !outcome.terminated)
      .map((outcome) => outcome.sessionId);
    return Object.freeze({
      ok: failedSessionIds.length === 0,
      attemptedSessionIds: Object.freeze([...attemptedSessionIds]),
      terminatedSessionIds: Object.freeze(terminatedSessionIds),
      failedSessionIds: Object.freeze(failedSessionIds),
    });
  })();
  disposeAllFlight = operation;
  const clearShutdownGate = (): void => {
    if (disposeAllFlight !== operation) return;
    disposeAllFlight = null;
  };
  void operation.then(clearShutdownGate, clearShutdownGate);
  return operation;
}

/**
 * Test-only isolation hook. Production shutdown admission is intentionally
 * sticky: once the app inventories OMP children, no later IPC may create one
 * while the remainder of main shutdown is still running.
 */
export function __resetOmpRpcLifecycleForTests(): void {
  if (
    disposeAllFlight ||
    inFlightSpawns.size > 0 ||
    sessions.size > 0
  ) {
    throw new Error('cannot reset OMP lifecycle with active physical authority');
  }
  ompLifecycleEpoch += 1;
  ompShutdownRequested = false;
}
