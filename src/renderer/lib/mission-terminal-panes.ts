import type { PaneModel } from '../../shared/types';
import { missionScopeKey } from './pane-spaces';

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
  return panes.filter((pane) => {
    // F-231: o pane "solto" que o operador abriu com "+ Pane → Nesta aba"
    // carimba a casa persistida — a aba continua mostrando-o depois do
    // restart, sem que ele vire participante da missão.
    if (pane.homeScopeKey === missionScopeKey(missionId)) return true;
    if (pane.kind === 'shell') return false;
    return (pane.missionId ?? paneMissions[pane.id]) === missionId;
  });
}
