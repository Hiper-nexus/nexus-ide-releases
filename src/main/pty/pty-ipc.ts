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
  writeSession,
  resizeSession,
  killSession,
  acknowledgeSessionOutput,
  recoverSessionOutput,
  setPtyHost,
} from "./pty-manager";
import { createRealPtyHost } from "./pty-host-client";
import { getAdapter, isAdapterInstalled } from "../adapters/adapter-registry";
import { prepareProviderSpawn } from "../persistence/provider-config-store";
import { requireRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  attachSessionScope,
  bindPendingSpawnSession,
  claimPendingSpawnMeta,
} from "../orch/pane-registry";
import { createScopedMissionPaneStore } from "../orch/mission-pane-store";
import { listSquads } from "../orch/squad-store";
import {
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
import { getTerminalSettings } from "../persistence/settings-store";
import {
  listAvailableShells,
  resolveConfiguredShell,
} from "../persistence/shell-catalog";

/**
 * Registers the PTY IPC surface. Every handler validates its payload with zod
 * before touching the PTY manager. The `spawn` handler dispatches to either the
 * shell or agent path based on the request kind.
 */
export function registerPtyIpc(): void {
  // Route every PTY through the isolated utilityProcess host (node-pty never
  // loads in the main process — docs/ARCHITECTURE.md §B.2).
  setPtyHost(createRealPtyHost());

  ipcMain.handle(PTY_CHANNELS.spawn, (event, raw): SpawnResult => {
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
          req.resume && req.paneId
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
        const authority = bindSpawnAuthority({
          requestId: orchRequestId,
          pending,
          squads,
          persistedPane,
          trustedUserScope,
          requestedCwd: req.cwd,
        });
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
