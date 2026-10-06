import { readOwnedPromptState, submitOwnedPromptEnter } from './pty-prompt-state';
import { licenseFailure } from '../../shared/license-errors';
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
import type { SpawnResult, ProjectExecutionScope } from "../../shared/types";
import { preparePaneSpaceWorktree } from './pane-space-worktree';
import {
  spawnSession,
  spawnAgentSession,
  adoptMainOwnedAgentSession,
  getSessionState,
  listAgentSessionsForPane,
  writeSession,
  resizeSession,
  killSession,
  liveClaudeMissionAccountIds,
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
  acquireCliSpawnPermit,
  prepareProviderSpawn,
  prepareProviderSpawnAuthoritative,
  type ProviderSpawnPreparation,
} from "../persistence/provider-config-store";
import { requireRendererWorkspaceScope, requireLiveRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import { trackManagedSession } from "../adapters/managed-credentials";
import { isFileAuthAdapter } from "../adapters/managed-credentials";
import { recordAccountChoiceReceipt } from "../persistence/account-choice-receipts";
import {
  resolveRotatingAuthFile,
  waitForRotatingAuthSpawnGate,
} from "../adapters/managed-auth-spawn-gate";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  attachSessionScope,
  reportPendingSpawnStartFailure,
} from "../orch/pane-registry";
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
import {
  WorkspaceRootMissingError,
  resolveCwdForScope,
} from "../orch/workspace-path";
import { probeCurrentWorkspaceLiveness } from "../persistence/workspace-store";
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
import { settleCodexCliVersionForSpawn } from "../orch/codex-cli-version";
import {
  type TaskDispatchRecord,
  type TaskDispatchStore,
} from "../orch/task-dispatch-store";
import { selectPersistedWorkerRestartDispatch } from "./persisted-worker-restart";
import { trace } from "../observability/main-trace";
import {
  startPhaseTimer,
  type PhaseTimer,
} from "../observability/phase-timer";

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
    const exited = await orchTerminateSession(sessionId, {
      origin: "rejected-worker-restart",
    });
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

// F-572: o gate de admissão de pane de agente mora em
// pty-manager.spawnAgentSession (ponto físico único, cobre também os spawns
// main-owned da Via Rápida); o conselheiro que NOMEIA os panes ociosos é
// registrado pelo pane guardian no boot. Nada disso é importado aqui de
// propósito: pty-ipc → guardian fechava um ciclo ESM na suíte.
// F-213: um evento `pane-spawn-timing` por tentativa de spawn válida —
// sucesso, falha de provider/auth/permissão/PTY ou erro interno. A recusa
// de schema acontece ANTES do timer nascer (pedido inválido não é spawn).
function reportPaneSpawnTiming(
  timer: PhaseTimer,
  request: {
    adapterId?: string;
    paneId?: string;
    missionId?: string;
    rendererWaitMs?: number;
  },
  spawn: ResolvedMainOwnedAgentSpawn | undefined,
  ok: boolean,
): void {
  const { totalMs, phases } = timer.finish();
  // F-213: rendererWaitMs é telemetria — nunca reprova nem explode o spawn:
  // não-finito é descartado; valor válido é arredondado e clampado no teto
  // que o próprio renderer aplica.
  const rendererWaitMs =
    typeof request.rendererWaitMs === "number" &&
    Number.isFinite(request.rendererWaitMs)
      ? Math.min(600_000, Math.max(0, Math.round(request.rendererWaitMs)))
      : null;
  trace({
    kind: "pane-spawn-timing",
    source: "renderer",
    adapterId: spawn?.request.adapterId ?? request.adapterId ?? null,
    paneId: spawn?.request.paneId ?? request.paneId ?? null,
    missionId:
      spawn?.authority.context?.missionId ?? request.missionId ?? null,
    role: spawn?.authority.context?.role ?? "user",
    rendererWaitMs,
    ok,
    totalMs,
    phases,
  });
}

