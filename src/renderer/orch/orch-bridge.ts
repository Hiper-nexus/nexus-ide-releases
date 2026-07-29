import { useEffect } from 'react';
import type {
  MissionPaneRecoveryRequest,
  MissionPaneRecoveryResult,
  MissionPanePresentationRequest,
  PaneRegistryEntry,
} from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { useHomeStore } from '../state/home-store';
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
import {
  detectNewPlanHandoffs,
  notifyPlanHandoffsReady,
} from './plan-handoff-notify';
import type { Handoff } from '../../shared/orch-types';
import {
  newlyDispatchedPlanMissionIds,
  usePlanLaneMetricsStore,
} from '../state/plan-lane-metrics-store';

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

function cleanupFailedOrchPane(
  request: { readonly requestId: string; readonly paneId: string },
  paneId: string | null,
): void {
  const pane = listPanes(useLayoutStore.getState().root).find((candidate) => {
    if (candidate.kind !== 'cli-agent') return false;
    if (paneId) {
      return (
        candidate.id === paneId &&
        (candidate.orchRequestId === request.requestId ||
          candidate.orchRequestId === undefined)
      );
    }
    return candidate.orchRequestId === request.requestId;
  });
  if (pane) {
    useLayoutStore.getState().close(pane.id, 'orch-spawn-failed');
  }
  // Explicit final mirror: layout subscriptions also publish changes, but the
  // Main result must never overtake the cleanup snapshot.
  window.nexus.orch.syncPanes(snapshotPanes());
}

const recoveryInFlight = new Set<string>();
const recoveryResults = new Map<string, MissionPaneRecoveryResult>();
const RECOVERY_HEALTH_TIMEOUT_MS = 75_000;
const presentationInFlight = new Map<string, Promise<void>>();

interface PresentationScope {
  readonly workspacePath: string | null;
  readonly workspaceEpoch: number;
}

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
    missionId: req.missionId,
    agentName: req.pane.agentName,
    role: req.role,
    orchRequestId: req.requestId,
  };
}

function capturePresentationScope(): PresentationScope {
  return {
    workspacePath: getActiveWorkspacePath(),
    workspaceEpoch: useOrchStore.getState().workspaceEpoch,
  };
}

function isPresentationScopeCurrent(scope: PresentationScope): boolean {
  return (
    getActiveWorkspacePath() === scope.workspacePath &&
    useOrchStore.getState().workspaceEpoch === scope.workspaceEpoch
  );
}

function presentationKey(
  req: MissionPanePresentationRequest,
  scope: PresentationScope,
): string {
  return JSON.stringify([
    scope.workspacePath,
    scope.workspaceEpoch,
    req.paneId,
    req.sessionId,
  ]);
}

function isExactHealthyPresentation(
  req: MissionPanePresentationRequest,
): boolean {
  const pane = listPanes(useLayoutStore.getState().root).find(
    (candidate) => candidate.id === req.paneId,
  );
  return (
    pane?.kind === 'cli-agent' &&
    pane.missionId === req.missionId &&
    pane.role === req.role &&
    getPaneSessionId(req.paneId) === req.sessionId &&
    isPaneSessionHealthy(req.paneId, req.sessionId)
  );
}

function paneFromPresentation(
  req: MissionPanePresentationRequest,
): PaneModel {
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
    missionId: req.missionId,
    agentName: req.pane.agentName,
    role: req.role,
  };
}

async function presentLiveMainOwnedPane(
  req: MissionPanePresentationRequest,
  scope: PresentationScope,
): Promise<void> {
  if (!isPresentationScopeCurrent(scope)) return;
  const existing = listPanes(useLayoutStore.getState().root);
  const current = existing.find((pane) => pane.id === req.paneId);
  if (current && current.kind !== 'cli-agent') {
    throw new Error('main-owned pane id collides with a non-agent pane');
  }
  if (
    current &&
    ((current.missionId && current.missionId !== req.missionId) ||
      (current.role && current.role !== req.role))
  ) {
    throw new Error('main-owned pane presentation identity diverged');
  }

  // This flag asks the PTY boundary to adopt persisted Main authority. It
  // never grants a fresh renderer-authored spawn.
  markPersistedAuthorityOnSpawn(req.paneId);
  useOrchStore.getState().bindPaneMission(req.paneId, req.missionId);
  useHomeStore.getState().hide();
  if (!current) {
    useLayoutStore
      .getState()
      .setPanes([...existing, paneFromPresentation(req)]);
  }

  const sessionId = await waitForSession(
    req.paneId,
    RECOVERY_HEALTH_TIMEOUT_MS,
  );
  // Layout and terminal hosts are renderer-global. A late response from A
  // must never inspect, close or otherwise mutate a homonymous pane in B.
  if (!isPresentationScopeCurrent(scope)) return;
  if (sessionId !== req.sessionId) {
    throw new Error(
      sessionId
        ? 'main-owned pane adopted a different session'
        : 'main-owned pane presentation did not attach in time',
    );
  }
}

