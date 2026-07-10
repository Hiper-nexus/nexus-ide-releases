import { useEffect } from 'react';
import type { PaneRegistryEntry } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { listPanes } from '../lib/split-tree';
import {
  getPaneSessionId,
  onPaneSessionChange,
  waitForSession,
} from '../terminal/terminal-host';
import { waitForBrowserPaneCreated } from '../browser/browser-host';

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

export function useOrchBridge(): void {
  const hydrate = useOrchStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();

    const un = [
      window.nexus.orch.onPaneSpawnRequest((req) => {
        void (async () => {
          try {
            const paneId = useLayoutStore.getState().spawnOrchPane({
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
            const sessionId = await waitForSession(paneId);
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
              useLayoutStore.getState().close(paneId);
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
        useLayoutStore.getState().close(paneId);
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
    window.nexus.orch.syncPanes(snapshotPanes());

    return () => {
      un.forEach((fn) => fn());
      unsubLayout();
      unsubSession();
    };
  }, [hydrate]);
}
