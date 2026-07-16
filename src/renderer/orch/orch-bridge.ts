import { useEffect } from 'react';
import type {
  MissionPaneRecoveryRequest,
  MissionPaneRecoveryResult,
  PaneRegistryEntry,
} from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { createPane, listPanes } from '../lib/split-tree';
import {
  cancelPaneRecovery,
  getPaneSessionId,
  isPaneSessionHealthy,
  markPersistedAuthorityOnSpawn,
  onPaneSessionChange,
  respawnMissionPaneFresh,
  submitPromptToPaneConfirmed,
  waitForHealthyPaneSession,
  waitForSession,
} from '../terminal/terminal-host';
import { waitForBrowserPaneCreated } from '../browser/browser-host';
import { initAgentNotificationBridge } from './agent-notification-bridge';

/**
 * Renderer half of the orchestration bridge:
 *  - answers main-process pane spawn/close requests (the renderer owns the
 *    layout tree, so panes must be created here);
 *  - mirrors the pane set (paneId ↔ sessionId ↔ metadata) into the main
 *    process registry that backs nexus_pane_list / nexus_pane_read;
 *  - keeps the orchestration store hydrated via change events.
 */

function snapshotPanes(): PaneRegistryEntry[] {
  const { root } = useLayoutStore.getState();
  const paneStates = useSessionStateStore.getState().paneStates;
  return listPanes(root).map((pane) => ({
    paneId: pane.id,
    sessionId: getPaneSessionId(pane.id),
    title: pane.title,
    kind: pane.kind,
    adapterId: pane.adapterId,
    model: pane.model,
    accountId: pane.accountId,
    state: paneStates.get(pane.id),
  }));
}

const recoveryInFlight = new Set<string>();
const recoveryResults = new Map<string, MissionPaneRecoveryResult>();
const RECOVERY_HEALTH_TIMEOUT_MS = 75_000;

function cacheRecoveryResult(result: MissionPaneRecoveryResult): void {
  recoveryResults.set(result.requestId, result);
  if (recoveryResults.size <= 64) return;
  const oldest = recoveryResults.keys().next().value as string | undefined;
  if (oldest) recoveryResults.delete(oldest);
}

function paneFromRecovery(req: MissionPaneRecoveryRequest): PaneModel {
  if (req.pane.role !== req.role) {
    throw new Error('mission pane role does not match recovery request');
  }
  const base = createPane(
    'cli-agent',
    req.pane.cwd,
    req.pane.adapterId,
    req.pane.model,
  );
  return {
    ...base,
    id: req.paneId,
    title: req.pane.title,
    accountId: req.pane.accountId,
    effort: req.pane.effort,
    agentName: req.pane.agentName,
    role: req.role,
  };
}

