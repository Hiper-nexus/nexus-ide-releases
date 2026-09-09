/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { cursorBlink: false };
    element?: HTMLElement;
    buffer = { active: { baseY: 0, length: 0, viewportY: 0, type: 'normal' } };
    open(element: HTMLElement) { this.element = element; }
    loadAddon(addon: { activate?: (term: unknown) => void }) { addon.activate?.(this); }
    onTitleChange() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    write() {}
    writeln() {}
    refresh() {}
    dispose() {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    private terminal?: { element?: HTMLElement; cols: number; rows: number };
    activate(term: NonNullable<typeof this.terminal>) { this.terminal = term; }
    fit() {
      const term = this.terminal;
      if (!term?.element?.clientWidth || !term.element.clientHeight) return;
      term.cols = Math.floor(term.element.clientWidth / 10);
      term.rows = Math.floor(term.element.clientHeight / 20);
    }
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('./terminal-path-links', () => ({ attachTerminalPathLinks() {} }));
vi.mock('./terminal-ghost-assist', () => ({ TerminalGhostAssist: class { dispose() {} } }));

import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';
import { buildGridTree } from '../lib/split-tree';
import {
  attachHost,
  cancelPaneRecovery,
  consumeFirstSpawnIntent,
  discardPaneSpawnState,
  markPersistedAuthorityOnSpawn,
  markResumeOnSpawn,
  getOrCreateHost,
  getPaneSessionId,
  hibernateHost,
  holdSpawnUntilApproved,
  orchAutoReliveGate,
  reconcileHosts,
  waitForSession,
} from './terminal-host';

const pane: PaneModel = { id: 'hidden-spawn-test', kind: 'shell', title: 'Terminal' };
const spawn = vi.fn();
const kill = vi.fn();
const originalNexus = Object.getOwnPropertyDescriptor(window, 'nexus');

function setHostSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
}

function openHiddenHost() {
  const slot = document.createElement('div');
  slot.hidden = true;
  document.body.appendChild(slot);
  attachHost(pane, slot);
  const host = getOrCreateHost(pane);
  expect(host.opened).toBe(true);
  expect(host.element.clientWidth).toBe(0);
  expect(host.element.clientHeight).toBe(0);
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  spawn.mockReset().mockResolvedValue({ ok: true, sessionId: 'pty-hidden' });
  kill.mockReset();
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { pty: {
      spawn, kill, resize: vi.fn(), write: vi.fn(),
      onStateChange: () => () => {}, onData: () => () => {}, onExit: () => () => {},
    } },
  });
  useOrchStore.setState({ paneMissions: {}, missions: [] });
  useLayoutStore.setState({ root: buildGridTree([pane]), focusedPaneId: pane.id });
});

afterEach(() => {
  reconcileHosts(new Set());
  discardPaneSpawnState(pane.id);
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
  else Reflect.deleteProperty(window, 'nexus');
});

describe('spawn adiado sem ninguém esperando a sessão', () => {
  it('nasce sozinho quando o canvas oculto fica mensurável, mesmo sem ResizeObserver', async () => {
    // Campo 09/09: pane aberto pelo picker com o destino em Início (canvas
    // de terminais `hidden`, 0×0). Ninguém chama waitForSession, o
    // ResizeObserver não resgata e o pane ficava em branco para sempre.
    const host = openHiddenHost();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(spawn).not.toHaveBeenCalled();
    expect(host.spawnWhenMeasurable).toBe(true);

    host.element.parentElement!.hidden = false;
    setHostSize(host.element, 1200, 800);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cols: 120, rows: 40 }),
    );
    expect(host.spawnWhenMeasurable).toBe(false);
  });

  it('para de tentar quando o host é descartado', async () => {
    const host = openHiddenHost();
    await vi.advanceTimersByTimeAsync(300);
    reconcileHosts(new Set());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).not.toHaveBeenCalled();
    expect(host.disposed).toBe(true);
  });
});