function requestLiveMainOwnedPanePresentation(
  req: MissionPanePresentationRequest,
): void {
  const scope = capturePresentationScope();
  if (
    !isPresentationScopeCurrent(scope) ||
    isExactHealthyPresentation(req)
  ) return;
  const key = presentationKey(req, scope);
  if (presentationInFlight.has(key)) return;
  const flight = presentLiveMainOwnedPane(req, scope)
    .catch((error) => {
      if (!isPresentationScopeCurrent(scope)) return;
      console.warn(
        `[orch-bridge] main-owned presentation failed pane=${req.paneId}:`,
        error,
      );
    })
    .finally(() => {
      if (presentationInFlight.get(key) === flight) {
        presentationInFlight.delete(key);
      }
    });
  presentationInFlight.set(key, flight);
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
        RECOVERY_HEALTH_TIMEOUT_MS,
        req.requestId,
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
      ...(replacementSessionId
        ? { sessionId: replacementSessionId }
        : {}),
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
    // First handoffs/missions payloads are snapshots — do not treat as live events.
    let handoffsPrimed = false;

    const un = [
      window.nexus.orch.onPaneSpawnRequest((req) => {
        void (async () => {
          let paneId: string | null = null;
          try {
            const existing = listPanes(useLayoutStore.getState().root).find(
              (pane) => pane.orchRequestId === req.requestId,
            );
            if (existing && existing.id !== req.paneId) {
              throw new Error(
                `Spawn retry pane id mismatch: ${existing.id} != ${req.paneId}`,
              );
            }
            paneId = existing?.id ??
              useLayoutStore.getState().spawnOrchPane({
                paneId: req.paneId,
                adapterId: req.adapterId,
                model: req.model,
                accountId: req.accountId,
                effort: req.effort,
                cwd: req.cwd,
                title: req.title,
                orchRequestId: req.requestId,
                missionId: req.missionId,
                transient: req.transient,
                agentName: req.agentName,
                role: req.role ?? 'worker',
              });
            useOrchStore.getState().bindPaneMission(paneId, req.missionId);
            const sessionId = await waitForSession(paneId, 75_000);
            if (!sessionId) {
              cleanupFailedOrchPane(req, paneId);
              window.nexus.orch.sendPaneSpawnResult({
                requestId: req.requestId,
                ok: false,
                paneId,
                error: 'session did not start (adapter missing or spawn failed)',
              });
              return;
            }
            window.nexus.orch.syncPanes(snapshotPanes());
            window.nexus.orch.sendPaneSpawnResult({
              requestId: req.requestId,
              ok: true,
              paneId,
              sessionId,
            });
          } catch (err) {
            cleanupFailedOrchPane(req, paneId);
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
            paneId = useLayoutStore
              .getState()
              .addBrowserPane(req.url, req.paneId, req.requestId);
            if (paneId !== req.paneId) {
              throw new Error('browser pane identity mismatch');
            }
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

      window.nexus.orch.onPaneCloseRequest((request) => {
        const paneId = typeof request === 'string' ? request : request.paneId;
        if (typeof request !== 'string') {
          const pane = listPanes(useLayoutStore.getState().root).find(
            (candidate) => candidate.id === request.paneId,
          );
          const ownsBrowserAttempt =
            pane?.kind === 'browser' &&
            pane.browserOpenRequestId === request.requestId;
          const ownsOrchAttempt =
            pane?.kind === 'cli-agent' &&
            pane.orchRequestId === request.requestId;
          if (!ownsBrowserAttempt && !ownsOrchAttempt) {
            return;
          }
        }
        useLayoutStore.getState().close(paneId, 'orch-close-request');
        window.nexus.orch.syncPanes(snapshotPanes());
      }),

      window.nexus.orch.onMissionsChanged((missions) => {
        const prev = useOrchStore.getState().missions;
        const prevLanes = new Map(
          prev.map((m) => [m.id, m.intentContract?.lane] as const),
        );
        useOrchStore.getState().setMissions(missions);
        // Plan-lane adoption metric (local only; seen-id dedupe + empty-prev skip).
        const metrics = usePlanLaneMetricsStore.getState();
        for (const id of newlyDispatchedPlanMissionIds(
          prevLanes,
          missions.map((m) => ({
            id: m.id,
            status: m.status,
            lane: m.intentContract?.lane,
          })),
        )) {
          metrics.notePlanDispatched(id);
        }
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
      window.nexus.orch.onHandoffsChanged((handoffs: Handoff[]) => {
        const prev = useOrchStore.getState().handoffs;
        // First payload after subscribe is a snapshot — mark ids seen, no toasts.
        if (!handoffsPrimed) {
          handoffsPrimed = true;
          usePlanLaneMetricsStore
            .getState()
            .seedSeenHandoffIds(handoffs.map((h) => h.id));
          useOrchStore.getState().setHandoffs(handoffs);
          return;
        }
        const missions = useOrchStore.getState().missions;
        const ready = detectNewPlanHandoffs(prev, handoffs, missions);
        if (ready.length > 0) notifyPlanHandoffsReady(ready);
        useOrchStore.getState().setHandoffs(handoffs);
      }),
      window.nexus.orch.onTodosChanged((lists) =>
        useOrchStore.getState().setTodoLists(lists),
      ),
      window.nexus.orch.onSquadsChanged((squads) =>
        useOrchStore.getState().setSquads(squads),
      ),
    ];
    const onPanePresentationRequest =
      window.nexus.orch.onPanePresentationRequest;
    if (onPanePresentationRequest) {
      un.push(
        onPanePresentationRequest((req) =>
          requestLiveMainOwnedPanePresentation(req),
        ),
      );
    }

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
    usePlanLaneMetricsStore.getState().hydrate();
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
