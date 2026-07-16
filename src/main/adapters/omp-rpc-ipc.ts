import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  OMP_RPC_CHANNELS,
  ompRpcPromptRequestSchema,
  ompRpcRespondUiRequestSchema,
  ompRpcSessionRefSchema,
  ompRpcSetModelRequestSchema,
  ompRpcStartRequestSchema,
  type OmpHostToolDefinition,
  type OmpRpcCommandResult,
  type OmpRpcEventEnvelope,
  type OmpRpcGetStateResult,
  type OmpRpcListModelsResult,
  type OmpRpcPushEvent,
  type OmpRpcStartResult,
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
import { buildToolset } from '../orch/tools';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { getAdapter } from './adapter-registry';
import {
  OmpRpcSession,
  resolveOmpBin,
  type OmpAutoApprovalRecord,
} from './omp-rpc-service';

/**
 * IPC do domínio ompRpc: hospeda sessões `omp --mode rpc-ui` como agentes de
 * primeira classe (sem PTY). Cada sessão ganha um token de gate REAL
 * (mintToken) restrito às 3 host tools; host_tool_call passa pelo dispatcher
 * MCP existente — mesmo enforcement de allowlist + auditoria dos panes.
 */

const HOST_TOOL_NAMES = [
  'nexus_pane_list',
  'nexus_mission_get',
  'nexus_handoff_submit',
] as const;

const MAX_SESSIONS_PER_RENDERER = 4;

interface HostedSession {
  session: OmpRpcSession;
  gateCtx: AgentGateContext;
  gateSessionId: string;
  owner: WebContents;
  scope: ProjectExecutionScope;
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

/** Deriva as definições de host tool dos registros MCP existentes. */
export function buildOmpHostToolDefinitions(
  source: McpRegistry = hostRegistry(),
): OmpHostToolDefinition[] {
  const byName = new Map(source.tools.map((tool) => [tool.name, tool]));
  const defs: OmpHostToolDefinition[] = [];
  for (const name of HOST_TOOL_NAMES) {
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
      if (hosted.owner === owner) disposeSession(sessionId);
    }
  };
  ownerCleanup.set(owner, onDestroyed);
  owner.once('destroyed', onDestroyed);
}

function pushToOwner(hosted: HostedSession, event: OmpRpcPushEvent): void {
  if (hosted.owner.isDestroyed()) return;
  const envelope: OmpRpcEventEnvelope = {
    sessionId: hosted.session.sessionId,
    event,
  };
  hosted.owner.send(OMP_RPC_CHANNELS.event, envelope);
}

function requireSession(
  owner: WebContents,
  raw: unknown,
): HostedSession {
  const parsed = ompRpcSessionRefSchema.safeParse(raw);
  if (!parsed.success) throw new Error('payload inválido');
  const hosted = sessions.get(parsed.data.sessionId);
  if (!hosted || hosted.owner !== owner) {
    throw new Error('sessão omp desconhecida para este renderer');
  }
  return hosted;
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
          if (hosted) pushToOwner(hosted, event);
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
