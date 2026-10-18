/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useToastStore } from '../state/toast-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { describe, expect, it } from 'vitest';
import { workerSpawnFailedNotice, useWorkerSpawnFailedController } from './worker-spawn-failed-controller';

const base = {
  missionId: '',
  deadAdapterId: 'kimi',
  message: 'rode `kimi login`',
  at: 1_789_000_000_000,
} as const;

describe('workerSpawnFailedNotice', () => {
  it('avisa (warn) quando outro CLI sentou o pane — o pane existe', () => {
    // Campo 10/09: o operador pediu kimi, o pane abriu claude e ele só
    // descobriu sozinho. A troca precisa de nome próprio no aviso.
    const notice = workerSpawnFailedNotice({
      ...base,
      title: 'Assento kimi → claude',
      successorCli: 'claude',
      successorName: 'Claude Code',
    });

    expect(notice.kind).toBe('warn');
    expect(notice.title).toBe('Assento kimi → claude');
    expect(notice.detail).toContain('kimi não sentou');
    expect(notice.detail).toContain('O pane abriu com Claude Code');
  });

  it('degrada para o id quando o rótulo do sucessor não vem', () => {
    const notice = workerSpawnFailedNotice({
      ...base,
      successorCli: 'claude',
    });

    expect(notice.kind).toBe('warn');
    expect(notice.title).toBe('Assento remapeado: kimi');
    expect(notice.detail).toContain('claude');
  });

  it('erra (error) quando nenhum CLI assumiu o pane', () => {
    const notice = workerSpawnFailedNotice(base);

    expect(notice.kind).toBe('error');
    expect(notice.title).toBe('kimi não subiu');
    expect(notice.detail).toBe('rode `kimi login`');
  });
});


it('oferece Abrir Providers também quando nenhum CLI abriu', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let notify!: (event: Parameters<typeof workerSpawnFailedNotice>[0]) => void;
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: {
    onWorkerSpawnFailed: (callback: typeof notify) => { notify = callback; return () => {}; },
  } } });
  function Harness() { useWorkerSpawnFailedController(); return null; }
  const host = document.createElement('div');
  const root = createRoot(host);
  const navigation = useProductNavigationStore.getState();
  try {
    await act(async () => root.render(createElement(Harness)));
    notify(base);
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.kind).toBe('error');
    expect(toast?.action?.label).toBe('Abrir Providers');
    toast?.action?.onClick();
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'settings', section: 'providers' });
  } finally {
    await act(async () => root.unmount());
    useProductNavigationStore.setState(navigation);
    for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
  }
});
