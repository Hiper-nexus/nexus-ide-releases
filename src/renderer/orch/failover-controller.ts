import { useEffect } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from '../lib/split-tree';
import { respawnWithResume, getScrollbackExcerpt } from '../terminal/terminal-host';
import { buildContinuityPack } from './failover-continuity';
import {
  isSameAccountFailover,
  resolveContinuityMission,
} from './failover-decision';

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
        push(
          'error',
          `Limite atingido em "${event.fromAccountLabel}"`,
          `${event.reason}. Nenhuma outra conta disponível — adicione outra em Configurações → Providers.`,
        );
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
              { mode: 'same-account-resume' },
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
        push('success', 'Sessão recuperada automaticamente', event.reason);
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
