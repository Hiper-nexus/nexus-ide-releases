import { useEffect } from 'react';
import type { PaneRegistryEntry } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from '../lib/split-tree';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Renderer half of the orchestration bridge:
 *  - answers main-process pane spawn/close requests (the renderer owns the
 *    layout tree, so panes must be created here);
 *  - mirrors the pane set (paneId ↔ sessionId ↔ metadata) into the main
 *    process registry that backs nexus_pane_list / nexus_pane_read;
 *  - keeps the orchestration store hydrated via change events.
 */

const SESSION_POLL_MS = 150;
const SESSION_POLL_TIMEOUT_MS = 20_000;
const SYNC_INTERVAL_MS = 1_000;

function snapshotPanes(): PaneRegistryEntry[] {
  const { root } = useLayoutStore.getState();
  return listPanes(root).map((pane) => ({
    paneId: pane.id,
    sessionId: getPaneSessionId(pane.id),
    title: pane.title,
    kind: pane.kind,
    adapterId: pane.adapterId,
    model: pane.model,
  }));
}

/** Wait for the pane's PTY session to materialize (spawn is async). */
function waitForSession(paneId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      const sessionId = getPaneSessionId(paneId);
      if (sessionId) {
        resolve(sessionId);
        return;
      }
      if (Date.now() - startedAt > SESSION_POLL_TIMEOUT_MS) {
        resolve(null);
        return;
      }
      setTimeout(poll, SESSION_POLL_MS);
    };
    poll();
  });
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

      window.nexus.orch.onPaneCloseRequest((paneId) => {
        useLayoutStore.getState().close(paneId);
        window.nexus.orch.syncPanes(snapshotPanes());
      }),

      window.nexus.orch.onMissionsChanged((missions) =>
        useOrchStore.getState().setMissions(missions),
      ),
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

    // Pane mirror: push on every layout change and on a slow heartbeat (the
    // heartbeat catches sessionIds that resolve after the layout settled).
    const unsubLayout = useLayoutStore.subscribe(() => {
      window.nexus.orch.syncPanes(snapshotPanes());
    });
    const interval = setInterval(
      () => window.nexus.orch.syncPanes(snapshotPanes()),
      SYNC_INTERVAL_MS,
    );
    window.nexus.orch.syncPanes(snapshotPanes());

    return () => {
      un.forEach((fn) => fn());
      unsubLayout();
      clearInterval(interval);
    };
  }, [hydrate]);
}
