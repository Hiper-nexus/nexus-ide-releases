import { useEffect } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from '../lib/split-tree';
import { respawnWithResume, getScrollbackExcerpt } from '../terminal/terminal-host';
import { buildContinuityPack } from './failover-continuity';
import {
  isSameAccountFailover,
  resolveContinuityMission,
} from './failover-decision';
import {
  blockedFailoverToastCopy,
  recoveredFailoverToastCopy,
} from './failover-toast-copy';

/**
 * Reacts to main-process failover events.
 * Cross-account: pin + fresh session + continuity pack (no native --resume).
 * Same-account recovery: native resume in the same xterm.
 */
export function useFailoverController(): void {
  useEffect(() => {
    return window.nexus.accounts.onFailover((event) => {
      const push = useToastStore.getState().push;
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
        if (event.kind === 'transient') {
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
      // Rotação de MODELO (F-520): a conta está sadia — aplica o modelo
      // alternativo escolhido pelo main no pane e religa na MESMA conta,
      // sem handoff de credencial nem continuity pack. O toast de sucesso
      // só existe se o pane foi encontrado e religado de fato (evento pode
      // chegar em janela de outro project-scope que não possui o pane).
      if (event.toModel) {
        const pane = listPanes(useLayoutStore.getState().root).find(
          (p) => p.id === event.paneId,
        );
        if (pane) {
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
            push(
              'warn',
              `Modelo rotacionado para "${event.toModel}"`,
              `${event.reason}. A conta não foi trocada — apenas o modelo do pane.`,
            );
          }
        }
        return;
      }
      const pane = listPanes(useLayoutStore.getState().root).find(
        (p) => p.id === event.paneId,
      );
      if (pane) {
        if (event.toAccountId) {
          useLayoutStore.getState().setAccountId(pane.id, event.toAccountId);
        }
        const updated = listPanes(useLayoutStore.getState().root).find(
          (candidate) => candidate.id === pane.id,
        );
        if (updated) {
          const sameAccount = isSameAccountFailover(event);
          if (sameAccount) {
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
            const continuityPack = buildContinuityPack({
              fromAccountLabel: event.fromAccountLabel,
              toAccountLabel: event.toAccountLabel,
              reason: event.reason,
              role: updated.role,
              missionId: mission.missionId,
              openWorkHint: mission.openWorkHint,
              scrollbackExcerpt: getScrollbackExcerpt(updated.id),
            });
            respawnWithResume(
              updated,
              `[nexus] limite em "${event.fromAccountLabel}" → conta "${event.toAccountLabel}" (sessão nova + handoff)`,
              {
                mode: 'cross-account-continuity',
                continuityPack,
              },
            );
          }
        }
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
          'Histórico do terminal mantido; sessão do provider é nova nesta conta — contexto reinjetado via handoff.',
      );
    });
  }, []);
}
