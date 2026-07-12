import { useEffect, useRef } from 'react';
import { useAccountStore } from '../state/account-store';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { listPanes } from '../lib/split-tree';
import { respawnWithResume } from '../terminal/terminal-host';

/**
 * Orca-style restart follow-up after account hot-swap: toast + optional bulk
 * restart of CLI panes for that adapter. Existing sessions keep the old
 * credential until restarted.
 */
export function useAccountRestartController(): void {
  const restartAdapterId = useAccountStore((s) => s.restartAdapterId);
  const restartLabel = useAccountStore((s) => s.restartLabel);
  const lastToastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!restartAdapterId) {
      lastToastKey.current = null;
      return;
    }
    const key = `${restartAdapterId}:${restartLabel ?? ''}`;
    if (lastToastKey.current === key) return;
    lastToastKey.current = key;
    useToastStore.getState().push(
      'info',
      `Conta "${restartLabel ?? restartAdapterId}" ativa`,
      'Sessões já abertas mantêm a conta antiga. Use ↻ nos panes unpinned (ou o botão na bar) para aplicar o hot-swap — pins explícitos de outras contas não são alterados.',
    );
  }, [restartAdapterId, restartLabel]);
}

/**
 * Restart cli-agent panes for the pending adapter without destroying pins.
 * - Unpinned panes → pin to the new active account and respawn
 * - Panes already on the new active account → respawn only
 * - Panes pinned to a different account → leave alone
 */
export function restartPanesForPendingAccount(): number {
  const { restartAdapterId, clearRestartNotice, accounts } =
    useAccountStore.getState();
  if (!restartAdapterId) return 0;
  const active = accounts.find(
    (a) => a.adapterId === restartAdapterId && a.active,
  );
  const panes = listPanes(useLayoutStore.getState().root).filter(
    (p) => p.kind === 'cli-agent' && p.adapterId === restartAdapterId,
  );

  let restarted = 0;
  for (const pane of panes) {
    const pinned = pane.accountId;
    // Preserve explicit multi-account pins that are not the new active.
    if (pinned && active && pinned !== active.id) {
      continue;
    }
    if (active && !pinned) {
      useLayoutStore.getState().setAccountId(pane.id, active.id);
    }
    const updated = listPanes(useLayoutStore.getState().root).find(
      (p) => p.id === pane.id,
    );
    if (updated) {
      respawnWithResume(
        updated,
        `[nexus] conta trocada → "${active?.label ?? restartAdapterId}" — reiniciando…`,
      );
      restarted += 1;
    }
  }
  clearRestartNotice();
  if (restarted > 0) {
    useToastStore.getState().push(
      'success',
      'Panes reiniciados',
      `${restarted} sessão(ões) ${restartAdapterId} na conta ativa (pins de outras contas preservados).`,
    );
  } else {
    useToastStore.getState().push(
      'info',
      'Nenhum pane reiniciado',
      'Todos os panes deste provider estão pinados em outras contas, ou não há panes abertos.',
    );
  }
  return restarted;
}
