import type { MissionRuntimeCloseResult } from '../../shared/orch-types';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';

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
 * Close one mission's physical runtime through main authority, then remove any
 * remaining renderer leaves for that mission. Durable mission history remains.
 */
export async function closeMissionRuntimeAndPanes(
  missionId: string,
  reason = 'mission-runtime-close',
): Promise<MissionRuntimeCloseResult> {
  let result: MissionRuntimeCloseResult;
  try {
    result = await window.nexus.orch.closeMissionRuntime(missionId);
  } catch (error) {
    // Authority fences (scope change, runtime changed under the modal) reject
    // the IPC. Surfacing them as a result keeps the caller's busy state
    // recoverable instead of freezing the mission list on a dangling promise.
    return {
      ok: false,
      terminatedSessionIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!result.ok) return result;

  const layout = useLayoutStore.getState();
  const paneMissions = useOrchStore.getState().paneMissions;
  const paneIds = listPanes(layout.root)
    .filter(
      (pane) => (pane.missionId ?? paneMissions[pane.id]) === missionId,
    )
    .map((pane) => pane.id);
  for (const paneId of paneIds) {
    useLayoutStore.getState().close(paneId, reason);
  }
  return result;
}
