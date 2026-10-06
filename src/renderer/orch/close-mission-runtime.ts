import type { MissionRuntimeCloseResult } from '../../shared/orch-types';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { suppressPendingMissionCloseNotice } from './mission-last-pane-notify';

const MISSION_CLOSE_UI_TIMEOUT_MS = 15_000;

/**
 * Truthful operator feedback: "encerrada" must not imply processes were killed
 * when none were left, otherwise a no-op reads exactly like a real shutdown.
 */
export function closeMissionNote(terminatedCount: number): string {
  if (terminatedCount === 0) {
    return 'Missão encerrada — nenhum processo restava vivo. Histórico preservado.';
  }
  const plural = terminatedCount === 1 ? 'sessão encerrada' : 'sessões encerradas';
  return `Missão encerrada: ${terminatedCount} ${plural}. Histórico preservado; você pode retomar depois.`;
}

/**
 * Main already reports that there is no live mission runtime to tear down —
 * typically the mission row is gone or already `done`. Keeping the renderer
 * leaves would trap the operator behind Fechar that can never succeed.
 */
export function isOrphanMissionPaneSweep(result: MissionRuntimeCloseResult): boolean {
  if (result.ok) return false;
  const error = (result.error ?? '').trim();
  return /(?:^|:\s*)(?:mission not found|Missão não encontrada\.?|Missão concluída não possui execução encerrável\.?|A missão desapareceu durante o encerramento\.?)$/iu.test(
    error,
  );
}

function sweepMissionPanes(missionId: string, reason: string): void {
  const layout = useLayoutStore.getState();
  const orch = useOrchStore.getState();
  const panes = listPanes(layout.root);
  const paneIds = panes
    .filter(
      (pane) => (pane.missionId ?? orch.paneMissions[pane.id]) === missionId,
    )
    .map((pane) => pane.id);
  for (const paneId of paneIds) {
    useLayoutStore.getState().close(paneId, reason);
  }
  orch.pruneMissionBindings(
    new Set(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id),
    ),
  );
}

/**
 * Close one mission's physical runtime through main authority, then remove any
 * remaining renderer leaves for that mission. Durable mission history remains.
 *
 * When main says the mission is already gone/done, still sweep orphan leaves so
 * Fechar cannot leave zombie panes after the rail shows 0 missões.
 */
export async function closeMissionRuntimeAndPanes(
  missionId: string,
  reason = 'mission-runtime-close',
): Promise<MissionRuntimeCloseResult> {
  const workspace = useWorkspaceStore.getState().current;
  const isCurrentWorkspace = () => useWorkspaceStore.getState().current === workspace;
  let result: MissionRuntimeCloseResult;
  const releaseNoticeSuppression = suppressPendingMissionCloseNotice(missionId);
  try {
    const close = window.nexus.orch.closeMissionRuntime(missionId);
    // A UI timeout does not end Main's shutdown. Keep the notice suppressed
    // until the actual reply (including cancellation/failure), not Promise.race.
    void close.then(releaseNoticeSuppression, releaseNoticeSuppression);
    let didTimeOut = false;
    void close.then(
      (lateResult) => {
        if (
          didTimeOut && isCurrentWorkspace() &&
          (lateResult.ok || isOrphanMissionPaneSweep(lateResult))
        ) {
          sweepMissionPanes(missionId, reason);
        }
      },
      () => undefined,
    );
    result = await Promise.race([
      close,
      new Promise<MissionRuntimeCloseResult>((resolve) => {
        const timer = setTimeout(() => {
          didTimeOut = true;
          resolve({
            ok: false,
            terminatedSessionIds: [],
            error:
              'Encerramento iniciado. O Nexus continua comprovando a saída ' +
              'dos processos em segundo plano.',
          });
        }, MISSION_CLOSE_UI_TIMEOUT_MS);
        void close.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      }),
    ]);
  } catch (error) {
    releaseNoticeSuppression();
    // Authority fences (scope change, runtime changed under the modal) reject
    // the IPC. Surfacing them as a result keeps the caller's busy state
    // recoverable instead of freezing the mission list on a dangling promise.
    result = {
      ok: false,
      terminatedSessionIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isCurrentWorkspace()) {
    return { ...result, ok: false, error: 'O projeto mudou durante o encerramento. A grade atual foi preservada.' };
  }
  if (!result.ok && !isOrphanMissionPaneSweep(result)) {
    return result;
  }

  sweepMissionPanes(missionId, reason);

  if (result.ok) return result;
  return {
    ok: true,
    ...(result.mission ? { mission: result.mission } : {}),
    terminatedSessionIds: result.terminatedSessionIds,
  };
}
