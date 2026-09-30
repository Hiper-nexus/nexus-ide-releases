/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { FailoverEvent } from '../../shared/account-types';
vi.mock('../terminal/terminal-host', () => ({ respawnWithResume: vi.fn(), getScrollbackExcerpt: () => '' }));
import { useFailoverController } from './failover-controller';
import { useToastStore } from '../state/toast-store';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Harness() { useFailoverController(); return null; }

describe('failover notifications', () => {
  it('replaces the previous retry notice for the same pane', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const base: FailoverEvent = { paneId: 'same-pane', kind: 'rate-limit', reason: 'HTTP 429', fromAccountLabel: 'Conta', toAccountLabel: '', switched: false };
    try {
      await act(async () => root.render(<Harness />));
      notify({ ...base, scheduledRetryAtMs: Date.now() + 60_000 });
      notify({ ...base, scheduledRetryAtMs: Date.now() + 120_000 });
      expect(useToastStore.getState().toasts.filter((toast) => toast.dedupeKey === 'failover:same-pane')).toHaveLength(1);
      notify(base);
      const final = useToastStore.getState().toasts.find((toast) => toast.dedupeKey === 'failover:same-pane');
      expect(final?.detail).not.toMatch(/Nova tentativa automática às/);
    } finally {
      await act(async () => root.unmount()); container.remove();
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it('erro do provider na detecção não vira toast; os desfechos viram', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const base: FailoverEvent = { paneId: 'pane-t', kind: 'transient', reason: 'HTTP 503', fromAccountLabel: 'conta adm', toAccountLabel: '', switched: false };
    try {
      await act(async () => root.render(<Harness />));
      // A CLI tenta sozinha: a detecção não pode alarmar o operador (F-222).
      notify({ ...base, transientPhase: 'detected' });
      expect(useToastStore.getState().toasts.filter((toast) => toast.dedupeKey === 'failover:pane-t')).toHaveLength(0);
      // Desfechos seguem visíveis: parada pede ação, stall avisa que segue ruim.
      notify({ ...base, transientPhase: 'stalled' });
      notify({ ...base, transientPhase: 'stopped' });
      notify({ ...base, transientPhase: 'nudged' });
      const toasts = useToastStore.getState().toasts.filter((toast) => toast.dedupeKey === 'failover:pane-t');
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toBe('Missão continuou na mesma conta');
    } finally {
      await act(async () => root.unmount()); container.remove();
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });
});