async function recoverMissionPane(
  req: MissionPaneRecoveryRequest,
): Promise<MissionPaneRecoveryResult> {
  let replacementSessionId: string | undefined;
  let recoveryOwned = false;
  try {
    let pane = listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === req.paneId,
    );
    if (pane && pane.kind !== 'cli-agent') {
      throw new Error('stable mission pane is not a CLI agent');
    }
    if (pane) {
      replacementSessionId = await respawnMissionPaneFresh(
        pane,
        req.expectedSessionId,
      );
      // The helper owns cleanup until its CAS check, spawn and health check
      // succeed. Only then may this request cancel the exact replacement.
      recoveryOwned = true;
    } else {
      pane = paneFromRecovery(req);
      recoveryOwned = true;
      markPersistedAuthorityOnSpawn(pane.id);
      useOrchStore.getState().bindPaneMission(pane.id, req.missionId);
      const existing = listPanes(useLayoutStore.getState().root);
      useLayoutStore.getState().setPanes([...existing, pane]);
      replacementSessionId =
        (await waitForHealthyPaneSession(
          pane.id,
          req.expectedSessionId,
          RECOVERY_HEALTH_TIMEOUT_MS,
        )) ?? undefined;
      if (!replacementSessionId) {
        throw new Error('missing mission pane did not become healthy');
      }
    }

    useOrchStore.getState().bindPaneMission(req.paneId, req.missionId);
    window.nexus.orch.syncPanes(snapshotPanes());
    if (
      !(await submitPromptToPaneConfirmed(
        req.paneId,
        req.recap,
        replacementSessionId,
      )) ||
      !isPaneSessionHealthy(req.paneId, replacementSessionId)
    ) {
      throw new Error('mission recap was not submitted to a healthy session');
    }
    if (req.role === 'orchestrator') {
      const rebound = await window.nexus.orch.rebindMissionOrchestrator(
        req.missionId,
        replacementSessionId,
      );
      if (!rebound.ok) {
        throw new Error('fresh pane session was not rebound to mission');
      }
    }
    window.nexus.orch.syncPanes(snapshotPanes());
    return {
      requestId: req.requestId,
      ok: true,
      paneId: req.paneId,
      sessionId: replacementSessionId,
    };
  } catch (error) {
    if (recoveryOwned) {
      cancelPaneRecovery(req.paneId, replacementSessionId);
      window.nexus.orch.syncPanes(snapshotPanes());
    }
    return {
      requestId: req.requestId,
      ok: false,
      paneId: req.paneId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function useOrchBridge(): void {
  const hydrate = useOrchStore((s) => s.hydrate);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);

  useEffect(() => {
    useOrchStore.getState().resetProjectState();
    if (workspaceHydrated && workspacePath) void hydrate(workspacePath);
  }, [hydrate, workspaceHydrated, workspacePath]);

  useEffect(() => {
    const un = [
      window.nexus.orch.onPaneSpawnRequest((req) => {
        void (async () => {
          try {
            const existing = listPanes(useLayoutStore.getState().root).find(
              (pane) => pane.orchRequestId === req.requestId,
            );
            const paneId = existing?.id ??
              useLayoutStore.getState().spawnOrchPane({
                adapterId: req.adapterId,
                model: req.model,
                effort: req.effort,
                cwd: req.cwd,
                title: req.title,
                orchRequestId: req.requestId,
                agentName: req.agentName,
                role: req.role ?? 'worker',
              });
            useOrchStore.getState().bindPaneMission(paneId, req.missionId);
            const sessionId = await waitForSession(paneId, 75_000);
            window.nexus.orch.syncPanes(snapshotPanes());
            if (!sessionId) {
              window.nexus.orch.sendPaneSpawnResult({
                requestId: req.requestId,
                ok: false,
                paneId,
                error: 'session did not start (adapter missing or spawn failed)',
              });
              return;
            }
            window.nexus.orch.sendPaneSpawnResult({
              requestId: req.requestId,
              ok: true,
              paneId,
              sessionId,
            });
          } catch (err) {
            window.nexus.orch.sendPaneSpawnResult({
              requestId: req.requestId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }),

      window.nexus.orch.onPaneRecoveryRequest((req) => {
        const cached = recoveryResults.get(req.requestId);
        if (cached) {
          window.nexus.orch.sendPaneRecoveryResult(cached);
          return;
        }
        if (recoveryInFlight.has(req.requestId)) return;
        recoveryInFlight.add(req.requestId);
        void recoverMissionPane(req).then((result) => {
          recoveryInFlight.delete(req.requestId);
          cacheRecoveryResult(result);
          window.nexus.orch.sendPaneRecoveryResult(result);
        });
      }),

      window.nexus.orch.onBrowserOpenRequest((req) => {
        void (async () => {
          let paneId: string | null = null;
          try {
            paneId = useLayoutStore.getState().addBrowserPane(req.url);
            await waitForBrowserPaneCreated(paneId);
            window.nexus.orch.syncPanes(snapshotPanes());
            window.nexus.orch.sendBrowserOpenResult({
              requestId: req.requestId,
              ok: true,
              paneId,
            });
          } catch (err) {
            if (paneId) {
              useLayoutStore.getState().close(paneId, 'browser-open-failed');
              window.nexus.orch.syncPanes(snapshotPanes());
            }
            window.nexus.orch.sendBrowserOpenResult({
              requestId: req.requestId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }),

      window.nexus.orch.onPaneCloseRequest((paneId) => {
        useLayoutStore.getState().close(paneId, 'orch-close-request');
        window.nexus.orch.syncPanes(snapshotPanes());
      }),

      window.nexus.orch.onMissionsChanged((missions) => {
        useOrchStore.getState().setMissions(missions);
        // Vincula o pane do ORQUESTRADOR à missão dele (via sessionId): sem
        // isto a missão nova nunca constava como aberta — o rail oferecia
        // "retomar" na missão viva e o clique matava/respawnava ela mesma.
        const panes = listPanes(useLayoutStore.getState().root);
        for (const mission of missions) {
          if (!mission.orchestratorSessionId) continue;
          const pane = panes.find(
            (p) => getPaneSessionId(p.id) === mission.orchestratorSessionId,
          );
          if (pane) {
            useOrchStore.getState().bindPaneMission(pane.id, mission.id);
          }
        }
      }),
      window.nexus.orch.onHandoffsChanged((handoffs) =>
        useOrchStore.getState().setHandoffs(handoffs),
      ),
      window.nexus.orch.onTodosChanged((lists) =>
        useOrchStore.getState().setTodoLists(lists),
      ),
      window.nexus.orch.onSquadsChanged((squads) =>
        useOrchStore.getState().setSquads(squads),
      ),
    ];

    // Pane mirror, fully event-driven (no heartbeat): push on every layout
    // change AND when a pane's sessionId materializes after its async spawn —
    // the exact event the old 1s setInterval was polling for.
    const unsubLayout = useLayoutStore.subscribe(() => {
      // Bindings pane→missão de panes que saíram do layout morrem junto —
      // senão a missão deslocada fica "aberta" para sempre (não-clicável).
      const live = new Set(
        listPanes(useLayoutStore.getState().root).map((p) => p.id),
      );
      useOrchStore.getState().pruneMissionBindings(live);
      window.nexus.orch.syncPanes(snapshotPanes());
    });
    const unsubSession = onPaneSessionChange(() => {
      window.nexus.orch.syncPanes(snapshotPanes());
    });
    const unsubState = useSessionStateStore.subscribe(() => {
      window.nexus.orch.syncPanes(snapshotPanes());
    });
    // Inbox de notificações de agentes: transições busy→idle sustentado /
    // exited viram itens no sininho da workspace bar (fora do state-store).
    const stopNotifBridge = initAgentNotificationBridge();
    window.nexus.orch.syncPanes(snapshotPanes());

    return () => {
      un.forEach((fn) => fn());
      unsubLayout();
      unsubSession();
      unsubState();
      stopNotifBridge();
    };
  }, []);
}
