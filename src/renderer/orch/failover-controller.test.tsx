/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { FailoverEvent } from '../../shared/account-types';
vi.mock('../terminal/terminal-host', () => ({ respawnWithResume: vi.fn(), getScrollbackExcerpt: () => '' }));
import { useFailoverController } from './failover-controller';
import { useToastStore } from '../state/toast-store';
import { useLayoutStore } from '../state/layout-store';
import { respawnWithResume } from '../terminal/terminal-host';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Harness() { useFailoverController(); return null; }

describe('failover notifications', () => {
  it('religa no pedido de rotação e anuncia somente o recibo aplicado, sem novo respawn', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'rotation-leaf', pane: {
      id: 'model-pane', kind: 'cli-agent', title: 'Codex', adapterId: 'codex', model: 'rejected',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const base: FailoverEvent = { paneId: 'model-pane', kind: 'model', reason: 'modelo rejeitado', fromAccountLabel: 'Conta', toAccountLabel: 'Conta', switched: false, toModel: 'eligible' };
    try {
      await act(async () => root.render(<Harness />));
      notify({ ...base, modelRotationPhase: 'requested' });
      expect(respawnWithResume).toHaveBeenCalledTimes(1);
      expect(respawnWithResume).toHaveBeenCalledWith(expect.objectContaining({ model: 'eligible' }), expect.any(String), { mode: 'same-account-resume' });
      expect(useToastStore.getState().toasts).toHaveLength(0);
      notify({ ...base, switched: true, modelRotationPhase: 'applied' });
      expect(respawnWithResume).toHaveBeenCalledTimes(1);
      expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['Modelo rotacionado para "eligible"']);
    } finally {
      await act(async () => root.unmount()); container.remove();
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it('tarefa reaberta pelo Main em outro pane: só avisa, nunca religa o pane antigo (F-765)', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'reroute-leaf', pane: {
      id: 'mission-pane', kind: 'cli-agent', title: 'Codex', adapterId: 'codex', model: 'gpt-6.1-sol',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({
        paneId: 'mission-pane', kind: 'model', switched: true, fromAccountLabel: 'Conta', toAccountLabel: '',
        reason: 'modelo "gpt-6.1-sol" recusado → tarefa reaberta em codex (pane pane-novo)',
        fromAdapterId: 'codex', toAdapterId: 'codex', toPaneId: 'pane-novo',
      });
      expect(respawnWithResume).not.toHaveBeenCalled();
      const toast = useToastStore.getState().toasts.find((entry) => entry.dedupeKey === 'failover:mission-pane');
      expect(toast?.title).toBe('Tarefa reaberta em codex');
      expect(toast?.detail).toContain('pane-novo');
    } finally {
      await act(async () => root.unmount()); container.remove();
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it('recibo aplicado sem troca comprovada não anuncia sucesso nem religa', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({ paneId: 'model-pane', kind: 'model', reason: 'spawn falhou', fromAccountLabel: 'Conta', toAccountLabel: 'Conta', switched: false, toModel: 'eligible', modelRotationPhase: 'applied' });
      expect(respawnWithResume).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toHaveLength(1);
      expect(useToastStore.getState().toasts[0].kind).toBe('error');
    } finally {
      await act(async () => root.unmount()); container.remove();
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

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
