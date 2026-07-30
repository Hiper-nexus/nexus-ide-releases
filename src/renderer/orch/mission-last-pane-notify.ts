import type { PaneModel } from '../../shared/types';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';

/**
 * Fechar o ÚLTIMO pane de uma missão viva não pode fazê-la sumir: o runtime
 * segue Main-owned em segundo plano e o único caminho de volta era o discreto
 * "Retomar panes salvos" do card da missão — quase ninguém descobria. Quando o
 * último pane sai do grid (fechamento do operador OU aposentadoria pelo
 * runtime), um toast acionável devolve a missão pela MESMA rota do card
 * (confirmAndReopenMission → apresentação Main-owned, nada novo é spawnado).
 *
 * O toast cavalga sobre a proteção de janela-preta do layout-store: o Home
 * continua aparecendo quando nada resta na tela — o aviso fica por cima.
 */

/**
 * Motivos de fechamento que JÁ encerraram o runtime da missão pela autoridade
 * do main (closeMissionRuntimeAndPanes). Nesses fluxos o orch-store ainda lê
 * `running` até o broadcast de missões chegar, então o motivo é a única fonte
 * confiável para não anunciar uma missão que o operador acabou de encerrar.
 */
const MISSION_TERMINATING_REASONS = new Set([
  'pane-toolbar-close',
  'mission-rail-close',
  'ops-board-close',
  'orch-panel-close',
  'mission-runtime-close',
]);

function missionIdOfPane(
  pane: PaneModel,
  paneMissions: Record<string, string>,
): string | undefined {
  return pane.missionId ?? paneMissions[pane.id];
}

/**
 * Chamado pelo layout-store.close DEPOIS da remoção. Dispara o toast somente
 * quando o pane fechado era o último visível de uma missão ainda `running`.
 */
export function notifyIfLastMissionPaneClosed(
  closedPane: PaneModel,
  reason: string | undefined,
  remainingPanes: PaneModel[],
): void {
  if (reason && MISSION_TERMINATING_REASONS.has(reason)) return;
  const orch = useOrchStore.getState();
  const missionId = missionIdOfPane(closedPane, orch.paneMissions);
  if (!missionId) return;
  const mission = orch.missions.find((entry) => entry.id === missionId);
  if (!mission || mission.status !== 'running') return;
  const stillOpen = remainingPanes.some(
    (pane) => missionIdOfPane(pane, orch.paneMissions) === missionId,
  );
  if (stillOpen) return;

  useToastStore.getState().push('info', 'Missão continua em execução', {
    detail: `"${mission.title}" segue rodando em segundo plano, sem nenhum pane aberto.`,
    dedupeKey: `mission-last-pane-closed:${missionId}`,
    action: {
      label: 'Reabrir panes',
      onClick: async () => {
        // Import dinâmico: quebra o ciclo layout-store → reopen → layout-store.
        const { confirmAndReopenMission } = await import(
          './confirm-reopen-mission'
        );
        const fresh = useOrchStore
          .getState()
          .missions.find((entry) => entry.id === missionId);
        if (!fresh) return;
        const result = await confirmAndReopenMission(fresh);
        if (!result.ok && result.error) {
          useToastStore
            .getState()
            .push('error', 'Não deu pra reabrir os panes', result.error);
        }
      },
    },
  });
}