function spawnCliPtyAgentPane(
  sender: WebContents,
  adapter: CliPtyAdapter,
  spawn: ResolvedMainOwnedAgentSpawn,
  authoritativePreparation?: ProviderSpawnPreparation,
  authSpawnGated = false,
  spawnPermitAcquired = false,
  spawnTiming?: PhaseTimer,
): SpawnResult | Promise<SpawnResult> {
  try {
    // Recursões internas (prep → gate → permissão) compartilham o timer —
    // um spawn, um evento. Chamador sem timer mede sozinho.
    const timer = spawnTiming ?? startPhaseTimer();
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
    // F-235: pane Claude de missão nunca nasce na conta de um pane Claude
    // vivo da mesma missão — cada pane fica numa conta distinta.
    const claudeMissionExclusions =
      adapter.id === 'claude' && authority.context?.missionId
        ? liveClaudeMissionAccountIds(authority.context.missionId)
        : undefined;
    const perSpawn = {
      effort: request.effort,
      accountId: request.accountId,
      model: request.model,
      ...(claudeMissionExclusions?.length
        ? { excludeAccountIds: claudeMissionExclusions }
        : {}),
      ...(adapter.id === 'muse' && authority.source === 'direct-user' && authority.context === null
        ? { allowNativeAuthAttempt: true } : {}),
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
    if ((adapter.id === "agy" || adapter.id === "claude") && authoritativePreparation === undefined) {
      return prepareProviderSpawnAuthoritative(adapter.id, perSpawn).then(
        (preparation) => {
          timer.mark("provider-prep");
          return spawnCliPtyAgentPane(
            sender, adapter, spawn, preparation, false, false, timer,
          );
        },
        (error) => {
          timer.mark("provider-prep");
          return {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "failed to verify provider authentication",
          };
        },
      );
    }
    const preparation =
      authoritativePreparation ?? prepareProviderSpawn(adapter.id, perSpawn);
    timer.mark("provider-prep");
    if (!preparation.ok) {
      throw new Error(preparation.error);
    }
    const selectedAccountId = preparation.overrides.selectedAccountId ?? request.accountId;
    if (request.accountId && selectedAccountId !== request.accountId) {
      throw new Error("selected account diverges from the authorized account pin");
    }
    // Selection can be automatic and preparation can restore scrubbed auth.
    // Gate the selected, materialized file; reuse this preparation after waiting
    // so account rotation cannot switch the credential underneath the lock.
    if (!authSpawnGated) {
      const authFile = resolveRotatingAuthFile(
        adapter.id,
        preparation.overrides.keyEnv,
      );
      if (authFile) {
        return waitForRotatingAuthSpawnGate({ authFile }).then(
          () => {
            timer.mark("rotating-auth-gate");
            return spawnCliPtyAgentPane(
              sender,
              adapter,
              spawn,
              preparation,
              true,
              false,
              timer,
            );
          },
          (error) => {
            timer.mark("rotating-auth-gate");
            return {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "failed to coordinate Codex auth refresh",
            };
          },
        );
      }
    }
    timer.mark("rotating-auth-gate");
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
          `executable path for "${adapter.bin}". Open Settings → AI accounts → ` +
          `Reexaminar CLIs, or set an absolute binary path. Common locations: ` +
          `~/.kimi-code/bin, ~/.local/bin, /opt/homebrew/bin, npm global bin.`,
      );
    }
    const overrides = {
      ...preparation.overrides,
      binPath: spawnBin,
    };
    const authorizedRequest = {
      ...request,
      cwd: authority.cwd,
      ...(selectedAccountId ? { accountId: selectedAccountId } : {}),
    };
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
      timer.mark("adopted-session");
      const settlement = settleSpawnedMainOwnedAgentSession({
        backend: "PTY",
        owner: sender,
        requestId: request.orchRequestId,
        sessionId: adopted.sessionId,
        authority,
        pending,
        recovery,
        persistedPane,
        terminate: () =>
          orchTerminateSession(adopted.sessionId, {
            origin: "pty-ipc:spawn-settlement",
          }),
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
        ...(preparation.overrides.selectedAccountId ? { accountId: selectedAccountId } : {}),
        adopted: true,
        state: adopted.state,
      };
    }

    if (!spawnPermitAcquired) {
      return acquireCliSpawnPermit(adapter.id).then(
        async (release) => {
          timer.mark("cli-spawn-permit");
          try {
            return await spawnCliPtyAgentPane(
              sender, adapter, spawn, preparation, true, true, timer,
            );
          } finally {
            release();
          }
        },
        (error) => {
          timer.mark("cli-spawn-permit");
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'failed to coordinate CLI update',
          };
        },
      );
    }
    timer.mark("cli-spawn-permit");

    assertNoLivePhysicalPaneProcess(spawn);
    const workerRestart = resolvePersistedWorkerRestart(spawn);
    assertMainOwnedAgentSpawnGrantActive({
      runtimeManager: projectRuntimeManager,
      owner: sender,
      requestId: request.orchRequestId,
      pending,
      recovery,
      persistedPane,
    });
    // Auth refresh / CLI update above may outlive the operator's workspace.
    if (authority.source === 'direct-user' && authority.coordinationScope &&
        authority.scope.rootRealPath !== authority.coordinationScope.rootRealPath) {
      requireLiveRendererWorkspaceScope(sender, authority.coordinationScope);
    }
    const { sessionId, resumeMode } = spawnAgentSession(
      sender,
      authorizedRequest,
      adapter,
      overrides,
      authority,
    );
    timer.mark("pty-spawn");
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
    if (selectedAccountId && isFileAuthAdapter(adapter.id)) {
      trackManagedSession(sessionId, adapter.id, selectedAccountId);
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
      terminate: () =>
        orchTerminateSession(sessionId, { origin: "pty-ipc:spawn-settlement" }),
    });
    if (settlement) return settlement;
    // O recibo só é registrado depois que o spawn se firma no Main — uma
    // sessão rejeitada pelo settlement não pode expor conta.
    if (overrides.accountChoice) {
      recordAccountChoiceReceipt(sessionId, overrides.accountChoice);
    }
    bindCommandTracking(
      sessionId,
      request.paneId ?? sessionId,
      adapter.id,
      spawn,
    );
    // Só a sessão ACEITA ganha scope (restart rejeitado e settlement já
    // retornaram acima). Sem isto o pane de agente aberto direto pelo operador
    // não tinha scope no registro: `nexus_pane_list` devolvia [] até para o
    // próprio pane e read/write nele caía em "pane belongs to another project
    // checkout" (campo 09/09). O shell direto já fazia este bind.
    attachSessionScope(sessionId, authority.coordinationScope ?? authority.scope);
    return {
      ok: true,
      sessionId,
      ...(preparation.overrides.selectedAccountId ? { accountId: selectedAccountId } : {}),
      ...(request.resume && resumeMode ? { resumeMode } : {}),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to spawn agent";
    return licenseFailure(err) ?? { ok: false, error: message };
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
      // F-213: o timer nasce depois da validação de schema e cobre todo o
      // trabalho main-side do spawn; `reportTiming` emite UMA vez no retorno
      // (sucesso, recusa de adapter/autoridade ou exceção).
      const spawnTiming = startPhaseTimer();
      let timingSpawn: ResolvedMainOwnedAgentSpawn | undefined;
      // F-723: grant pendente que ESTA chamada reivindicou. Se o PTY dele não
      // subir, o Main liquida a tentativa agora (não em 30 min) e o watchdog
      // de início avisa quem pediu e reroteia.
      let claimedPendingRequestId: string | undefined;
      const reportTiming = (ok: boolean, error?: string): void => {
        reportPaneSpawnTiming(spawnTiming, req, timingSpawn, ok);
        if (!ok && claimedPendingRequestId) {
          reportPendingSpawnStartFailure(
            claimedPendingRequestId,
            event.sender,
            error ?? "failed to spawn agent",
          );
        }
      };
      try {
        const envelope = authorizeMainOwnedAgentSpawn(
          event.sender,
          req,
          projectRuntimeManager,
        );
        claimedPendingRequestId = envelope.pending
          ? envelope.request.orchRequestId
          : undefined;
        const adapterId = envelope.request.adapterId;
        if (!adapterId) {
          reportTiming(false, "cli-agent spawn requires adapterId");
          return { ok: false, error: "cli-agent spawn requires adapterId" };
        }
        const adapter = getAdapter(adapterId);
        if (!adapter) {
          reportTiming(false, `unknown adapter: ${adapterId}`);
          return { ok: false, error: `unknown adapter: ${adapterId}` };
        }
        const isolatedTab = req.worktreeSpaceId && !envelope.pending &&
          !envelope.persistedPane && !req.missionId;
        const spawn = resolveMainOwnedAgentSpawn(
          event.sender,
          isolatedTab ? { ...envelope, request: { ...envelope.request, cwd: undefined } } : envelope,
          projectRuntimeManager,
        );
        timingSpawn = spawn;
        if (adapter.kind !== "cli-pty") {
          reportTiming(false, `adapter ${adapterId} is not a cli-pty adapter`);
          return {
            ok: false,
            error: `adapter ${adapterId} is not a cli-pty adapter`,
          };
        }
        if (isolatedTab && spawn.authority.source !== 'direct-user') {
          reportTiming(false);
          return { ok: false, error: 'Esta abertura já tem uma pasta definida pelo Nexus. Abra um novo pane comum na aba isolada.' };
        }
        if (isolatedTab && spawn.authority.source === 'direct-user') {
          const coordinationScope = spawn.authority.scope;
          return preparePaneSpaceWorktree(coordinationScope, req.worktreeSpaceId!, req.cwd)
            .then(async (worktree): Promise<SpawnResult> => {
              // F-790: Codex com a versão ainda em sondagem espera (teto curto)
              // ANTES do preparo e da checagem de escopo, para o gate de hooks
              // enxergar a versão — as demais CLIs seguem direto.
              await settleCodexCliVersionForSpawn(adapter);
              requireLiveRendererWorkspaceScope(event.sender, coordinationScope);
              const result = await spawnCliPtyAgentPane(event.sender, adapter, {
                ...spawn,
                request: { ...spawn.request, cwd: worktree.cwd },
                authority: { ...spawn.authority, scope: worktree.scope, cwd: worktree.cwd, coordinationScope },
              }, undefined, false, false, spawnTiming);
              return result.ok ? { ...result, cwd: worktree.cwd } : result;
            })
            .then((result) => {
              reportTiming(result.ok);
              return result;
            })
            .catch((error) => {
              reportTiming(false);
              return licenseFailure(error) ?? { ok: false, error: `Não foi possível abrir a pasta isolada da aba: ${error instanceof Error ? error.message : String(error)}` };
            });
        }
        // F-790: só o Codex, e só com a versão ainda em sondagem, espera —
        // `null` mantém o caminho síncrono de sempre.
        const settling = settleCodexCliVersionForSpawn(adapter);
        const outcome = settling
          ? settling.then(() =>
              spawnCliPtyAgentPane(
                event.sender, adapter, spawn, undefined, false, false, spawnTiming,
              ),
            )
          : spawnCliPtyAgentPane(
              event.sender, adapter, spawn, undefined, false, false, spawnTiming,
            );
        if (outcome instanceof Promise) {
          return outcome.then(
            (result) => {
              reportTiming(result.ok, result.ok ? undefined : result.error);
              return result;
            },
            (error) => {
              reportTiming(
                false,
                error instanceof Error ? error.message : "failed to spawn agent",
              );
              throw error;
            },
          );
        }
        reportTiming(outcome.ok, outcome.ok ? undefined : outcome.error);
        return outcome;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "failed to spawn agent";
        reportTiming(false, message);
        if (err instanceof WorkspaceRootMissingError) {
          probeCurrentWorkspaceLiveness();
        }
        return licenseFailure(err) ?? { ok: false, error: message };
      }
    }

    try {
      const scope = requireRendererWorkspaceScope(event.sender);
      const shell = resolveConfiguredShell(
        req.shell,
        getTerminalSettings().shell,
        listAvailableShells(),
      );
      const startShell = (executionScope: ProjectExecutionScope, cwd: string): SpawnResult => {
        const { sessionId } = spawnSession(
          event.sender,
          { ...req, cwd, shell },
          { scope: executionScope, cwd, shell },
        );
        attachSessionScope(sessionId, scope);
        registerCommandBlockScope(sessionId, executionScope);
        getCommandBlockTracker()?.bindSession(sessionId, {
          paneId: req.paneId ?? sessionId,
          workspaceId: scope.checkoutId,
          shell,
          cwd,
          projectRoot: executionScope.rootRealPath,
        });
        return { ok: true, sessionId, ...(req.worktreeSpaceId ? { cwd } : {}) };
      };
      if (req.worktreeSpaceId) {
        return preparePaneSpaceWorktree(scope, req.worktreeSpaceId, req.cwd)
          .then((worktree) => {
            requireLiveRendererWorkspaceScope(event.sender, scope);
            return startShell(worktree.scope, worktree.cwd);
          })
          .catch((error) => licenseFailure(error) ?? ({ ok: false, error: `Não foi possível abrir a pasta isolada da aba: ${error instanceof Error ? error.message : String(error)}` }));
      }
      return startShell(scope, resolveCwdForScope(scope, req.cwd));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "failed to spawn shell";
      if (err instanceof WorkspaceRootMissingError) {
        probeCurrentWorkspaceLiveness();
      }
      return licenseFailure(err) ?? { ok: false, error: message };
    }
  });

  ipcMain.on(PTY_CHANNELS.write, (event, raw) => {
    const parsed = writeSchema.safeParse(raw);
    if (parsed.success) {
      writeSession(event.sender, parsed.data.sessionId, parsed.data.data);
    }
  });

  ipcMain.handle(PTY_CHANNELS.promptEnter, (event, raw) => submitOwnedPromptEnter(event.sender, raw));
  ipcMain.handle(PTY_CHANNELS.promptState, (event, raw) => readOwnedPromptState(event.sender, raw));

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
        { assert: parsed.data.assert, reported: parsed.data.reported },
      );
    }
  });

  ipcMain.on(PTY_CHANNELS.kill, (event, raw) => {
    const parsed = killSchema.safeParse(raw);
    if (parsed.success) {
      killSession(event.sender, parsed.data.sessionId, {
        origin: "renderer:pty.kill",
      });
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
