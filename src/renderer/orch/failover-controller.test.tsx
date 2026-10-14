/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { FailoverEvent } from '../../shared/account-types';
vi.mock('../terminal/terminal-host', () => ({ respawnWithResume: vi.fn(), getScrollbackExcerpt: () => '' }));
import { useFailoverController } from './failover-controller';
import { useToastStore } from '../state/toast-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { respawnWithResume } from '../terminal/terminal-host';
import { listPanes } from '../lib/split-tree';
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

  it('F-775: CLI esgotada no "+ Pane": troca a CLI do pane no lugar, religa com o pacote e avisa na hora', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'cli-leaf', pane: {
      id: 'op-pane', kind: 'cli-agent', title: 'Refatorar login', adapterId: 'claude', accountId: 'claude-a',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const base: FailoverEvent = {
      paneId: 'op-pane', kind: 'quota', fromAccountLabel: 'Conta', toAccountLabel: '',
      reason: 'Claude esgotou em todas as contas; continuando em Codex (quota)', switched: false,
      fromAdapterId: 'claude', fromAdapterLabel: 'Claude', toAdapterId: 'codex', toAdapterLabel: 'Codex',
      toModel: 'gpt-6.1-sol',
    };
    try {
      await act(async () => root.render(<Harness />));
      notify({ ...base, cliSwitchPhase: 'requested', continuityPack: '[NEXUS FAILOVER HANDOFF]\nExecute the next concrete step now.' });
      const pane = listPanes(useLayoutStore.getState().root).find((entry) => entry.id === 'op-pane')!;
      expect(pane).toMatchObject({ adapterId: 'codex', model: 'gpt-6.1-sol' });
      expect(pane.accountId).toBeUndefined();
      expect(respawnWithResume).toHaveBeenCalledTimes(1);
      expect(respawnWithResume).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'op-pane', adapterId: 'codex' }),
        expect.stringContaining('Claude esgotou em todas as contas; continuando em Codex'),
        { mode: 'cross-account-continuity', continuityPack: '[NEXUS FAILOVER HANDOFF]\nExecute the next concrete step now.' },
      );
      const toast = () => useToastStore.getState().toasts.find((entry) => entry.dedupeKey === 'failover:op-pane');
      expect(toast()?.title).toBe('Claude esgotou em todas as contas; continuando em Codex');
      // O recibo não religa de novo: só confirma (ou diz que não trocou).
      notify({ ...base, cliSwitchPhase: 'applied', switched: true });
      expect(respawnWithResume).toHaveBeenCalledTimes(1);
      expect(toast()?.kind).toBe('success');
      notify({ ...base, cliSwitchPhase: 'applied', switched: false, reason: 'o pane não religou' });
      expect(toast()?.kind).toBe('error');
      expect(toast()?.title).toBe('Troca de Claude para Codex não aplicada');
    } finally {
      await act(async () => root.unmount()); container.remove();
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it('F-775: troca de conta passa ao pacote a janela, os arquivos e o diff medidos pelo Main', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'acct-leaf', pane: {
      id: 'acct-pane', kind: 'cli-agent', title: 'Claude', adapterId: 'claude', accountId: 'claude-a',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({
        paneId: 'acct-pane', kind: 'rate-limit', switched: true, crossAccount: true,
        fromAccountLabel: 'gustavo@example.com', toAccountLabel: 'ana@example.org',
        fromAccountId: 'claude-a', toAccountId: 'claude-b', reason: "You've hit your session limit",
        continuity: {
          limitWindow: '5 Horas', limitResetsAt: Date.UTC(2026, 9, 3, 20, 0, 0), limitCooldownMs: 18_000_000,
          touchedFiles: ['src/login.ts'], diffStat: 'src/login.ts | 4 ++--',
        },
      });
      const [, , options] = vi.mocked(respawnWithResume).mock.calls[0]!;
      const pack = options?.continuityPack ?? '';
      expect(pack).toContain('kind rate-limit');
      expect(pack).toContain('window 5 Horas');
      expect(pack).toContain('resets 2026-10-03T20:00:00.000Z');
      expect(pack).toContain('- src/login.ts');
      expect(pack).toContain('src/login.ts | 4 ++--');
      expect(pack).toContain('Next step:');
    } finally {
      await act(async () => root.unmount()); container.remove();
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it.each([
    ['nativeResume: retoma a MESMA conversa com a nota curta (pacote só de fallback)', true],
    ['sem nativeResume: sessão nova + pacote, como antes', false],
  ])('F-1473: troca de conta Claude A → B — %s', async (_label, nativeResume) => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'resume-leaf', pane: {
      id: 'resume-pane', kind: 'cli-agent', title: 'Claude', adapterId: 'claude', accountId: 'claude-a',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({
        paneId: 'resume-pane', kind: 'rate-limit', switched: true, crossAccount: true,
        fromAccountLabel: 'gustavo@example.com', toAccountLabel: 'ana@example.org',
        fromAccountId: 'claude-a', toAccountId: 'claude-b', reason: "You've hit your session limit",
        ...(nativeResume ? { nativeResume: true } : {}),
      });
      expect(respawnWithResume).toHaveBeenCalledTimes(1);
      const [pane, , options] = vi.mocked(respawnWithResume).mock.calls[0]!;
      expect(pane.accountId).toBe('claude-b');
      expect(options?.continuityPack).toContain('[NEXUS FAILOVER HANDOFF]');
      if (nativeResume) {
        expect(options?.mode).toBe('cross-account-resume');
        expect(options?.resumeNote).toContain('resumed THIS SAME conversation');
        expect(options?.resumeNote).not.toContain('NEW provider session');
        expect(options?.resumeNote).not.toContain('ana@example.org');
      } else {
        expect(options?.mode).toBe('cross-account-continuity');
        expect(options?.resumeNote).toBeUndefined();
      }
      const toast = useToastStore.getState().toasts.find((entry) => entry.title.startsWith('Trocado para'));
      expect(toast?.detail).toContain(nativeResume ? 'A mesma conversa continua' : 'sessão do provider é nova');
    } finally {
      await act(async () => root.unmount()); container.remove();
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it.each([false, true])('F-1482: o pedido em voo medido pelo Main vai no pacote e na nota (nativeResume=%s)', async (nativeResume) => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'inflight-leaf', pane: {
      id: 'inflight-pane', kind: 'cli-agent', title: 'Claude', adapterId: 'claude', accountId: 'claude-a',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({
        paneId: 'inflight-pane', kind: 'rate-limit', switched: true, crossAccount: true,
        fromAccountLabel: 'gustavo@example.com', toAccountLabel: 'ana@example.org',
        fromAccountId: 'claude-a', toAccountId: 'claude-b', reason: "You've hit your session limit",
        continuity: { inFlightRequest: 'Trocar o login para OAuth' },
        ...(nativeResume ? { nativeResume: true } : {}),
      });
      const [, , options] = vi.mocked(respawnWithResume).mock.calls[0]!;
      expect(options?.continuityPack).toContain('Request in flight (last delivered to this pane; finish it if it is not done): Trocar o login para OAuth');
      if (nativeResume) expect(options?.resumeNote).toContain('Request in flight: Trocar o login para OAuth');
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

  it('F-1471: a conta de pane de missão viva é do Main — o renderer não a muda; pane do operador e pane de missão encerrada seguem mudando', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'split', id: 'split-1471', direction: 'row', children: [
      { kind: 'leaf', id: 'leaf-mission', pane: {
        id: 'mission-worker', kind: 'cli-agent', title: 'Claude', adapterId: 'claude',
        accountId: 'claude-a', role: 'worker', missionId: 'mission-1471',
      } },
      { kind: 'split', id: 'split-1471-b', direction: 'column', children: [
        { kind: 'leaf', id: 'leaf-op', pane: {
          id: 'op-pane-1471', kind: 'cli-agent', title: 'Claude', adapterId: 'claude', accountId: 'claude-a',
        } },
        { kind: 'leaf', id: 'leaf-ended', pane: {
          id: 'ended-worker', kind: 'cli-agent', title: 'Claude', adapterId: 'claude',
          accountId: 'claude-a', role: 'worker', missionId: 'mission-ended',
        } },
      ] },
    ] } });
    const originalMissions = useOrchStore.getState().missions;
    useOrchStore.setState({ missions: [
      { id: 'mission-1471', status: 'running', description: '' },
      { id: 'mission-ended', status: 'failed', description: '' },
    ] as never });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const switched: FailoverEvent = {
      paneId: 'mission-worker', kind: 'rate-limit', switched: true, crossAccount: true,
      fromAccountLabel: 'gu•••om', toAccountLabel: 'ma•••om',
      fromAccountId: 'claude-a', toAccountId: 'claude-b', reason: "You've hit your session limit",
    };
    const accountOf = (id: string) =>
      listPanes(useLayoutStore.getState().root).find((entry) => entry.id === id)?.accountId;
    try {
      await act(async () => root.render(<Harness />));
      notify({ ...switched, missionId: 'mission-1471' });
      expect(accountOf('mission-worker')).toBe('claude-a');
      notify({ ...switched, paneId: 'op-pane-1471' });
      expect(accountOf('op-pane-1471')).toBe('claude-b');
      // A missão encerrada não é mais dona do pane: ele troca no lugar.
      notify({ ...switched, paneId: 'ended-worker', missionId: 'mission-ended' });
      expect(accountOf('ended-worker')).toBe('claude-b');
    } finally {
      await act(async () => root.unmount()); container.remove();
      useOrchStore.setState({ missions: originalMissions });
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it('F-1471: tarefa seguiu na conta irmã da MESMA CLI num pane novo — avisa a troca de conta, sem religar', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({
        paneId: 'pane-claude', kind: 'quota', switched: true, crossAccount: true,
        fromAccountLabel: 'gu•••om', toAccountLabel: 'ma•••om',
        fromAccountId: 'claude-a', toAccountId: 'claude-b', reason: 'You exceeded your current quota',
        fromAdapterId: 'claude', toAdapterId: 'claude', toPaneId: 'pane-claude-2', missionId: 'mission-1',
      });
      expect(respawnWithResume).not.toHaveBeenCalled();
      const toast = useToastStore.getState().toasts.find((entry) => entry.dedupeKey === 'failover:pane-claude');
      expect(toast?.title).toBe('Trocado para "ma•••om"');
      expect(toast?.detail).toContain('pane-claude-2');
      expect(toast?.detail).not.toContain('esgotou em todas as contas');
    } finally {
      await act(async () => root.unmount()); container.remove();
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });

  it('F-995: troca já aplicada pelo Main no orquestrador — espelha a conta e avisa, sem religar de novo', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'orch-leaf', pane: {
      id: 'pane-12502a80', kind: 'cli-agent', title: 'Claude', adapterId: 'claude',
      accountId: 'acct-co-claude', role: 'orchestrator', missionId: 'mission-23eee6e5',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({
        paneId: 'pane-12502a80', kind: 'rate-limit', switched: true, crossAccount: true,
        fromAccountLabel: 'Co•••de', toAccountLabel: 're•••no',
        fromAccountId: 'acct-co-claude', toAccountId: 'acct-re-claude',
        reason: "You've hit your session limit", missionId: 'mission-23eee6e5',
        respawnedByMain: true,
      });
      expect(respawnWithResume).not.toHaveBeenCalled();
      const pane = listPanes(useLayoutStore.getState().root).find((entry) => entry.id === 'pane-12502a80');
      expect(pane?.accountId).toBe('acct-re-claude');
      const toast = useToastStore.getState().toasts.find((entry) => entry.title === 'Trocado para "re•••no"');
      expect(toast?.kind).toBe('success');
    } finally {
      await act(async () => root.unmount()); container.remove();
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });
});
