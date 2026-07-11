import { useEffect } from 'react';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { listPanes } from '../lib/split-tree';
import { respawnWithResume } from '../terminal/terminal-host';

/**
 * Reacts to main-process failover events: when an account hits its limit and
 * the engine switched to another, re-spawn the pane's CLI with --resume so the
 * conversation continues seamlessly on the new account. Shows a toast either
 * way (switched, or "no account left").
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
          const recovery = event.fromAccountLabel === event.toAccountLabel;
          respawnWithResume(
            updated,
            recovery
              ? `[nexus] ${event.reason}; retomando sessão…`
              : '[nexus] limite atingido — trocando de conta e retomando…',
          );
        }
      }
      if (event.fromAccountLabel === event.toAccountLabel) {
        push('success', 'Sessão recuperada automaticamente', event.reason);
        return;
      }
      push(
        'success',
        `Trocado para "${event.toAccountLabel}"`,
        `"${event.fromAccountLabel}" atingiu o limite (${event.reason}) — retomando a conversa na nova conta.`,
      );
    });
  }, []);
}
