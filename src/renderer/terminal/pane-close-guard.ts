import type { PaneModel, PaneSessionState } from '../../shared/types';
import { listPanes } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { askConfirm } from '../state/confirm-store';

export function paneCloseNeedsConfirmation(
  kind: PaneModel['kind'],
  state: PaneSessionState | undefined,
): boolean {
  if (kind === 'browser') return false;
  return state === 'busy' || state === 'spawning';
}

/** Confirm da casa como default — nada de window.confirm nativo bloqueante. */
function defaultConfirmClose(message: string): Promise<boolean> {
  return askConfirm({
    title: 'Fechar pane?',
    body: message,
    confirmLabel: 'Fechar pane',
    danger: true,
  });
}

/** Guard only user-initiated closes; orchestration can still retire completed panes. */
export async function requestPaneClose(
  paneId: string,
  confirmClose: (message: string) => boolean | Promise<boolean> = defaultConfirmClose,
): Promise<boolean> {
  const layout = useLayoutStore.getState();
  const pane = listPanes(layout.root).find((candidate) => candidate.id === paneId);
  if (!pane) return false;
  // Doutrina Via Rápida (10/08): fechar UM pane fecha UM pane — inclusive de
  // missão. O ✕ de um worker derrubava a missão inteira via
  // closeMissionRuntimeAndPanes ("fechei um terminal e ela disse que deu
  // errado e fechou tudo"). O observador da missão trata o agente que saiu
  // (trabalhou = assentado; não trabalhou = respawn 1x). Encerrar a missão é
  // SÓ pelo botão Encerrar do cabeçalho.
  const state = useSessionStateStore.getState().paneStates.get(paneId);
  if (paneCloseNeedsConfirmation(pane.kind, state)) {
    const ok = await confirmClose(
      pane.kind === 'cli-agent'
        ? 'Este agente ainda está trabalhando. Fechar o pane encerra a tarefa atual. Continuar?'
        : 'Este terminal ainda tem um processo ativo. Fechar o pane encerra o processo. Continuar?',
    );
    if (!ok) return false;
    // O confirm é assíncrono: o layout pode ter mudado enquanto o dialog
    // estava aberto (pane retirado pela orquestração, fechado pelo toolbar).
    // Re-checa antes de agir — nunca fechar com base em estado velho.
    const fresh = useLayoutStore.getState();
    const still = listPanes(fresh.root).some(
      (candidate) => candidate.id === paneId,
    );
    if (!still) return false;
    fresh.close(paneId, 'user-confirm');
    return true;
  }
  layout.close(paneId, 'user');
  return true;
}
