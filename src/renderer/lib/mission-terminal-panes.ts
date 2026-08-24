import type { PaneModel } from '../../shared/types';

/**
 * Terminais da missão: só os panes DESTA missão. O layout canônico continua
 * com todos os hosts; a vista não mata PTY, só deixa de desenhar o mosaico.
 */
export function selectMissionTerminalPanes(
  panes: readonly PaneModel[],
  missionId: string | undefined,
  paneMissions: Readonly<Record<string, string>>,
): PaneModel[] {
  if (!missionId) return [...panes];
  return panes.filter(
    (pane) => (pane.missionId ?? paneMissions[pane.id]) === missionId,
  );
}