describe('waitForSession with an attached terminal', () => {
  it('starts an opened 0×0 hidden terminal after the measurement grace period', async () => {
    openHiddenHost();
    const waiting = waitForSession(pane.id, 1000);
    await vi.advanceTimersByTimeAsync(199);
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBe('pty-hidden');
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cols: 80, rows: 24 }));
  });

  it('uses the measured visible grid when the pane becomes measurable before the fallback', async () => {
    const host = openHiddenHost();
    const waiting = waitForSession(pane.id, 1000);
    await vi.advanceTimersByTimeAsync(100);
    host.element.parentElement!.hidden = false;
    setHostSize(host.element, 1200, 800);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBe('pty-hidden');
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cols: 120, rows: 40 }));
  });

  it('spawns a measurable visible terminal immediately without a second fallback spawn', async () => {
    const host = getOrCreateHost(pane);
    setHostSize(host.element, 1400, 900);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(pane, slot);
    expect(await waitForSession(pane.id, 1000)).toBe('pty-hidden');
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cols: 140, rows: 45 }));
  });

  it.each(['held', 'removed', 'disposed', 'cancelled', 'hibernated'] as const)(
    'does not spawn when the pending hidden pane becomes %s before the fallback',
    async (change) => {
      openHiddenHost();
      const waiting = waitForSession(pane.id, 1000);
      await vi.advanceTimersByTimeAsync(100);
      if (change === 'held') holdSpawnUntilApproved(pane.id);
      if (change === 'removed') useLayoutStore.setState({ root: buildGridTree([{ ...pane, id: 'other-pane' }]) });
      if (change === 'disposed') reconcileHosts(new Set());
      if (change === 'cancelled') cancelPaneRecovery(pane.id);
      if (change === 'hibernated') hibernateHost(pane.id);
      await vi.advanceTimersByTimeAsync(900);
      expect(await waiting).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each(['disposed', 'cancelled'] as const)('kills a late IPC session after the pane was %s while spawning', async (change) => {
    let finishSpawn!: (result: { ok: true; sessionId: string }) => void;
    spawn.mockImplementation(() => new Promise(resolve => { finishSpawn = resolve; }));
    openHiddenHost();
    const waiting = waitForSession(pane.id, 1000);
    await vi.advanceTimersByTimeAsync(200);
    expect(spawn).toHaveBeenCalledOnce();
    if (change === 'disposed') reconcileHosts(new Set());
    else cancelPaneRecovery(pane.id);
    finishSpawn({ ok: true, sessionId: 'late-pty' });
    await vi.advanceTimersByTimeAsync(800);
    expect(await waiting).toBeNull();
    expect(kill).toHaveBeenCalledWith('late-pty');
    expect(getPaneSessionId(pane.id)).toBeNull();
  });
});

describe('orchAutoReliveGate — teto anti-loop com voz no esgotamento', () => {
  it('permite religar fora do cooldown e abaixo do teto', () => {
    expect(
      orchAutoReliveGate({ now: 100_000, lastReliveAt: 80_000, autoReliveCount: 0 }),
    ).toBe('allow');
    expect(
      orchAutoReliveGate({ now: 100_000, lastReliveAt: undefined, autoReliveCount: 1 }),
    ).toBe('allow');
  });

  it('segura o transiente de cooldown em silêncio', () => {
    expect(
      orchAutoReliveGate({ now: 100_000, lastReliveAt: 95_000, autoReliveCount: 0 }),
    ).toBe('cooldown');
  });

  it('aponta esgotamento quando o teto estoura (o chamador anuncia)', () => {
    expect(
      orchAutoReliveGate({ now: 100_000, lastReliveAt: 80_000, autoReliveCount: 2 }),
    ).toBe('exhausted');
  });
});

describe('consumeFirstSpawnIntent — resume+restore nunca simultâneos', () => {
  it('última intenção vence e o consumo é one-shot', () => {
    // Ordem do fluxo de login que gerava panes mortos com
    // `modo(resume+fresh simultâneos)`: restore marcado e resume depois.
    markPersistedAuthorityOnSpawn('intent-a');
    markResumeOnSpawn('intent-a');
    expect(consumeFirstSpawnIntent('intent-a')).toEqual({
      resume: true,
      restorePersistedAuthority: false,
    });
    expect(consumeFirstSpawnIntent('intent-a')).toEqual({
      resume: false,
      restorePersistedAuthority: false,
    });

    markResumeOnSpawn('intent-b');
    markPersistedAuthorityOnSpawn('intent-b');
    expect(consumeFirstSpawnIntent('intent-b')).toEqual({
      resume: false,
      restorePersistedAuthority: true,
    });
    discardPaneSpawnState('intent-a');
    discardPaneSpawnState('intent-b');
  });
});

