/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainBusyBanner } from './MainBusyBanner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const originalNexus = Object.getOwnPropertyDescriptor(window, 'nexus');

interface Deferred {
  resolve: (value: { at: number }) => void;
}

/** Ponte falsa: cada ping fica pendente até o teste responder. */
function installBridge() {
  const pending: Deferred[] = [];
  const heartbeat = vi.fn(
    () =>
      new Promise<{ at: number }>((resolve) => {
        pending.push({ resolve });
      }),
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: { app: { heartbeat } },
  });
  return {
    heartbeat,
    answerAll: () => {
      for (const deferred of pending.splice(0)) deferred.resolve({ at: Date.now() });
    },
  };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('MainBusyBanner (F-764 C.7)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'hidden');
    if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
    else Reflect.deleteProperty(window, 'nexus');
  });

  const band = () => host.querySelector('.main-busy__band');
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('main respondendo: região viva montada e vazia, sem faixa', async () => {
    const bridge = installBridge();
    act(() => root.render(<MainBusyBanner />));
    const region = host.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    for (let second = 0; second < 30; second += 1) {
      await advance(1_000);
      await act(async () => bridge.answerAll());
    }
    expect(bridge.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(band()).toBeNull();
    expect(region?.textContent).toBe('');
  });

  it('10 s sem resposta mostra a faixa; a resposta do main a apaga sozinha', async () => {
    const bridge = installBridge();
    act(() => root.render(<MainBusyBanner />));
    await advance(1_000);
    expect(bridge.heartbeat).toHaveBeenCalledTimes(1);

    await advance(9_000);
    expect(band()).toBeNull();
    await advance(1_000);
    expect(band()?.textContent).toContain('Nexus ocupado — capturando diagnóstico');
    expect(band()?.textContent).toContain('A janela volta a responder sozinha.');
    // Main preso: nenhum ping extra empilhado na fila dele.
    await advance(60_000);
    expect(bridge.heartbeat).toHaveBeenCalledTimes(1);

    await act(async () => bridge.answerAll());
    expect(band()).toBeNull();
  });

  it('sem a ponte (preload antigo) nunca acusa nada e não quebra', async () => {
    Object.defineProperty(window, 'nexus', { configurable: true, writable: true, value: { app: {} } });
    act(() => root.render(<MainBusyBanner />));
    await advance(30_000);
    expect(band()).toBeNull();
  });

  it('janela oculta não pinga; ao voltar confere na hora', async () => {
    const bridge = installBridge();
    setHidden(true);
    act(() => root.render(<MainBusyBanner />));
    await advance(30_000);
    expect(bridge.heartbeat).not.toHaveBeenCalled();
    act(() => setHidden(false));
    expect(bridge.heartbeat).toHaveBeenCalledTimes(1);
  });
});
