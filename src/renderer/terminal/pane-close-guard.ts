import type { PaneModel, PaneSessionState } from '../../shared/types';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';

export function paneCloseNeedsConfirmation(
  kind: PaneModel['kind'],
  state: PaneSessionState | undefined,
): boolean {
  if (kind === 'browser') return false;
  return state === 'busy' || state === 'spawning';
}

/** Guard only user-initiated closes; orchestration can still retire completed panes. */
export function requestPaneClose(
  paneId: string,
  confirmClose: (message: string) => boolean = window.confirm,
): boolean {
  const layout = useLayoutStore.getState();
  const pane = listPanes(layout.root).find((candidate) => candidate.id === paneId);
  if (!pane) return false;
  const state = useSessionStateStore.getState().paneStates.get(paneId);
  if (
    paneCloseNeedsConfirmation(pane.kind, state) &&
    !confirmClose(
      pane.kind === 'cli-agent'
        ? 'Este agente ainda está trabalhando. Fechar o pane encerra a tarefa atual. Continuar?'
        : 'Este terminal ainda tem um processo ativo. Fechar o pane encerra o processo. Continuar?',
    )
  ) {
    return false;
  }
  layout.close(paneId);
  return true;
}