describe('drop sem File — text/uri-list vira anexo digitado no PTY', () => {
  const write = vi.fn();
  const importDroppedUri = vi.fn();

  beforeEach(() => {
    write.mockReset();
    importDroppedUri.mockReset();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        pty: {
          spawn, kill, resize: vi.fn(), write,
          onStateChange: () => () => {}, onData: () => () => {}, onExit: () => () => {},
        },
        files: { importDroppedUri, pathForFile: () => '', importMissionAttachment: vi.fn() },
      },
    });
    useToastStore.setState({ toasts: [] });
  });

  async function openLiveHost() {
    const host = getOrCreateHost(pane);
    setHostSize(host.element, 1400, 900);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(pane, slot);
    expect(await waitForSession(pane.id, 1000)).toBe('pty-hidden');
    return host;
  }

  function dropWithoutFiles(element: HTMLElement, data: Record<string, string>): void {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files: [],
        types: Object.keys(data),
        getData: (type: string) => data[type] ?? '',
        dropEffect: 'none',
      },
    });
    element.dispatchEvent(event);
  }

  it('file:// solto sem File pede ao main e digita o caminho estagiado', async () => {
    // WhatsApp/Fotos entregam só o endereço; `files` vem vazia. O main lê o
    // arquivo e devolve o caminho em mission-context, que entra no pane
    // exatamente como um drop do Finder.
    const host = await openLiveHost();
    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-foto.png',
    });

    dropWithoutFiles(host.element, {
      'text/uri-list': 'file:///Users/ana/foto%20de%20perfil.png',
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(importDroppedUri).toHaveBeenCalledExactlyOnceWith(
      'file:///Users/ana/foto%20de%20perfil.png',
    );
    expect(write).toHaveBeenCalledWith(
      'pty-hidden',
      '.nexus/attachments/mission-context/k-foto.png ',
    );
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).not.toContain(
      'Nada foi solto no terminal',
    );
  });

  it('lista com comentário, file:// e https:// gera um anexo por linha', async () => {
    const host = await openLiveHost();
    importDroppedUri.mockImplementation(async (uri: string) => ({
      ok: true,
      path: `.nexus/attachments/mission-context/k-${uri.split('/').pop()}`,
    }));

    dropWithoutFiles(host.element, {
      'text/uri-list':
        '# origem\r\nfile:///Users/ana/a.png\r\nhttps://example.com/b.pdf\r\n',
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(importDroppedUri.mock.calls.map(([uri]) => uri)).toEqual([
      'file:///Users/ana/a.png',
      'https://example.com/b.pdf',
    ]);
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      '.nexus/attachments/mission-context/k-a.png ',
      '.nexus/attachments/mission-context/k-b.pdf ',
    ]);
  });

  it('recusa do main vira toast com o motivo, sem digitar nada', async () => {
    const host = await openLiveHost();
    importDroppedUri.mockResolvedValue({
      ok: false,
      error: '"filme.mov" excede o limite de 14 MB por arquivo.',
    });

    dropWithoutFiles(host.element, { 'text/uri-list': 'file:///Users/ana/filme.mov' });
    await vi.advanceTimersByTimeAsync(10);

    expect(write).not.toHaveBeenCalled();
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((toast) => toast.title)).toContain('Arquivo não colado no terminal');
    expect(toasts.find((toast) => toast.title === 'Arquivo não colado no terminal')?.detail).toContain('14 MB');
  });

  it('sem URI aproveitável mantém o diagnóstico honesto e não chama o main', async () => {
    const host = await openLiveHost();

    dropWithoutFiles(host.element, { Files: '' });
    await vi.advanceTimersByTimeAsync(10);

    expect(importDroppedUri).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const toast = useToastStore
      .getState()
      .toasts.find((item) => item.title === 'Nada foi solto no terminal');
    expect(toast?.detail).toContain('Finder');
  });

  it('esquema recusado no renderer (data:) também cai no diagnóstico, sem IPC', async () => {
    const host = await openLiveHost();

    dropWithoutFiles(host.element, { 'text/uri-list': 'data:text/plain;base64,aGk=' });
    await vi.advanceTimersByTimeAsync(10);

    expect(importDroppedUri).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain(
      'Nada foi solto no terminal',
    );
  });
});
