import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { PTY_CHANNELS } from "../../shared/channels";
import {
  spawnRequestSchema,
  writeSchema,
  resizeSchema,
  killSchema,
  ptyAcknowledgeSchema,
  ptyRecoverSchema,
} from "../../shared/ipc";
import type { SpawnResult } from "../../shared/types";
import {
  spawnSession,
  spawnAgentSession,
  adoptMainOwnedAgentSession,
  getSessionState,
  listAgentSessionsForPane,
  writeSession,
  resizeSession,
  killSession,
  orchTerminateSession,
  acknowledgeSessionOutput,
  recoverSessionOutput,
  setPtyHost,
  startSessionMortalityReconciler,
} from "./pty-manager";
import { createRealPtyHost } from "./pty-host-client";
import {
  getAdapter,
  getAdapterResolvedBin,
  isAdapterInstalled,
  resolveAdapterBinary,
} from "../adapters/adapter-registry";
import { revalidateExecutable } from "../path-resolver";
import type { CliPtyAdapter } from "../../shared/adapter-types";
import {
  prepareProviderSpawn,
  prepareProviderSpawnAuthoritative,
  type ProviderSpawnPreparation,
} from "../persistence/provider-config-store";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import { trackManagedSession } from "../adapters/managed-credentials";
import { isFileAuthAdapter } from "../adapters/managed-credentials";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { attachSessionScope } from "../orch/pane-registry";
import {
  assertMainOwnedAgentSpawnGrantActive,
  authorizeMainOwnedAgentSpawn,
  resolveMainOwnedAgentSpawn,
  settleSpawnedMainOwnedAgentSession,
  type ResolvedMainOwnedAgentSpawn,
} from "../orch/main-owned-agent-spawn";
import {
  requiresReadOnlyNativeAuthority,
  supportsEnforceableReadOnlyNativeAuthority,
} from "./autonomous-cli-policy";
import { resolveCwdForScope } from "../orch/workspace-path";
import {
  requiresSpawnGate,
  shouldUseEphemeralHome,
} from "../orch/spawn-home-policy";
import {
  getOrchSettings,
  getTerminalSettings,
} from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import {
  listAvailableShells,
  resolveConfiguredShell,
} from "../persistence/shell-catalog";
import { getCommandBlockTracker } from "../terminal/command-block-tracker";
import { registerCommandBlockScope } from "../terminal/command-block-scope-registry";
import { getProjectDomainStores } from "../orch/project-domain-store-registry";
import {
  type TaskDispatchRecord,
  type TaskDispatchStore,
} from "../orch/task-dispatch-store";
import { selectPersistedWorkerRestartDispatch } from "./persisted-worker-restart";

let projectRuntimeManager: ProjectRuntimeManager | null = null;
const RESTARTED_WORKER_LEASE_MS = 10 * 60_000;

interface PersistedWorkerRestart {
  readonly dispatch: TaskDispatchRecord;
  readonly store: TaskDispatchStore;
}

export function configurePtyProjectRuntimeManager(
  runtimeManager: ProjectRuntimeManager,
): void {
  projectRuntimeManager = runtimeManager;
}

function assertNoLivePhysicalPaneProcess(
  spawn: ResolvedMainOwnedAgentSpawn,
): void {
  const paneId = spawn.persistedPane?.paneId;
  if (
    paneId &&
    listAgentSessionsForPane(paneId).length > 0
  ) {
    throw new Error(
      "live physical mission process still owns this pane; " +
        "replacement is denied until main observes its exact exit",
    );
  }
}

function resolvePersistedWorkerRestart(
  spawn: ResolvedMainOwnedAgentSpawn,
): PersistedWorkerRestart | null {
  const pane = spawn.persistedPane;
  if (pane?.role !== "worker") return null;
  const paneId = pane.paneId ?? spawn.request.paneId;
  const scope = spawn.authority.coordinationScope ?? pane.scope;
  if (!paneId || !scope) return null;
  const store = getProjectDomainStores(scope).taskDispatches;
  const dispatch = selectPersistedWorkerRestartDispatch({
    paneId,
    workerIncarnationId: pane.workerIncarnationId,
    dispatches: store.list(pane.missionId),
  });
  if (!dispatch?.sessionId || !dispatch.workerIncarnationId) {
    // Pane gravado, sem dispatch exato: o worker ainda abre. Recusar aqui
    // era o "missing pane/incarnation restart authority" que matava a
    // equipe no Reabrir panes após restart.
    return null;
  }
  if (getSessionState(dispatch.sessionId) !== null) {
    throw new Error(
      "o processo exato do dispatch ainda está ativo; replacement negado",
    );
  }
  return { dispatch, store };
}

