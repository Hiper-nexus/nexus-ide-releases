import { useEffect } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from '../lib/split-tree';
import { respawnWithResume, getScrollbackExcerpt } from '../terminal/terminal-host';
import { buildContinuityPack } from './failover-continuity';
import { missionOwnsItsPanes } from '../../shared/mission-recovery-policy';
import { buildCrossAccountResumeNote } from '../../shared/failover-handoff';
import {
  isSameAccountFailover,
  resolveContinuityMission,
} from './failover-decision';
import {
  blockedFailoverToastCopy,
  cliSwitchToastCopy,
  recoveredFailoverToastCopy,
  reroutedFailoverToastCopy,
} from './failover-toast-copy';

/** F-775: o próximo passo do pacote quando a conta troca no meio da tarefa. */
const CONTINUITY_NEXT_STEP =
  'Check the touched files and the diff above (the real state of the work), then continue from the first pending step.';

/**
 * Reacts to main-process failover events.
 * Cross-account: pin + fresh session + continuity pack; when Main moved the
 * conversation to the new account (`nativeResume`, F-1473) the same
 * conversation is resumed natively with a short note, pack as fallback.
 * Same-account recovery: native resume in the same xterm.
 */
export function useFailoverController(): void {
  useEffect(() => {
    return window.nexus.accounts.onFailover((event) => {
      const push = useToastStore.getState().push;
      // F-765/F-775: o Main já reabriu a tarefa em outro pane e fechou o
      // parado — aqui não se religa nada, só se conta o que aconteceu.
      if (event.toPaneId) {
        const copy = reroutedFailoverToastCopy(event);
        push('warn', copy.title, {
          detail: copy.detail,
          dedupeKey: `failover:${event.paneId}`,
        });
        return;
      }
      // F-775: a CLI esgotou em todas as contas e o Main escolheu a próxima
      // pela rota. O pane troca de CLI no lugar, com sessão nova e o pacote
      // de continuidade, e o operador vê o aviso na hora; só o recibo diz se
      // a troca existiu.
      if (event.cliSwitchPhase) {
        const copy = cliSwitchToastCopy(event);
        const dedupeKey = `failover:${event.paneId}`;
        if (event.cliSwitchPhase === 'applied') {
          push(event.switched ? 'success' : 'error', copy.title, { detail: copy.detail, dedupeKey });
          return;
        }
        const pane = listPanes(useLayoutStore.getState().root).find(
          (p) => p.id === event.paneId,
        );
        if (!pane || !event.toAdapterId) return;
        useLayoutStore.getState().setPaneAdapter(pane.id, event.toAdapterId, event.toModel);
        const updated = listPanes(useLayoutStore.getState().root).find(
          (candidate) => candidate.id === pane.id,
        );
        if (!updated) return;
        respawnWithResume(
          updated,
          `[nexus] ${copy.title} — sessão nova com o pacote de continuidade…`,
          { mode: 'cross-account-continuity', continuityPack: event.continuityPack },
        );
        push('warn', copy.title, { detail: copy.detail, dedupeKey });
        return;
      }
      // F-765: o pedido religa; somente o recibo do Main anuncia aplicação.
      // Eventos antigos sem fase ainda pedem respawn, sem presumir sucesso.
      if (event.toModel && (event.modelRotationPhase === 'requested' || event.switched)) {
        const pane = listPanes(useLayoutStore.getState().root).find(
          (p) => p.id === event.paneId,
        );
        if (!pane) return;
        if (event.modelRotationPhase === 'applied') {
          push(
            'warn',
            `Modelo rotacionado para "${event.toModel}"`,
            `${event.reason}. A conta não foi trocada — apenas o modelo do pane.`,
          );
          return;
        }
        useLayoutStore.getState().setPaneModel(pane.id, event.toModel);
        const updated = listPanes(useLayoutStore.getState().root).find(
          (candidate) => candidate.id === pane.id,
        );
        if (updated) {
          respawnWithResume(
            updated,
            `[nexus] modelo rejeitado → religando em "${event.toModel}" (mesma conta)…`,
            { mode: 'same-account-resume' },
          );
        }
        return;
      }
      if (!event.switched) {
        if (event.missionTaskWaived) {
          push(
            'info',
            'Análise advisory dispensada',
            `${event.reason}. A missão segue sem aguardar esta task opcional.`,
          );
          return;
        }
        const copy = blockedFailoverToastCopy(event);
        // Erro do provider (5xx/capacidade): nada a fazer em Providers — é
        // aviso, não erro, e sem botão que manda o operador procurar culpa
        // na conta. 'detected' não vira toast: a CLI quase sempre se cura
        // sozinha em segundos e alarmar era ruído (F-222). Toast só nos
        // desfechos — parou, foi empurrada ou segue quebrada.
        // F-1483: a conta liberou e a missão seguiu na MESMA conversa
        // ("continue") — aviso, não erro de limite, seja qual for o tipo.
        if (event.kind === 'transient' || event.transientPhase === 'nudged') {
          if (event.transientPhase === 'detected') return;
          push(event.transientPhase === 'nudged' ? 'info' : 'warn', copy.title, {
            detail: copy.detail, dedupeKey: `failover:${event.paneId}`,
          });
          return;
        }
        // O texto já diz "Configurações → Providers" — a ação leva até lá
        // (toast com ação ganha TTL de 20s em vez de 7s).
        push('error', copy.title, {
          detail: copy.detail,
          dedupeKey: `failover:${event.paneId}`,
          action: {
            label: 'Abrir Providers',
            onClick: () =>
              useProductNavigationStore.getState().openSettings('providers'),
          },
        });
        return;
      }
      const pane = listPanes(useLayoutStore.getState().root).find(
        (p) => p.id === event.paneId,
      );
      // F-995: o Main já religou este pane (orquestrador de missão, inclusive
      // o pane do operador adotado) na conta nova — o evento é o recibo. Aqui
      // só se espelha a conta e se avisa; religar de novo derrubaria a sessão
      // que acabou de nascer.
      if (event.respawnedByMain) {
        if (pane && event.toAccountId) {
          useLayoutStore.getState().setAccountId(pane.id, event.toAccountId, pane.accountSelection);
        }
        push(
          'success',
          `Trocado para "${event.toAccountLabel}"`,
          `"${event.fromAccountLabel}" atingiu o limite (${event.reason}). ` +
            'O Nexus religou este pane na outra conta conectada, com o pacote de continuidade ' +
            '(a conta fixada esgotada não prende o pane).',
        );
        return;
      }
      // F-249: o toast de sucesso só pode sair se o pane foi encontrado e
      // religado — antes ele saía mesmo com o pane ausente da árvore (aba
      // fechada/trocada), dizendo "trocou" sem trocar nada.
      if (!pane) {
        push('warn', 'Troca de conta não aplicada', {
          detail:
            `"${event.fromAccountLabel}" reportou limite, mas o pane não está ` +
            'mais nesta janela — nada foi religado.',
          dedupeKey: `failover:${event.paneId}`,
        });
        return;
      }
      // F-1471: a conta de pane de missão viva é do Main (linha selada da
      // missão); espelhá-la aqui sem troca real deixava o layout em B e o
      // registro em A. Missão encerrada devolveu o pane: ele troca no lugar.
      const orchState = useOrchStore.getState();
      const paneMissionId = event.missionId ?? pane.missionId ?? orchState.paneMissions[pane.id];
      const owningMission = paneMissionId
        ? orchState.missions.find((mission) => mission.id === paneMissionId)
        : undefined;
      if (event.toAccountId && !(owningMission && missionOwnsItsPanes(owningMission))) {
        useLayoutStore.getState().setAccountId(pane.id, event.toAccountId, pane.accountSelection);
      }
      const updated = listPanes(useLayoutStore.getState().root).find(
        (candidate) => candidate.id === pane.id,
      );
      if (!updated) {
        push('warn', 'Troca de conta não aplicada', {
          detail:
            `"${event.fromAccountLabel}" reportou limite, mas o pane sumiu ` +
            'da árvore antes do religamento — nada foi trocado.',
          dedupeKey: `failover:${event.paneId}`,
        });
        return;
      }
      if (isSameAccountFailover(event)) {
        respawnWithResume(
          updated,
          `[nexus] ${event.reason}; retomando sessão na mesma conta…`,
          {
            mode: 'same-account-resume',
            skipContinuation: event.kind === 'auth',
          },
        );
      } else {
        const orch = useOrchStore.getState();
        const mission = resolveContinuityMission({
          paneId: updated.id,
          paneMissions: orch.paneMissions,
          missions: orch.missions,
          eventMissionId: event.missionId,
        });
        // F-775: janela/reset e estado da tarefa vêm medidos pelo Main.
        const facts = event.continuity;
        const continuityPack = buildContinuityPack({
          fromAccountLabel: event.fromAccountLabel,
          toAccountLabel: event.toAccountLabel,
          reason: event.reason,
          role: updated.role,
          missionId: mission.missionId,
          openWorkHint: mission.openWorkHint,
          scrollbackExcerpt: getScrollbackExcerpt(updated.id),
          ...(event.kind ? { limitKind: event.kind } : {}),
          limitWindow: facts?.limitWindow ?? null,
          limitResetsAt: facts?.limitResetsAt ?? event.nextUnblockAtMs ?? null,
          limitCooldownMs: facts?.limitCooldownMs ?? null,
          ...(facts?.touchedFiles ? { touchedFiles: facts.touchedFiles } : {}),
          ...(facts?.diffStat ? { diffStat: facts.diffStat } : {}),
          ...(facts?.inFlightRequest ? { inFlightRequest: facts.inFlightRequest } : {}),
          nextStep: CONTINUITY_NEXT_STEP,
        });
        respawnWithResume(
          updated,
          event.nativeResume
            ? `[nexus] limite em "${event.fromAccountLabel}" → conta "${event.toAccountLabel}" (mesma conversa)`
            : `[nexus] limite em "${event.fromAccountLabel}" → conta "${event.toAccountLabel}" (sessão nova + handoff)`,
          event.nativeResume
            ? {
                mode: 'cross-account-resume',
                continuityPack,
                resumeNote: buildCrossAccountResumeNote({
                  toAccountLabel: event.toAccountLabel,
                  role: updated.role,
                  inFlightRequest: facts?.inFlightRequest,
                }),
              }
            : {
                mode: 'cross-account-continuity',
                continuityPack,
              },
        );
      }
      if (isSameAccountFailover(event)) {
        const copy = recoveredFailoverToastCopy(event);
        push(event.kind === 'auth' ? 'warn' : 'success', copy.title, copy.detail);
        return;
      }
      const coalesceNote = event.coalesced
        ? ' (mesmo destino que outro pane na rajada)'
        : '';
      push(
        'success',
        `Trocado para "${event.toAccountLabel}"${coalesceNote}`,
        `"${event.fromAccountLabel}" atingiu o limite (${event.reason}). ` +
          (event.nativeResume
            ? 'A mesma conversa continua nesta conta.'
            : 'Histórico do terminal mantido; sessão do provider é nova nesta conta — contexto reinjetado via handoff.'),
      );
    });
  }, []);
}
