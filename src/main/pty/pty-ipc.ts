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
  listAgentSessionsForPane,
  writeSession,
  resizeSession,
  killSession,
  orchTerminateSession,
  acknowledgeSessionOutput,
  recoverSessionOutput,
  setPtyHost,
} from "./pty-manager";
import { createRealPtyHost } from "./pty-host-client";
import {
  getAdapter,
  getAdapterResolvedBin,
  isAdapterInstalled,
  resolveAdapterBinary,
} from "../adapters/adapter-registry";
import { revalidateExecutable } from "../path-resolver";
import type {
  CliPtyAdapter,
  CliRpcAdapter,
} from "../../shared/adapter-types";
import {
  acknowledgeOmpRpcPaneOutput,
  canRendererControlOmpRpcPane,
  isOmpRpcPaneOwnedBy,
  killOmpRpcPane,
  listOmpRpcSessions,
  recoverOmpRpcPaneOutput,
  spawnOmpRpcPane,
  terminateOmpRpcSession,
  writeOmpRpcPaneInput,
} from "../adapters/omp-rpc-ipc";
import { prepareProviderSpawn } from "../persistence/provider-config-store";
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
import { getTerminalSettings } from "../persistence/settings-store";
import {
  listAvailableShells,
  resolveConfiguredShell,
} from "../persistence/shell-catalog";
import { getCommandBlockTracker } from "../terminal/command-block-tracker";
import { registerCommandBlockScope } from "../terminal/command-block-scope-registry";

let projectRuntimeManager: ProjectRuntimeManager | null = null;

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
    (listAgentSessionsForPane(paneId).length > 0 ||
      listOmpRpcSessions().some(
        (session) =>
          session.paneId === paneId && session.state !== "exited",
      ))
  ) {
    throw new Error(
      "live physical mission process still owns this pane; " +
        "replacement is denied until main observes its exact exit",
    );
  }
}

async function spawnCliRpcAgentPane(
  sender: WebContents,
  adapter: CliRpcAdapter,
  spawn: ResolvedMainOwnedAgentSpawn,
): Promise<SpawnResult> {
  try {
    const {
      request,
      authority,
      pending,
      recovery,
      persistedPane,
    } = spawn;
    if (persistedPane && request.resume) {
      throw new Error(
        "exact main-owned provider session is unavailable for RPC mission resume",
      );
    }
    if (
      persistedPane?.role === "worker" &&
      persistedPane.workerIncarnationId
    ) {
      throw new Error(
        "worker_incarnation_lost: o processo exato desta encarnação não pode " +
          "ser adotado; o Nexus não reutiliza uma identidade física em outro worker",
      );
    }
    if (
      requiresReadOnlyNativeAuthority({
        source: authority.source,
        role: authority.context?.role,
        contextRevision: authority.context?.contextRevision,
        readOnly: authority.context?.readOnly,
        nativeReadOnly: authority.context?.nativeReadOnly,
      })
    ) {
      throw new Error(
        `adapter ${adapter.id} RPC cannot enforce native read-only authority`,
      );
    }
    if (!isAdapterInstalled(adapter.id)) {
      throw new Error(
        `${adapter.label} not found. Install: ${adapter.install.command}`,
      );
    }
    assertNoLivePhysicalPaneProcess(spawn);
    const spawned = await spawnOmpRpcPane({
      owner: sender,
      scope: authority.scope,
      workspaceRoot: authority.cwd,
      paneId: request.paneId,
      title: persistedPane?.title ?? authority.context?.agentName,
      agentName: authority.context?.agentName,
      model: request.model,
      missionId:
        authority.context?.missionId ?? request.missionId,
      workerIncarnationId: authority.context?.workerIncarnationId,
      allowedTools: authority.context?.allowedTools,
      assertAuthority: () =>
        assertMainOwnedAgentSpawnGrantActive({
          owner: sender,
          requestId: request.orchRequestId,
          pending,
          recovery,
        }),
    });
    if (!spawned.ok) throw new Error(spawned.error);
    const { sessionId } = spawned;
    const settlement = settleSpawnedMainOwnedAgentSession({
      backend: "RPC",
      owner: sender,
      requestId: request.orchRequestId,
      sessionId,
      authority,
      pending,
      recovery,
      persistedPane,
      terminate: () => terminateOmpRpcSession(sessionId),
    });
    if (settlement) return settlement;
    return { ok: true, sessionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to spawn agent";
    return { ok: false, error: message };
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
): SpawnResult | Promise<SpawnResult> {
  try {
    const {
      request,
      authority,
      pending,
      recovery,
      persistedPane,
    } = spawn;
    const nativeReadOnly = requiresReadOnlyNativeAuthority({
      source: authority.source,
      role: authority.context?.role,
      contextRevision: authority.context?.contextRevision,
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
    const preparation = prepareProviderSpawn(adapter.id, {
      effort: request.effort,
      accountId: request.accountId,
      model: request.model,
    });
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
    if (
      persistedPane?.role === "worker" &&
      persistedPane.workerIncarnationId
    ) {
      throw new Error(
        "worker_incarnation_lost: o processo exato desta encarnação não " +
          "está vivo; o Nexus não cria outro PTY com o mesmo nonce",
      );
    }
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

  // Sync for every legacy path (the account/PTY tests assert plain objects);
  // the cli-rpc branch returns a Promise, which ipcMain.handle awaits either
  // way — and the renderer's invoke always receives a promise regardless.
  ipcMain.handle(PTY_CHANNELS.spawn, (event, raw): SpawnResult | Promise<SpawnResult> => {
    const parsed = spawnRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid spawn request" };
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
        if (adapter.kind === "cli-rpc") {
          return spawnCliRpcAgentPane(event.sender, adapter, spawn);
        }
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
      if (isOmpRpcPaneOwnedBy(parsed.data.sessionId, event.sender)) {
        if (canRendererControlOmpRpcPane(parsed.data.sessionId, event.sender)) {
          writeOmpRpcPaneInput(parsed.data.sessionId, parsed.data.data);
        }
        return;
      }
      writeSession(event.sender, parsed.data.sessionId, parsed.data.data);
    }
  });

  ipcMain.handle(PTY_CHANNELS.writeConfirmed, (event, raw): boolean => {
    const parsed = writeSchema.safeParse(raw);
    if (!parsed.success) return false;
    if (isOmpRpcPaneOwnedBy(parsed.data.sessionId, event.sender)) {
      return (
        canRendererControlOmpRpcPane(parsed.data.sessionId, event.sender) &&
        writeOmpRpcPaneInput(parsed.data.sessionId, parsed.data.data)
      );
    }
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
      if (isOmpRpcPaneOwnedBy(parsed.data.sessionId, event.sender)) {
        if (canRendererControlOmpRpcPane(parsed.data.sessionId, event.sender)) {
          killOmpRpcPane(parsed.data.sessionId);
        }
        return;
      }
      killSession(event.sender, parsed.data.sessionId);
    }
  });

  ipcMain.on(PTY_CHANNELS.acknowledge, (event, raw) => {
    const parsed = ptyAcknowledgeSchema.safeParse(raw);
    if (parsed.success) {
      if (acknowledgeOmpRpcPaneOutput(parsed.data.sessionId)) return;
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
    if (isOmpRpcPaneOwnedBy(parsed.data.sessionId, event.sender)) {
      return recoverOmpRpcPaneOutput(
        parsed.data.sessionId,
        parsed.data.afterSequence,
      );
    }
    return recoverSessionOutput(
      event.sender,
      parsed.data.sessionId,
      parsed.data.afterSequence,
    );
  });
}
