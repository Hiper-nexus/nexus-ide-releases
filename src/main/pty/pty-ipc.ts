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
import { hasCurrentDispatchAuthority } from "../../shared/mission-intent";
import { PET_STUDIO_SQUAD_ID } from "../../shared/pet-studio";
import {
  spawnSession,
  spawnAgentSession,
  writeSession,
  resizeSession,
  killSession,
  acknowledgeSessionOutput,
  recoverSessionOutput,
  setPtyHost,
} from "./pty-manager";
import { createRealPtyHost } from "./pty-host-client";
import { getAdapter, isAdapterInstalled } from "../adapters/adapter-registry";
import type { CliRpcAdapter } from "../../shared/adapter-types";
import {
  acknowledgeOmpRpcPaneOutput,
  isOmpRpcPaneOwnedBy,
  killOmpRpcPane,
  recoverOmpRpcPaneOutput,
  spawnOmpRpcPane,
  writeOmpRpcPaneInput,
} from "../adapters/omp-rpc-ipc";
import { prepareProviderSpawn } from "../persistence/provider-config-store";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import { trackManagedSession } from "../adapters/managed-credentials";
import { isFileAuthAdapter } from "../adapters/managed-credentials";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  attachOrchMeta,
  attachSessionScope,
  bindPendingSpawnSession,
  claimPendingSpawnMeta,
} from "../orch/pane-registry";
import { createScopedMissionPaneStore } from "../orch/mission-pane-store";
import { createScopedMissionStore } from "../orch/mission-store";
import { listSquads } from "../orch/squad-store";
import {
  type BoundSpawnAuthority,
  bindSpawnAuthority,
  isKnownLegacySquadSpawnRequest,
} from "../orch/spawn-authority";

let projectRuntimeManager: ProjectRuntimeManager | null = null;

export function configurePtyProjectRuntimeManager(
  runtimeManager: ProjectRuntimeManager,
): void {
  projectRuntimeManager = runtimeManager;
}

function findPersistedPane(owner: WebContents, paneId: string) {
  if (!projectRuntimeManager) {
    throw new Error("project-scoped PTY runtime is not initialized");
  }
  const scope = requireRendererWorkspaceScope(owner);
  return createScopedMissionPaneStore(
    projectRuntimeManager,
    scope,
  ).findByPaneId(paneId);
}
import { resolveCwdForScope } from "../orch/workspace-path";
import {
  getOrchSettings,
  getTerminalSettings,
} from "../persistence/settings-store";
import {
  listAvailableShells,
  resolveConfiguredShell,
} from "../persistence/shell-catalog";
import { getCommandBlockTracker } from "../terminal/command-block-tracker";
import { registerCommandBlockScope } from "../terminal/command-block-scope-registry";

function bindMissionLaunchAuthority(
  authority: BoundSpawnAuthority,
  requestedMissionId: string | undefined,
): BoundSpawnAuthority {
  const boundMissionId = authority.context?.missionId;
  if (
    requestedMissionId &&
    boundMissionId &&
    requestedMissionId !== boundMissionId
  ) {
    throw new Error("spawn mission does not match main-owned authority");
  }
  const missionId = requestedMissionId ?? boundMissionId;
  if (missionId) {
    if (authority.source === "direct-user" || !authority.context) {
      throw new Error("mission agent spawn requires main-owned role authority");
    }
    if (!projectRuntimeManager) {
      throw new Error("project-scoped PTY runtime is not initialized");
    }
    const coordinationScope = authority.coordinationScope ?? authority.scope;
    const mission = createScopedMissionStore(
      projectRuntimeManager,
      coordinationScope,
    ).get(missionId);
    if (!mission) {
      throw new Error("mission not found for spawn authority");
    }
    if (
      authority.context.squadId &&
      mission.squadId !== authority.context.squadId
    ) {
      throw new Error("mission squad does not match spawn authority");
    }
    if (!hasCurrentDispatchAuthority(mission)) {
      throw new Error(
        "approval_required: mission current intent is not authorized for agent spawn",
      );
    }
    return Object.freeze({
      ...authority,
      context: Object.freeze({ ...authority.context, missionId }),
    });
  }

  if (authority.source === "legacy-squad") {
    const squadId = authority.context?.squadId;
    const isImmediateException =
      squadId === PET_STUDIO_SQUAD_ID ||
      getOrchSettings().intentFirstMissionRuntimeV1 === false;
    if (!isImmediateException) {
      throw new Error(
        "intent-first: immediate squad spawn is not authorized",
      );
    }
  }
  return authority;
}

