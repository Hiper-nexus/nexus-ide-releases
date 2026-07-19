import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { WebContents } from 'electron';
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
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import { buildToolset } from '../orch/tools';
import {
  getRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { getAdapter } from './adapter-registry';
import {
  OmpRpcSession,
  resolveOmpBin,
  waitForOmpSessionReady,
  type OmpAutoApprovalRecord,
} from './omp-rpc-service';

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
}

const sessions = new Map<string, HostedSession>();
const ownerCleanup = new Map<WebContents, () => void>();

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
  const allow =
    allowedToolNames == null
      ? null
      : new Set(allowedToolNames);
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

function ompBinName(): string {
  const adapter = getAdapter('omp');
  return adapter && adapter.kind === 'cli-pty' ? adapter.bin : 'omp';
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

function disposeSession(sessionId: string): boolean {
  const hosted = sessions.get(sessionId);
  if (!hosted) return false;
  sessions.delete(sessionId);
  try {
    hosted.session.dispose();
  } finally {
    releaseSession(hosted.gateSessionId);
  }
  return true;
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

function requireSession(
  owner: WebContents,
  raw: unknown,
): HostedSession {
  const parsed = ompRpcSessionRefSchema.safeParse(raw);
  if (!parsed.success) throw new Error('payload inválido');
  const hosted = sessions.get(parsed.data.sessionId);
  // Panel sessions are owner-scoped; mission workers are shared (any renderer).
  if (
    !hosted ||
    (hosted.kind === 'panel' && hosted.owner !== owner)
  ) {
    throw new Error('sessão omp desconhecida para este renderer');
  }
  return hosted;
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

/** Live omp rpc-ui sessions for fleet / ops surfaces. */
export function listOmpRpcSessions(): OmpSessionSummary[] {
  return [...sessions.values()].map((hosted) => ({
    sessionId: hosted.session.sessionId,
    paneId: hosted.paneId,
    kind: hosted.kind,
    title: hosted.title,
    missionId: hosted.gateCtx.missionId,
    state: hosted.session.state,
    snapshot: hosted.session.snapshot(),
  }));
}

/**
 * Fail-loud parse: a non-empty malformed ref must never fall through to the
 * omp default silently (same "phantom model" class the PTY path fights via
 * resolveRoutableModel). `undefined`/empty = not specified → the omp default
 * is a legitimate choice and stays `undefined`.
 */
function parseOmpModelRef(
  model: string | undefined,
): { provider: string; modelId: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `modelo omp malformado: "${model}" (formato esperado: provider/modelId)`,
    );
  }
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
}

export interface MissionOmpWorkerInput {
  scope: ProjectExecutionScope;
  workspaceRoot: string;
  missionId?: string;
  model?: string;
  title?: string;
  agentName?: string;
  prompt?: string;
  approvalPolicy?: OmpApprovalPolicy;
  allowedTools?: string[] | null;
}

/**
 * Spawn omp --mode rpc-ui as a mission worker (no PTY). Used when
 * orch.ompMissionTransport is `rpc` or `auto`.
 */
export async function spawnMissionOmpRpcWorker(
  input: MissionOmpWorkerInput,
): Promise<{ paneId: string; sessionId: string }> {
  // Validate before minting any gate token: a malformed model ref throws
  // here, so the spawn fails loud with a clear message and leaks nothing.
  const model = parseOmpModelRef(input.model);
  if (sessions.size >= MAX_SESSIONS_PER_RENDERER * 2) {
    throw new Error('limite global de sessões omp atingido');
  }
  const binPath = (await resolveOmpBin(ompBinName())).binPath;
  const sessionId = randomUUID();
  const paneId = `omp-rpc:${sessionId}`;
  const gateSessionId = `omp-rpc:${sessionId}`;
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
    scope: input.scope,
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
    // Mission workers run unattended: yolo + audited auto-approve. `safe` would
    // hang on extension_ui_request because the panel only mirrors one session.
    session = new OmpRpcSession(
      {
        sessionId,
        workspaceRoot: input.workspaceRoot,
        approvalPolicy: input.approvalPolicy ?? 'yolo',
        binPath,
        model,
      },
      {
        hostTools: buildOmpHostToolDefinitions(hostRegistry(), allowedTools),
        dispatchHostTool: async (toolName, args) => {
          const outcome = await dispatchToolCall(
            'http-mcp',
            hostRegistry(),
            toolName,
            args,
            gateCtx,
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
            'http-mcp',
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
    throw err;
  }

  if (session.state === 'exited') {
    releaseSession(gateSessionId);
    throw new Error('processo omp encerrou durante o spawn');
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
  };
  hostedRef.current = hosted;
  sessions.set(sessionId, hosted);

  await waitForOmpSessionReady(session);
  if (input.prompt) {
    await session.prompt(input.prompt);
  }
  return { paneId, sessionId };
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
  const parsed = ompRpcStartRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'payload inválido' };
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

  // Pin de versão: valida `omp --version` antes de qualquer spawn.
  let binPath: string;
  try {
    binPath = (await resolveOmpBin(ompBinName())).binPath;
  } catch (err) {
    return toCommandResult(err);
  }

  const sessionId = randomUUID();
  const gateSessionId = `omp-rpc:${sessionId}`;
  const gateCtx = mintToken({
    label: 'omp-rpc',
    role: 'worker',
    providerId: 'omp',
    missionId: parsed.data.missionId,
    scope,
    allowedTools: [...HOST_TOOL_NAMES],
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
        approvalPolicy: parsed.data.approvalPolicy,
        binPath,
        model: parsed.data.model,
      },
      {
        hostTools: buildOmpHostToolDefinitions(),
        dispatchHostTool: async (toolName, args) => {
          // Gate real: o dispatcher aplica allowlist, intent-gate e auditoria
          // com o contexto mintado desta sessão — nunca bypassa.
          const outcome = await dispatchToolCall(
            'http-mcp',
            hostRegistry(),
            toolName,
            args,
            gateCtx,
          );
          return outcome.ok
            ? { ok: true, result: outcome.result }
            : { ok: false, error: outcome.error ?? 'tool negada' };
        },
        auditAutoApproval: (record: OmpAutoApprovalRecord) => {
          // Trilha de auditoria do orch (jarvis/audit-log em SQLite por
          // projeto): cada auto-resposta yolo vira um evento append-only.
          auditSuccess(
            { scope, missionId: parsed.data.missionId },
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
            'http-mcp',
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

  if (session.state === 'exited') {
    // Spawn falhou de forma síncrona (erro emitido antes do registro).
    releaseSession(gateSessionId);
    return { ok: false, error: 'processo omp encerrou durante o spawn' };
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
  };
  hostedRef.current = hosted;
  sessions.set(sessionId, hosted);
  watchOwner(owner);
  return { ok: true, sessionId };
}

export function registerOmpRpcIpc(): void {
  ipcMain.handle(
    OMP_RPC_CHANNELS.start,
    (event, raw): Promise<OmpRpcStartResult> => startSession(event.sender, raw),
  );

  ipcMain.handle(OMP_RPC_CHANNELS.listSessions, (): OmpSessionSummary[] =>
    listOmpRpcSessions(),
  );

  ipcMain.handle(
    OMP_RPC_CHANNELS.prompt,
    async (event, raw): Promise<OmpRpcCommandResult> => {
      try {
        const parsed = ompRpcPromptRequestSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, error: 'payload inválido' };
        const hosted = requireSession(event.sender, {
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
        const hosted = requireSession(event.sender, raw);
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
        const hosted = requireSession(event.sender, {
          sessionId: parsed.data.sessionId,
        });
        await hosted.session.setModel(parsed.data.provider, parsed.data.modelId);
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
        const hosted = requireSession(event.sender, raw);
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
        const hosted = requireSession(event.sender, raw);
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
        const hosted = requireSession(event.sender, {
          sessionId: parsed.data.sessionId,
        });
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
    (event, raw): OmpRpcCommandResult => {
      try {
        const hosted = requireSession(event.sender, raw);
        disposeSession(hosted.session.sessionId);
        return { ok: true };
      } catch (err) {
        return toCommandResult(err);
      }
    },
  );
}

/** Encerramento do app: mata todas as sessões hospedadas. */
export function disposeAllOmpRpcSessions(): void {
  for (const sessionId of [...sessions.keys()]) disposeSession(sessionId);
}
