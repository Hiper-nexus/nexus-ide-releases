import type { PaneModel } from '../../shared/types';
import type { Mission } from '../../shared/orch-types';
import { missionAwaitsAdjustment } from '../../shared/mission-recovery-policy';
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
 * O toast cavalga sobre a superfície atual: fechar o pane não altera o destino
 * do produto, e Terminal exibe sua vaga estrutural por baixo do aviso.
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
  'mission-board-close',
  'orch-panel-close',
  'mission-runtime-close',
  'last-pane-closed',
]);

/**
 * Fechamentos iniciados pelo OPERADOR (✕ do pane, com ou sem confirm). Só
 * eles encerram a missão junto com o último pane — aposentadoria pelo
 * runtime (worker-ttl, substituição) não é decisão humana e mantém a missão
 * viva em segundo plano com o toast de reabertura.
 */
const OPERATOR_CLOSE_REASONS = new Set(['user', 'user-confirm']);

/**
 * Substituição, não perda: o pane novo do mesmo papel nasce no mesmo tick
 * (spawn do orquestrador aposentando o cadáver restaurado do boot). Anunciar
 * "missão sem nenhum pane" aqui é ruído — o successor já está na tela.
 */
const PANE_REPLACEMENT_REASONS = new Set(['orchestrator-replaced']);

const pendingRuntimeCloses = new Map<string, number>();

function closeNotificationKey(missionId: string): string {
  return `${useOrchStore.getState().workspaceEpoch}:${missionId}`;
}

/** Main can emit pane-close before its shutdown reply and mission broadcast. */
export function suppressPendingMissionCloseNotice(missionId: string): () => void {
  const key = closeNotificationKey(missionId);
  pendingRuntimeCloses.set(key, (pendingRuntimeCloses.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pendingRuntimeCloses.get(key) ?? 1) - 1;
    if (remaining > 0) pendingRuntimeCloses.set(key, remaining);
    else pendingRuntimeCloses.delete(key);
  };
}

function missionIdOfPane(
  pane: PaneModel,
  paneMissions: Record<string, string>,
): string | undefined {
  return pane.missionId ?? paneMissions[pane.id];
}

/**
 * A missão `running` que perde o ÚLTIMO pane visível com o fechamento de
 * `closedPane`, ou `undefined`. Predicado único do aviso pós-fechamento e do
 * texto do Fechar na toolbar.
 */
function runningMissionLosingLastPane(
  closedPane: PaneModel,
  remainingPanes: PaneModel[],
  missions: Mission[],
  paneMissions: Record<string, string>,
): Mission | undefined {
  const missionId = missionIdOfPane(closedPane, paneMissions);
  if (!missionId) return undefined;
  const mission = missions.find((entry) => entry.id === missionId);
  if (!mission || mission.status !== 'running') return undefined;
  const stillOpen = remainingPanes.some(
    (pane) => missionIdOfPane(pane, paneMissions) === missionId,
  );
  return stillOpen ? undefined : mission;
}

/**
 * Fechar `closedPane` pelo ✕ do operador encerra a missão (ordem de 20/08)?
 * Verdadeiro só para o último pane de uma missão `running` que não espera o
 * humano — o mesmo caminho de `notifyIfLastMissionPaneClosed`.
 */
export function closingPaneEndsMission(
  closedPane: PaneModel,
  remainingPanes: PaneModel[],
  missions: Mission[],
  paneMissions: Record<string, string>,
): boolean {
  const mission = runningMissionLosingLastPane(closedPane, remainingPanes, missions, paneMissions);
  return mission !== undefined && !missionAwaitsAdjustment(mission);
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
  if (
    reason &&
    (MISSION_TERMINATING_REASONS.has(reason) ||
      PANE_REPLACEMENT_REASONS.has(reason))
  ) {
    return;
  }
  const orch = useOrchStore.getState();
  const missionId = missionIdOfPane(closedPane, orch.paneMissions);
  if (!missionId) return;
  if (pendingRuntimeCloses.has(closeNotificationKey(missionId))) return;
  const mission = runningMissionLosingLastPane(
    closedPane,
    remainingPanes,
    orch.missions,
    orch.paneMissions,
  );
  if (!mission) return;

  if (reason && OPERATOR_CLOSE_REASONS.has(reason)) {
    // ✕ num pane de missão que AINDA espera o humano (Aguardando você /
    // Pedir um ajuste / Precisa de você) não pode Encerrar nem Reabrir:
    // o diálogo nativo cancela no default e o watcher respawna o time
    // inteiro (bug de campo 24/08). Fechar UM pane fecha UM pane.
    if (missionAwaitsAdjustment(mission)) {
      return;
    }
    // Ordem do operador (20/08): fechar o último pane É encerrar a missão —
    // nada de "segue rodando em segundo plano" com revival surpresa depois.
    void (async () => {
      const { closeMissionRuntimeAndPanes, closeMissionNote } = await import(
        './close-mission-runtime'
      );
      const result = await closeMissionRuntimeAndPanes(
        missionId,
        'last-pane-closed',
      );
      const toast = useToastStore.getState();
      if (result.ok) {
        toast.push('info', 'Missão encerrada', {
          detail: `"${mission.title}": ${closeMissionNote(
            result.terminatedSessionIds.length,
          )}`,
          dedupeKey: `mission-last-pane-closed:${missionId}`,
        });
      } else {
        toast.push('error', 'Não deu pra encerrar a missão', {
          detail:
            result.error ?? 'Tente pelo botão Encerrar no Quadro da missão.',
          dedupeKey: `mission-last-pane-closed:${missionId}`,
        });
      }
    })();
    return;
  }

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