/**
 * cli-rpc agent spawn: mirrors the cli-pty authority pipeline exactly
 * (pending claim → persisted pane → scope resolution → mission binding) but
 * hosts the session over RPC pipes instead of a PTY. Sibling block so the
 * PTY path stays byte-for-byte untouched.
 */
async function spawnCliRpcAgentPane(
  sender: WebContents,
  req: import("zod").infer<typeof spawnRequestSchema>,
  adapter: CliRpcAdapter,
): Promise<SpawnResult> {
  if (!isAdapterInstalled(adapter.id)) {
    return {
      ok: false,
      error: `${adapter.label} not found. Install: ${adapter.install.command}`,
    };
  }
  try {
    const pending = req.orchRequestId
      ? claimPendingSpawnMeta(req.orchRequestId, sender)
      : null;
    const persistedPane =
      (req.resume || req.restorePersistedAuthority) && req.paneId
        ? findPersistedPane(sender, req.paneId)
        : null;
    if (persistedPane && persistedPane.adapterId !== adapter.id) {
      throw new Error(
        "persisted pane adapter does not match spawn request",
      );
    }
    const squads = listSquads();
    const knownLegacySquadRequest = Boolean(
      req.orchRequestId &&
        isKnownLegacySquadSpawnRequest(req.orchRequestId, squads),
    );
    const orchRequestId =
      req.orchRequestId && !pending && !persistedPane && !knownLegacySquadRequest
        ? undefined
        : req.orchRequestId;
    const needsActiveScope = !pending?.scope && !persistedPane?.scope;
    const trustedUserScope = needsActiveScope
      ? requireRendererWorkspaceScope(sender)
      : null;
    const authority = bindMissionLaunchAuthority(
      bindSpawnAuthority({
        requestId: orchRequestId,
        pending,
        squads,
        persistedPane,
        trustedUserScope,
        requestedCwd: req.cwd,
      }),
      req.missionId,
    );
    const spawned = await spawnOmpRpcPane({
      owner: sender,
      scope: authority.scope,
      workspaceRoot: authority.cwd,
      paneId: req.paneId,
      model: req.model,
      missionId: authority.context?.missionId ?? req.missionId,
    });
    if (!spawned.ok) throw new Error(spawned.error);
    const { sessionId } = spawned;
    if (
      authority.source === "pending" &&
      (!req.orchRequestId ||
        !bindPendingSpawnSession(req.orchRequestId, sender, sessionId))
    ) {
      killOmpRpcPane(sessionId);
      throw new Error(
        "orchestration request could not bind spawned RPC session",
      );
    }
    attachSessionScope(sessionId, authority.scope);
    if (persistedPane && req.paneId) {
      attachOrchMeta(sender, req.paneId, {
        missionId: persistedPane.missionId,
        agentName: persistedPane.agentName,
        role: persistedPane.role,
        scope: persistedPane.scope,
        executionScope: persistedPane.executionScope,
        allowedTools: persistedPane.allowedTools,
        allowedSkills: persistedPane.allowedSkills,
      });
    }
    return { ok: true, sessionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to spawn agent";
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
      if (!req.adapterId) {
        return { ok: false, error: "cli-agent spawn requires adapterId" };
      }
      const adapter = getAdapter(req.adapterId);
      if (!adapter) {
        return { ok: false, error: `unknown adapter: ${req.adapterId}` };
      }
      // cli-rpc: hosted over NDJSON pipes (omp --mode rpc-ui), no PTY. Same
      // authority pipeline; the pane streams via the normal PTY data channel.
      if (adapter.kind === "cli-rpc") {
        return spawnCliRpcAgentPane(event.sender, req, adapter);
      }
      if (adapter.kind !== "cli-pty") {
        return {
          ok: false,
          error: `adapter ${req.adapterId} is not a cli-pty adapter`,
        };
      }
      const preparation = prepareProviderSpawn(adapter.id, {
        effort: req.effort,
        accountId: req.accountId,
        model: req.model,
      });
      if (!preparation.ok) {
        return { ok: false, error: preparation.error };
      }
      const { overrides } = preparation;
      // node-pty does not throw for a missing binary on macOS: it spawns and exits
      // 1 with no output, so the pane would show a bare "process exited (code 1)".
      // Gate on install status here to surface the actionable install command.
      // A user-set binary path bypasses the PATH-based install check.
      if (!overrides.binPath && !isAdapterInstalled(adapter.id)) {
        return {
          ok: false,
          error: `${adapter.label} not found. Install: ${adapter.install.command}`,
        };
      }
      try {
        const pending = req.orchRequestId
          ? claimPendingSpawnMeta(req.orchRequestId, event.sender)
          : null;
        const persistedPane =
          (req.resume || req.restorePersistedAuthority) && req.paneId
            ? findPersistedPane(event.sender, req.paneId)
            : null;
        if (persistedPane && persistedPane.adapterId !== adapter.id) {
          throw new Error(
            "persisted pane adapter does not match spawn request",
          );
        }
        // Stale orchRequestId after a failed/expired first spawn: the layout
        // leaf still exists and the user hits Reiniciar. Re-throwing
        // "unknown or expired" leaves a dead pane forever. Drop the id and
        // bind as a direct user spawn (scope from workspace / persisted).
        const squads = listSquads();
        const knownLegacySquadRequest = Boolean(
          req.orchRequestId &&
            isKnownLegacySquadSpawnRequest(req.orchRequestId, squads),
        );
        const orchRequestId =
          req.orchRequestId &&
          !pending &&
          !persistedPane &&
          !knownLegacySquadRequest
            ? undefined
            : req.orchRequestId;
        const needsActiveScope = !pending?.scope && !persistedPane?.scope;
        const trustedUserScope = needsActiveScope
          ? requireRendererWorkspaceScope(event.sender)
          : null;
        const authority = bindMissionLaunchAuthority(
          bindSpawnAuthority({
            requestId: orchRequestId,
            pending,
            squads,
            persistedPane,
            trustedUserScope,
            requestedCwd: req.cwd,
          }),
          req.missionId,
        );
        // Downstream code receives the canonical value as defense in depth;
        // spawnAgentSession independently ignores renderer cwd and consumes
        // authority.cwd as the actual PTY working directory.
        const authorizedRequest = { ...req, cwd: authority.cwd };
        const { sessionId, resumeMode } = spawnAgentSession(
          event.sender,
          authorizedRequest,
          adapter,
          overrides,
          authority,
        );
        // M1: track managed-account sessions so auth.json is scrubbed on exit.
        if (req.accountId && isFileAuthAdapter(adapter.id)) {
          trackManagedSession(sessionId, adapter.id, req.accountId);
        }
        if (
          authority.source === "pending" &&
          (!req.orchRequestId ||
            !bindPendingSpawnSession(
              req.orchRequestId,
              event.sender,
              sessionId,
            ))
        ) {
          killSession(event.sender, sessionId);
          throw new Error(
            "orchestration request could not bind spawned PTY session",
          );
        }
        attachSessionScope(sessionId, authority.scope);
        if (persistedPane && req.paneId) {
          attachOrchMeta(event.sender, req.paneId, {
            missionId: persistedPane.missionId,
            agentName: persistedPane.agentName,
            role: persistedPane.role,
            scope: persistedPane.scope,
            executionScope: persistedPane.executionScope,
            allowedTools: persistedPane.allowedTools,
            allowedSkills: persistedPane.allowedSkills,
          });
        }
        registerCommandBlockScope(sessionId, authority.scope);
        getCommandBlockTracker()?.bindSession(sessionId, {
          paneId: req.paneId ?? sessionId,
          workspaceId: authority.scope.checkoutId,
          shell: adapter.id,
          cwd: authority.cwd,
          projectRoot: authority.scope.rootRealPath,
          missionId: authority.context?.missionId,
        });
        return {
          ok: true,
          sessionId,
          ...(req.resume && resumeMode ? { resumeMode } : {}),
        };
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
      if (
        isOmpRpcPaneOwnedBy(parsed.data.sessionId, event.sender) &&
        writeOmpRpcPaneInput(parsed.data.sessionId, parsed.data.data)
      ) {
        return;
      }
      writeSession(event.sender, parsed.data.sessionId, parsed.data.data);
    }
  });

  ipcMain.handle(PTY_CHANNELS.writeConfirmed, (event, raw): boolean => {
    const parsed = writeSchema.safeParse(raw);
    if (!parsed.success) return false;
    if (
      isOmpRpcPaneOwnedBy(parsed.data.sessionId, event.sender) &&
      writeOmpRpcPaneInput(parsed.data.sessionId, parsed.data.data)
    ) {
      return true;
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
        killOmpRpcPane(parsed.data.sessionId);
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
