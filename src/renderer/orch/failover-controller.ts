import { useEffect } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from '../lib/split-tree';
import { respawnWithResume, getScrollbackExcerpt } from '../terminal/terminal-host';
import {
  buildContinuityPack,
} from './failover-continuity';

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
          const sameAccount =
            event.crossAccount === false ||
            event.fromAccountLabel === event.toAccountLabel;
          if (sameAccount) {
            respawnWithResume(
              updated,
              `[nexus] ${event.reason}; retomando sessão na mesma conta…`,
              { mode: 'same-account-resume' },
            );
          } else {
            const missions = useOrchStore.getState().missions;
            const openMissions = missions
              .filter((m) => m.status === 'running' || m.status === 'blocked')
              .slice(0, 3);
            const open = openMissions
              .map((m) => `${m.id}${m.title ? `: ${m.title}` : ''}`)
              .join('; ');
            const continuityPack = buildContinuityPack({
              fromAccountLabel: event.fromAccountLabel,
              toAccountLabel: event.toAccountLabel,
              reason: event.reason,
              role: updated.role,
              missionId: openMissions[0]?.id,
              openWorkHint: open || undefined,
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
      if (
        event.crossAccount === false ||
        event.fromAccountLabel === event.toAccountLabel
      ) {
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