async function terminateRejectedWorkerRestart(
  sessionId: string,
  error: unknown,
): Promise<SpawnResult> {
  const detail =
    error instanceof Error ? error.message : "worker rebind failed";
  try {
    const exited = await orchTerminateSession(sessionId);
    return {
      ok: false,
      error: exited
        ? `worker restart could not bind its exact dispatch: ${detail}`
        : `worker restart could not bind its exact dispatch: ${detail}; ` +
          "physical exit was not proven",
    };
  } catch {
    return {
      ok: false,
      error:
        `worker restart could not bind its exact dispatch: ${detail}; ` +
        "physical exit was not proven",
    };
  }
}

function bindCommandTracking(
  sessionId: string,
  paneId: string,
  adapterId: string,
  spawn: ResolvedMainOwnedAgentSpawn,
): void {
  registerCommandBlockScope(sessionId, spawn.authority.scope);
  getCommandBlockTracker()?.bindSession(sessionId, {
    paneId,
    workspaceId: spawn.authority.scope.checkoutId,
    shell: adapterId,
    cwd: spawn.authority.cwd,
    projectRoot: spawn.authority.scope.rootRealPath,
    missionId: spawn.authority.context?.missionId,
  });
}

function spawnCliPtyAgentPane(
  sender: WebContents,
  adapter: CliPtyAdapter,
  spawn: ResolvedMainOwnedAgentSpawn,
  authoritativePreparation?: ProviderSpawnPreparation,
): SpawnResult | Promise<SpawnResult> {
  try {
    const {
      request,
      authority,
      pending,
      recovery,
      persistedPane,
    } = spawn;
    const operatorChoice = isOperatorChoicePolicy(
      getOrchSettings().squadCliPolicy,
    );
    const nativeReadOnly =
      !operatorChoice &&
      requiresReadOnlyNativeAuthority({
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
      nativeReadOnly &&
      !supportsEnforceableReadOnlyNativeAuthority(adapter)
    ) {
      throw new Error(
        `adapter ${adapter.id} cannot enforce native read-only authority`,
      );
    }
    const perSpawn = {
      effort: request.effort,
      accountId: request.accountId,
      model: request.model,
      // Mesmo predicado que o spawn hook usa para trocar o HOME — a credencial
      // do Claude depende dele (HOME efêmero não alcança a linhagem nativa).
      isolatedHome: shouldUseEphemeralHome(
        adapter,
        requiresSpawnGate(authority.context),
        {
          mode:
            adapter.quirks.mcpAutoload && operatorChoice
              ? "operator-choice"
              : "hardened",
        },
      ),
    };
    if (adapter.id === "agy" && authoritativePreparation === undefined) {
      return prepareProviderSpawnAuthoritative(adapter.id, perSpawn).then(
        (preparation) =>
          spawnCliPtyAgentPane(sender, adapter, spawn, preparation),
        (error) => ({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "failed to verify provider authentication",
        }),
      );
    }
    const preparation =
      authoritativePreparation ?? prepareProviderSpawn(adapter.id, perSpawn);
    if (!preparation.ok) {
      throw new Error(preparation.error);
    }
    // Revalidate immediately before spawn: discovery cache can go stale after
    // uninstall/move, and Finder launches must never re-search a bare name.
    // Do not mutate preparation.overrides — build a fresh overrides object.
    let spawnBin =
      preparation.overrides.binPath &&
      revalidateExecutable(preparation.overrides.binPath)
        ? preparation.overrides.binPath
        : null;
    if (!spawnBin) {
      // Prefer a still-valid cached path; otherwise live-resolve (updates cache).
      // Stale cache alone must not block a successful live PATH walk (CodeRabbit).
      const cached = getAdapterResolvedBin(adapter.id);
      if (cached && revalidateExecutable(cached)) {
        spawnBin = cached;
      } else {
        spawnBin = resolveAdapterBinary(adapter.id);
        if (spawnBin && !revalidateExecutable(spawnBin)) {
          spawnBin = null;
        }
      }
    }
    if (!spawnBin) {
      // After live resolve, cache reflects truth — pick the accurate message.
      if (!isAdapterInstalled(adapter.id)) {
        throw new Error(
          `${adapter.label} not found on PATH. Install: ${adapter.install.command}`,
        );
      }
      throw new Error(
        `${adapter.label} is installed but Nexus could not resolve an absolute ` +
          `executable path for "${adapter.bin}". Open Settings → Providers → ` +
          `Reexaminar CLIs, or set an absolute binary path. Common locations: ` +
          `~/.kimi-code/bin, ~/.local/bin, /opt/homebrew/bin, npm global bin.`,
      );
    }
    const overrides = {
      ...preparation.overrides,
      binPath: spawnBin,
    };
    const authorizedRequest = { ...request, cwd: authority.cwd };
    const adopted =
      persistedPane && request.paneId
        ? adoptMainOwnedAgentSession(sender, {
            paneId: request.paneId,
            adapterId: adapter.id,
            missionId: persistedPane.missionId,
            role: persistedPane.role,
            workerIncarnationId: persistedPane.workerIncarnationId,
            model: request.model,
            accountId: request.accountId,
            effort: request.effort,
            cwd: authority.cwd,
            agentName: persistedPane.agentName,
            readOnly: persistedPane.readOnly === true,
            nativeReadOnly,
            allowedTools:
              persistedPane.allowedTools !== undefined
                ? persistedPane.allowedTools
                : persistedPane.role === "worker"
                  ? []
                  : null,
            allowedSkills: persistedPane.allowedSkills ?? null,
            authoritySeal: persistedPane.authoritySeal,
            scope: authority.scope,
          })
        : null;
    if (adopted) {
      const settlement = settleSpawnedMainOwnedAgentSession({
        backend: "PTY",
        owner: sender,
        requestId: request.orchRequestId,
        sessionId: adopted.sessionId,
        authority,
        pending,
        recovery,
        persistedPane,
        terminate: () => orchTerminateSession(adopted.sessionId),
      });
      if (settlement) return settlement;
      bindCommandTracking(
        adopted.sessionId,
        request.paneId!,
        adapter.id,
        spawn,
      );
      return {
        ok: true,
        sessionId: adopted.sessionId,
        adopted: true,
        state: adopted.state,
      };
    }

    assertNoLivePhysicalPaneProcess(spawn);
    const workerRestart = resolvePersistedWorkerRestart(spawn);
    assertMainOwnedAgentSpawnGrantActive({
      owner: sender,
      requestId: request.orchRequestId,
      pending,
      recovery,
    });
    const { sessionId, resumeMode } = spawnAgentSession(
      sender,
      authorizedRequest,
      adapter,
      overrides,
      authority,
    );
    if (workerRestart) {
      try {
        if (getSessionState(sessionId) === null) {
          throw new Error(
            "replacement PTY exited before durable worker rebind",
          );
        }
        workerRestart.store.rebindRestartedWorker({
          missionId: persistedPane!.missionId,
          paneId:
            persistedPane!.paneId ??
            request.paneId ??
            workerRestart.dispatch.paneId!,
          expectedSessionId: workerRestart.dispatch.sessionId!,
          replacementSessionId: sessionId,
          workerIncarnationId: workerRestart.dispatch.workerIncarnationId!,
          leaseMs: RESTARTED_WORKER_LEASE_MS,
        });
      } catch (error) {
        return terminateRejectedWorkerRestart(sessionId, error);
      }
    }
    if (request.accountId && isFileAuthAdapter(adapter.id)) {
      trackManagedSession(sessionId, adapter.id, request.accountId);
    }
    const settlement = settleSpawnedMainOwnedAgentSession({
      backend: "PTY",
      owner: sender,
      requestId: request.orchRequestId,
      sessionId,
      authority,
      pending,
      recovery,
      persistedPane,
      terminate: () => orchTerminateSession(sessionId),
    });
    if (settlement) return settlement;
    bindCommandTracking(
      sessionId,
      request.paneId ?? sessionId,
      adapter.id,
      spawn,
    );
    return {
      ok: true,
      sessionId,
      ...(request.resume && resumeMode ? { resumeMode } : {}),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to spawn agent";
    return { ok: false, error: message };
  }
}

/**
 * Registers the PTY IPC surface. Every handler validates its payload with zod
 * before touching the PTY manager. The `spawn` handler dispatches to either the
 * shell or agent path based on the request kind.
 */
export function registerPtyIpc(): void {
  // Route every PTY through the isolated utilityProcess host (node-pty never
  // loads in the main process — docs/ARCHITECTURE.md §B.2).
  setPtyHost(createRealPtyHost());
  // Exit perdido entre host e main não pode virar sessão imortal (pane
  // fantasma) — o reconciliador sintetiza a morte com prova do host.
  startSessionMortalityReconciler();

  // Sync for every legacy path; the renderer's invoke still receives a promise.
  ipcMain.handle(PTY_CHANNELS.spawn, (event, raw): SpawnResult | Promise<SpawnResult> => {
    const parsed = spawnRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // Mensagem acionável: o opaco "invalid spawn request" escondia qual
      // campo quebrou o contrato (ex.: model:'' de adapter sem catálogo).
      // Só path+motivo do 1º problema — nunca o payload.
      const first = parsed.error.issues[0];
      const where = first
        ? [...first.path.map(String), first.message].join(': ')
        : 'unknown';
      return { ok: false, error: `invalid spawn request (${where})` };
    }
    const req = parsed.data;

    if (req.kind === "cli-agent") {
      try {
        const envelope = authorizeMainOwnedAgentSpawn(
          event.sender,
          req,
          projectRuntimeManager,
        );
        const adapterId = envelope.request.adapterId;
        if (!adapterId) {
          return { ok: false, error: "cli-agent spawn requires adapterId" };
        }
        const adapter = getAdapter(adapterId);
        if (!adapter) {
          return { ok: false, error: `unknown adapter: ${adapterId}` };
        }
        const spawn = resolveMainOwnedAgentSpawn(
          event.sender,
          envelope,
          projectRuntimeManager,
        );
        if (adapter.kind !== "cli-pty") {
          return {
            ok: false,
            error: `adapter ${adapterId} is not a cli-pty adapter`,
          };
        }
        return spawnCliPtyAgentPane(event.sender, adapter, spawn);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "failed to spawn agent";
        return { ok: false, error: message };
      }
    }

    try {
      const scope = requireRendererWorkspaceScope(event.sender);
      const cwd = resolveCwdForScope(scope, req.cwd);
      const shell = resolveConfiguredShell(
        req.shell,
        getTerminalSettings().shell,
        listAvailableShells(),
      );
      const { sessionId } = spawnSession(
        event.sender,
        { ...req, cwd, shell },
        { scope, cwd, shell },
      );
      attachSessionScope(sessionId, scope);
      registerCommandBlockScope(sessionId, scope);
      getCommandBlockTracker()?.bindSession(sessionId, {
        paneId: req.paneId ?? sessionId,
        workspaceId: scope.checkoutId,
        shell,
        cwd,
        projectRoot: scope.rootRealPath,
      });
      return { ok: true, sessionId };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "failed to spawn shell";
      return { ok: false, error: message };
    }
  });

  ipcMain.on(PTY_CHANNELS.write, (event, raw) => {
    const parsed = writeSchema.safeParse(raw);
    if (parsed.success) {
      writeSession(event.sender, parsed.data.sessionId, parsed.data.data);
    }
  });

  ipcMain.handle(PTY_CHANNELS.writeConfirmed, (event, raw): boolean => {
    const parsed = writeSchema.safeParse(raw);
    if (!parsed.success) return false;
    return writeSession(event.sender, parsed.data.sessionId, parsed.data.data);
  });

  ipcMain.on(PTY_CHANNELS.resize, (event, raw) => {
    const parsed = resizeSchema.safeParse(raw);
    if (parsed.success) {
      resizeSession(
        event.sender,
        parsed.data.sessionId,
        parsed.data.cols,
        parsed.data.rows,
      );
    }
  });

  ipcMain.on(PTY_CHANNELS.kill, (event, raw) => {
    const parsed = killSchema.safeParse(raw);
    if (parsed.success) {
      killSession(event.sender, parsed.data.sessionId);
    }
  });

  ipcMain.on(PTY_CHANNELS.acknowledge, (event, raw) => {
    const parsed = ptyAcknowledgeSchema.safeParse(raw);
    if (parsed.success) {
      acknowledgeSessionOutput(
        event.sender,
        parsed.data.sessionId,
        parsed.data.sequence,
      );
    }
  });

  ipcMain.handle(PTY_CHANNELS.recover, (event, raw) => {
    const parsed = ptyRecoverSchema.safeParse(raw);
    if (!parsed.success) return [];
    return recoverSessionOutput(
      event.sender,
      parsed.data.sessionId,
      parsed.data.afterSequence,
    );
  });
}
