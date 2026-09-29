/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';

const xtermEvents = vi.hoisted(() => ({
  onData: new Set<(data: string) => void>(),
  onTitleChange: new Set<(title: string) => void>(),
}));

const resizeCalls = vi.hoisted(() => [] as Array<{ cols: number; rows: number }>);
/** Shared timeline: which happened first, the grid fit or the output-scheduler resume. */
const eventOrder = vi.hoisted(() => [] as string[]);
/** Callbacks do ResizeObserver stub — o teste dispara o tick manualmente. */
const resizeObserverTicks = vi.hoisted(() => [] as Array<() => void>);

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { cursorBlink: false };
    element?: HTMLElement;
    buffer = { active: { baseY: 0, length: 0, viewportY: 0, type: 'normal' } };
    open(element: HTMLElement) { this.element = element; }
    loadAddon(addon: { activate?: (term: unknown) => void }) { addon.activate?.(this); }
    onTitleChange(listener: (title: string) => void) {
      xtermEvents.onTitleChange.add(listener);
      return { dispose: () => xtermEvents.onTitleChange.delete(listener) };
    }
    onScroll() { return { dispose() {} }; }
    onData(listener: (data: string) => void) {
      xtermEvents.onData.add(listener);
      return { dispose: () => xtermEvents.onData.delete(listener) };
    }
    attachCustomKeyEventHandler() {}
    focus() {}
    write() {}
    writeln() {}
    refresh() {}
    dispose() {}
    // Mirrors real xterm.js: resize() reflows the live buffer at the given
    // width. Tracked here so tests can catch an intermediate reflow at a
    // throwaway width (F-356) — real xterm has no way to "undo" that reflow.
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      resizeCalls.push({ cols, rows });
      eventOrder.push('resize');
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    private terminal?: { element?: HTMLElement; cols: number; rows: number; resize(cols: number, rows: number): void };
    activate(term: NonNullable<typeof this.terminal>) { this.terminal = term; }
    // Real @xterm/addon-fit#fit() measures the container AND calls
    // terminal.resize() itself — it is not a pure measurement.
    fit() {
      const dims = this.proposeDimensions();
      if (!dims) return;
      this.terminal!.resize(dims.cols, dims.rows);
    }
    proposeDimensions(): { cols: number; rows: number } | undefined {
      const term = this.terminal;
      if (!term?.element?.clientWidth || !term.element.clientHeight) return undefined;
      return {
        cols: Math.floor(term.element.clientWidth / 10),
        rows: Math.floor(term.element.clientHeight / 20),
      };
    }
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    // virtualizeHost serializa o buffer antes de descartar o xterm — sem o
    // método o catch aborta a hibernação silenciosamente.
    serialize() { return ''; }
  },
}));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('./terminal-path-links', () => ({ attachTerminalPathLinks() {} }));
vi.mock('./terminal-ghost-assist', () => ({
  TerminalGhostAssist: class {
    state = { visibleTail: () => '' };
    dispose() {}
    ingestPtyData() {}
    ingestUserInput() {}
    tryAcceptGhost() { return false; }
    tryAcceptGhostWord() { return false; }
  },
}));

import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';
import { buildGridTree, listPanes } from '../lib/split-tree';
import * as terminalOutputScheduler from './terminal-output-scheduler';
import {
  attachHost,
  cancelPaneRecovery,
  consumeFirstSpawnIntent,
  discardPaneSpawnState,
  disposeWorkspaceHosts,
  parkWorkspaceHosts,
  markPersistedAuthorityOnSpawn,
  markResumeOnSpawn,
  getOrCreateHost,
  getPaneSessionId,
  hibernateHost,
  holdSpawnUntilApproved,
  markPaneClosingDeliberately,
  orchAutoReliveGate,
  reconcileHosts,
  refitAllPanesBeforePaint,
  refreshHost,
  revealTerminalHostsAfterWorkspaceShow,
  setHostVisibility,
  submitPromptToPane,
  waitForSession,
  writeToPane,
} from './terminal-host';

const pane: PaneModel = { id: 'hidden-spawn-test', kind: 'shell', title: 'Terminal' };
const spawn = vi.fn();
const kill = vi.fn();
const ptyWrite = vi.fn();
const ptyExitListeners = new Map<string, (event: { exitCode: number }) => void>();
const ptyDataListeners = new Map<string, (data: string) => void>();
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        resizeObserverTicks.push(() =>
          cb([], this as unknown as ResizeObserver),
        );
      }
      observe() {}
      disconnect() {}
    },
  );
  resizeObserverTicks.length = 0;
  spawn.mockReset().mockResolvedValue({ ok: true, sessionId: 'pty-hidden' });
  kill.mockReset();
  ptyWrite.mockReset();
  ptyExitListeners.clear();
  ptyDataListeners.clear();
  resizeCalls.length = 0;
  xtermEvents.onData.clear();
  xtermEvents.onTitleChange.clear();
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { logVoice: vi.fn().mockResolvedValue(undefined) }, pty: {
      spawn, kill, resize: vi.fn(), write: ptyWrite,
      replay: vi.fn(async () => {}),
      onStateChange: () => () => {},
      onData: (sessionId: string, listener: (data: string) => void) => {
        ptyDataListeners.set(sessionId, listener);
        return () => ptyDataListeners.delete(sessionId);
      },
      onExit: (sessionId: string, listener: (event: { exitCode: number }) => void) => {
        ptyExitListeners.set(sessionId, listener);
        return () => ptyExitListeners.delete(sessionId);
      },
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
  xtermEvents.onData.clear();
  xtermEvents.onTitleChange.clear();
  vi.unstubAllGlobals();
  if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
  else Reflect.deleteProperty(window, 'nexus');
});

function fireTitle(title: string): void {
  for (const listener of [...xtermEvents.onTitleChange]) listener(title);
}

describe('spawn adiado sem ninguém esperando a sessão', () => {
  it('persiste a conta realmente escolhida pelo Main quando a lista de contas do renderer não está disponível', async () => {
    const agent: PaneModel = { id: 'main-account-choice', kind: 'cli-agent', adapterId: 'codex', title: 'Codex' };
    const other: PaneModel = { id: 'other-account', kind: 'cli-agent', adapterId: 'codex', title: 'Outra', accountId: 'account-b' };
    useLayoutStore.setState({ root: buildGridTree([agent, other]), focusedPaneId: agent.id });
    spawn.mockResolvedValueOnce({ ok: true, sessionId: 'pty-selected-a', accountId: 'account-a' });
    const host = getOrCreateHost(agent);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(agent, slot);
    expect(await waitForSession(agent.id, 1000)).toBe('pty-selected-a');
    const panes = listPanes(useLayoutStore.getState().root);
    expect(panes.find((p) => p.id === agent.id)?.accountId).toBe('account-a');
    expect(panes.find((p) => p.id === other.id)?.accountId).toBe('account-b');
  });

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

describe('F-603 — pane não some ao voltar dos Ajustes', () => {
  it('reveal recoloca host que o IO marcou invisível', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    setHostSize(slot, 1200, 800);
    attachHost(pane, slot);
    const host = getOrCreateHost(pane);
    setHostVisibility(pane.id, false);
    expect(host.isVisible).toBe(false);

    revealTerminalHostsAfterWorkspaceShow();

    expect(host.isVisible).toBe(true);
  });
});

describe('F-356 — geometria não repinta em cima de conteúdo já desenhado', () => {
  it('clampa para MIN_USABLE_COLS com UM só resize físico, não fit()+resize()', async () => {
    // Repro real (xterm 0.19 + addon-fit): fit.fit() já reflowa o buffer na
    // largura estreita medida (ex.: 30 cols) e SÓ DEPOIS o clamp reflowa de
    // novo para 80. Um TUI com cursor absoluto (Codex) não sobrevive ao
    // reflow intermediário — texto em colunas altas (ex. col 72) é
    // permanentemente perdido no ciclo 80→30→80, mesmo a grade final
    // reportada acabando em 80 de novo.
    const host = getOrCreateHost(pane);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(pane, slot);
    expect(await waitForSession(pane.id, 1000)).toBe('pty-hidden');

    resizeCalls.length = 0;
    // Pane estreitado (ex.: squad grande) para menos de 80 cols efetivas.
    setHostSize(host.element, 300, 800);
    refitAllPanesBeforePaint();

    expect(resizeCalls).toEqual([{ cols: 80, rows: 40 }]);
    resizeCalls.length = 0;
    refitAllPanesBeforePaint();
    expect(resizeCalls).toEqual([]);
  });

  it('mantém a saída retida se o pane revelado ainda não tem dimensões', async () => {
    const host = getOrCreateHost(pane);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(pane, slot);
    expect(await waitForSession(pane.id, 1000)).toBe('pty-hidden');
    setHostVisibility(pane.id, false);
    const write = vi.spyOn(host.term, 'write');
    terminalOutputScheduler.writeTerminalOutput(host.term, '\x1b[Hquadro pendente', {
      foreground: false, holdBackground: true,
    });
    setHostSize(host.element, 0, 0);
    setHostVisibility(pane.id, true);
    await vi.advanceTimersByTimeAsync(60);
    ptyDataListeners.get('pty-hidden')!('\x1b[Hnovo quadro');
    await vi.advanceTimersByTimeAsync(60);
    expect(write).not.toHaveBeenCalled();
    expect(terminalOutputScheduler.getQueuedChars(host.term)).toBeGreaterThan(0);

    setHostSize(host.element, 1200, 800);
    refreshHost(pane.id);
    await vi.advanceTimersByTimeAsync(60);
    expect(write).toHaveBeenCalledWith('\x1b[Hquadro pendente\x1b[Hnovo quadro', expect.any(Function));
    expect(terminalOutputScheduler.getQueuedChars(host.term)).toBe(0);
  });

  it('reajusta a grade antes de destravar o scheduler de saída ao revelar (F-356)', async () => {
    // setHostVisibility(true) destravava o scheduler (resumeTerminalOutput)
    // NA HORA e só reajustava a grade depois, dentro de um
    // requestAnimationFrame — o dreno do backlog em segundo plano corre num
    // timer próprio (scheduleDrain), então podia escrever no xterm com a
    // grade ANTIGA (medida enquanto o pane estava oculto/minimizado) antes
    // do fit do reveal rodar. Isto é o padrão de corrupção do F-356: saída
    // de TUI pintada contra uma geometria que já não é a real.
    const host = getOrCreateHost(pane);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(pane, slot);
    expect(await waitForSession(pane.id, 1000)).toBe('pty-hidden');

    setHostVisibility(pane.id, false);
    // O pane muda de tamanho enquanto está escondido (ex.: outros splits
    // fecham) — a grade "antiga" na hora do reveal não é mais a real.
    setHostSize(host.element, 1600, 900);

    resizeCalls.length = 0;
    eventOrder.length = 0;
    const originalResume = terminalOutputScheduler.resumeTerminalOutput;
    const resumeSpy = vi
      .spyOn(terminalOutputScheduler, 'resumeTerminalOutput')
      .mockImplementation((terminal) => {
        eventOrder.push('resume-output');
        return originalResume(terminal);
      });

    setHostVisibility(pane.id, true);
    await vi.advanceTimersByTimeAsync(50);

    expect(eventOrder).toContain('resize');
    expect(eventOrder).toContain('resume-output');
    expect(eventOrder.indexOf('resize')).toBeLessThan(
      eventOrder.indexOf('resume-output'),
    );
    resumeSpy.mockRestore();
  });
});

describe('F-568 — título do pane não treme com o spinner do CLI', () => {
  function mountedHost() {
    const host = getOrCreateHost(pane);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(pane, slot);
    return host;
  }

  it('remove o glifo do spinner e escreve só o título normalizado', async () => {
    mountedHost();
    const setTitle = vi.spyOn(useLayoutStore.getState(), 'setTitle');
    fireTitle('⠋ nexus-ide');
    await vi.advanceTimersByTimeAsync(300);
    expect(setTitle).toHaveBeenCalledExactlyOnceWith(pane.id, 'nexus-ide');
  });

  it('deduplica: frames de spinner que normalizam para o mesmo título não geram novo write', async () => {
    mountedHost();
    const setTitle = vi.spyOn(useLayoutStore.getState(), 'setTitle');
    for (const frame of ['⠋', '⠙', '⠹', '⠸', '⠼']) {
      fireTitle(`${frame} nexus-ide`);
      await vi.advanceTimersByTimeAsync(60);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(setTitle).toHaveBeenCalledExactlyOnceWith(pane.id, 'nexus-ide');
  });

  it('throttle trailing: rajada de títulos diferentes coalesce num único write com o valor final', async () => {
    mountedHost();
    const setTitle = vi.spyOn(useLayoutStore.getState(), 'setTitle');
    fireTitle('⠋ um');
    await vi.advanceTimersByTimeAsync(50);
    fireTitle('⠙ dois');
    await vi.advanceTimersByTimeAsync(50);
    fireTitle('⠹ três');
    // Ainda dentro da janela de 250ms — nenhum write chegou ao store.
    expect(setTitle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(setTitle).toHaveBeenCalledExactlyOnceWith(pane.id, 'três');
  });

  it('nunca propaga ao store quando a mensagem é só o glifo, sem texto', async () => {
    mountedHost();
    const setTitle = vi.spyOn(useLayoutStore.getState(), 'setTitle');
    fireTitle('⠋');
    await vi.advanceTimersByTimeAsync(300);
    expect(setTitle).not.toHaveBeenCalled();
  });
});

describe('F-597 — OSC de tarefa não disfarça o CLI do pane', () => {
  it('worker Claude cujo OSC fala de Codex grava Claude · …', async () => {
    const agent: PaneModel = {
      id: 'cli-title-id',
      kind: 'cli-agent',
      title: 'Fix Codex pane',
      adapterId: 'claude',
      model: 'claude-sonnet-5',
    };
    useLayoutStore.setState({
      root: buildGridTree([agent]),
      focusedPaneId: agent.id,
    });
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(agent, slot);
    const host = getOrCreateHost(agent);
    setHostSize(host.element, 1200, 800);
    const setTitle = vi.spyOn(useLayoutStore.getState(), 'setTitle');
    fireTitle('* Codex pane boot crash');
    await vi.advanceTimersByTimeAsync(300);
    expect(setTitle).toHaveBeenCalledWith(
      agent.id,
      'Claude · Codex pane boot crash',
    );
    discardPaneSpawnState(agent.id);
  });
});

describe('reabertura de pane encerrado', () => {
  it('mantém um único receptor de teclado depois de converter o pane em shell', async () => {
    // F-353: o listener de input da sessão que acabou permanecia registrado
    // para capturar a tecla que abre o shell. A nova sessão adicionava outro
    // listener ao mesmo xterm, então cada tecla seguinte era enviada duas
    // vezes ao PTY.
    spawn
      .mockResolvedValueOnce({ ok: true, sessionId: 'pty-old' })
      .mockResolvedValueOnce({ ok: true, sessionId: 'pty-new' });
    const host = getOrCreateHost(pane);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(pane, slot);
    expect(await waitForSession(pane.id, 1_000)).toBe('pty-old');

    ptyExitListeners.get('pty-old')?.({ exitCode: 0 });
    for (const listener of [...xtermEvents.onData]) listener('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(await waitForSession(pane.id, 1_000)).toBe('pty-new');

    ptyWrite.mockClear();
    for (const listener of [...xtermEvents.onData]) listener('c');

    expect(ptyWrite).toHaveBeenCalledExactlyOnceWith('pty-new', 'c');
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

  it('injeta caminho absoluto no PTY quando o pane ou workspace define baseDir', async () => {
    const paneWithCwd: PaneModel = {
      id: 'pane-cwd-test',
      kind: 'shell',
      title: 'Shell Cwd',
      cwd: '/Users/cleofas/meu-projeto',
    };
    useLayoutStore.setState({ root: { kind: 'leaf', id: paneWithCwd.id, pane: paneWithCwd } });
    const host = getOrCreateHost(paneWithCwd);
    setHostSize(host.element, 1400, 900);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(paneWithCwd, slot);
    expect(await waitForSession(paneWithCwd.id, 1000)).toBe('pty-hidden');

    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/token-print.png',
    });

    dropWithoutFiles(host.element, {
      'text/uri-list': 'file:///Users/cleofas/Downloads/print.png',
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(write).toHaveBeenCalledWith(
      'pty-hidden',
      '/Users/cleofas/meu-projeto/.nexus/attachments/mission-context/token-print.png ',
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

/**
 * Trocar de workspace AFASTA os panes; não os fecha. Antes, `reconcileHosts`
 * descartava todo host fora da árvore nova e `disposeHost` matava o PTY com
 * `force:true` — o trabalho que rodava num pane do operador morria em ~1 s ao
 * clicar em outro workspace, e na volta o scrollback salvo fingia que o
 * terminal tinha voltado.
 */
describe('estacionamento de hosts na troca de workspace', () => {
  const paneA1: PaneModel = { id: 'park-a1', kind: 'shell', title: 'A1' };
  const paneA2: PaneModel = { id: 'park-a2', kind: 'shell', title: 'A2' };
  const paneC1: PaneModel = { id: 'park-c1', kind: 'shell', title: 'C1' };

  async function openLiveHost(target: PaneModel) {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(target, slot);
    const host = getOrCreateHost(target);
    setHostSize(host.element, 1200, 800);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(getPaneSessionId(target.id)).toBe(`pty-${target.id}`);
    return { host, slot };
  }

  beforeEach(() => {
    spawn.mockImplementation(async (req: { paneId?: string }) => ({
      ok: true,
      sessionId: `pty-${req.paneId ?? 'anon'}`,
    }));
    useLayoutStore.setState({
      root: buildGridTree([paneA1, paneA2]),
      focusedPaneId: paneA1.id,
    });
  });

  afterEach(() => {
    disposeWorkspaceHosts('/ws/a');
    disposeWorkspaceHosts('/ws/c');
    for (const target of [paneA1, paneA2, paneC1]) discardPaneSpawnState(target.id);
  });

  it('estacionar preserva host e sessão quando a árvore passa a ser de outro workspace', async () => {
    const { host } = await openLiveHost(paneA1);

    parkWorkspaceHosts('/ws/a');
    reconcileHosts(new Set(['pane-de-b']));

    expect(kill).not.toHaveBeenCalled();
    expect(host.disposed).toBe(false);
    expect(getOrCreateHost(paneA1)).toBe(host);
    expect(getPaneSessionId(paneA1.id)).toBe('pty-park-a1');
  });

  it('drena saída do workspace estacionado após o slot perder a medida', async () => {
    const { host } = await openLiveHost(paneA1);
    expect(host.gridReady).toBe(true);
    parkWorkspaceHosts('/ws/a');
    setHostVisibility(paneA1.id, false);
    setHostSize(host.element, 0, 0);
    refitAllPanesBeforePaint();
    expect(host.gridReady).toBe(false);

    const write = vi.spyOn(host.term, 'write');
    ptyDataListeners.get('pty-park-a1')!('saída do outro workspace');
    await vi.advanceTimersByTimeAsync(200);

    expect(write).toHaveBeenCalledWith('saída do outro workspace', expect.any(Function));
    expect(terminalOutputScheduler.getQueuedChars(host.term)).toBe(0);
  });

  it('voltar ao workspace reanexa o mesmo host sem replay duplicado', async () => {
    const { host } = await openLiveHost(paneA1);
    parkWorkspaceHosts('/ws/a');
    reconcileHosts(new Set(['pane-de-b']));
    expect(host.element.isConnected).toBe(false);

    const slot2 = document.createElement('div');
    document.body.appendChild(slot2);
    // O layout restaurado traz scrollback salvo — um host já aberto NÃO pode
    // reescrevê-lo por cima da sessão viva.
    attachHost({ ...paneA1, terminalScrollback: 'historico salvo' }, slot2);
    reconcileHosts(new Set([paneA1.id]));

    expect(slot2.contains(host.element)).toBe(true);
    expect(getOrCreateHost(paneA1)).toBe(host);
    expect(host.pendingScrollback).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    // Desestacionado: se o operador fechar o pane agora, ele morre de verdade.
    reconcileHosts(new Set());
    expect(kill).toHaveBeenCalledWith('pty-park-a1');
  });

  it('host sem sessão é descartado ao estacionar (nada a preservar)', () => {
    const slot = document.createElement('div');
    slot.hidden = true;
    document.body.appendChild(slot);
    attachHost(paneA2, slot);
    const host = getOrCreateHost(paneA2);
    expect(getPaneSessionId(paneA2.id)).toBeNull();

    parkWorkspaceHosts('/ws/a');

    expect(host.disposed).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it('fechar um pane pelo operador continua matando a sessão', async () => {
    await openLiveHost(paneA1);
    reconcileHosts(new Set());
    expect(kill).toHaveBeenCalledWith('pty-park-a1');
  });

  it('texto nunca entra no pane estacionado de outro workspace', async () => {
    // Campo 23/09: ditado/anexo/Jarvis guardam o id do pane, esperam (STT,
    // cópia do arquivo) e só então digitam. Se o operador trocou de projeto
    // nesse meio-tempo, o pane-alvo está estacionado e a sessão dele continua
    // viva — digitar ali mistura um workspace no outro sem ninguém ver.
    await openLiveHost(paneA1);
    parkWorkspaceHosts('/ws/a');
    reconcileHosts(new Set(['pane-de-b']));
    ptyWrite.mockClear();

    expect(writeToPane(paneA1.id, 'front-end e-commerce')).toBe(false);
    expect(submitPromptToPane(paneA1.id, 'front-end e-commerce')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ptyWrite).not.toHaveBeenCalled();
    // A sessão continua viva e volta a receber texto quando o pane volta.
    expect(getPaneSessionId(paneA1.id)).toBe('pty-park-a1');
  });

  it('remover um projeto mata só os estacionados dele', async () => {
    const { host: hostA } = await openLiveHost(paneA1);
    parkWorkspaceHosts('/ws/a');
    useLayoutStore.setState({ root: buildGridTree([paneC1]), focusedPaneId: paneC1.id });
    const { host: hostC } = await openLiveHost(paneC1);
    parkWorkspaceHosts('/ws/c');
    reconcileHosts(new Set(['pane-de-b']));
    expect(kill).not.toHaveBeenCalled();

    disposeWorkspaceHosts('/ws/a');

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('pty-park-a1');
    expect(hostA.disposed).toBe(true);
    expect(hostC.disposed).toBe(false);
  });
});


describe('F-567 exact resume failure', () => {
  it('reports the error and never retries the latest conversation', async () => {
    spawn.mockResolvedValue({ ok: true, sessionId: 'pty-exact', resumeMode: 'exact' });
    markResumeOnSpawn(pane.id);
    const host = openHiddenHost();
    const output = vi.spyOn(host.term, 'writeln');
    host.element.parentElement!.hidden = false;
    setHostSize(host.element, 1200, 800);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(spawn).toHaveBeenCalledTimes(1);
    ptyExitListeners.get('pty-exact')!({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.flat().join(' ')).toContain('Falha ao retomar a sessão');
    expect(output.mock.calls.flat().join(' ')).toContain('+ Pane');
    expect(getPaneSessionId(pane.id)).toBeNull();
  });
});

describe('paste de mídia no pane (F-582)', () => {
  const write = vi.fn();
  const importDroppedUri = vi.fn();
  const importMissionAttachment = vi.fn();
  const clipboardFileUris = vi.fn();
  const localExitListeners = new Map<string, (event: { exitCode: number }) => void>();
  let filePath = '';

  beforeEach(() => {
    write.mockReset();
    importDroppedUri.mockReset();
    importMissionAttachment.mockReset();
    clipboardFileUris.mockReset().mockResolvedValue({ uris: [] });
    filePath = '';
    localExitListeners.clear();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        pty: {
          spawn, kill, resize: vi.fn(), write,
          onStateChange: () => () => {}, onData: () => () => {},
          onExit: (sessionId: string, listener: (event: { exitCode: number }) => void) => {
            localExitListeners.set(sessionId, listener);
            return () => localExitListeners.delete(sessionId);
          },
        },
        files: {
          importDroppedUri,
          importMissionAttachment,
          clipboardFileUris,
          pathForFile: () => filePath,
        },
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

  function pasteEvent(
    element: HTMLElement,
    options: {
      files?: File[];
      types?: string[];
      data?: Record<string, string>;
    },
  ): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    const data = options.data ?? {};
    const types =
      options.types ??
      [
        ...(options.files?.length ? ['Files'] : []),
        ...Object.keys(data),
      ];
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: options.files ?? [],
        items: [],
        types,
        getData: (type: string) => data[type] ?? '',
      },
    });
    element.dispatchEvent(event);
    return event;
  }

  it('vídeo colado sem caminho estagia via base64 e digita o caminho', async () => {
    const host = await openLiveHost();
    const video = new File([new Uint8Array(1024)], 'filme.mp4', {
      type: 'video/mp4',
    });
    importMissionAttachment.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-filme.mp4',
    });

    const event = pasteEvent(host.element, { files: [video] });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    expect(importMissionAttachment).toHaveBeenCalledOnce();
    expect(importDroppedUri).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      'pty-hidden',
      '.nexus/attachments/mission-context/k-filme.mp4 ',
    );
  });

  it('arquivo colado COM caminho fora do projeto faz stream via main', async () => {
    const host = await openLiveHost();
    filePath = '/Users/ana/Movies/filme.mp4';
    const video = new File(['x'], 'filme.mp4', { type: 'video/mp4' });
    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-filme.mp4',
    });

    const event = pasteEvent(host.element, { files: [video] });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    expect(importDroppedUri).toHaveBeenCalledExactlyOnceWith(
      'file:///Users/ana/Movies/filme.mp4',
    );
    expect(importMissionAttachment).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      'pty-hidden',
      '.nexus/attachments/mission-context/k-filme.mp4 ',
    );
  });

  it('text/uri-list colado importa o file:// e digita o caminho, sem toast', async () => {
    const host = await openLiveHost();
    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-audio.opus',
    });

    const event = pasteEvent(host.element, {
      data: { 'text/uri-list': 'file:///Users/ana/audio.opus' },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    expect(importDroppedUri).toHaveBeenCalledExactlyOnceWith(
      'file:///Users/ana/audio.opus',
    );
    expect(write).toHaveBeenCalledWith(
      'pty-hidden',
      '.nexus/attachments/mission-context/k-audio.opus ',
    );
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('text/plain sozinho segue para o terminal: nada é interceptado', async () => {
    const host = await openLiveHost();

    const event = pasteEvent(host.element, {
      data: { 'text/plain': 'https://example.com' },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(false);
    expect(importDroppedUri).not.toHaveBeenCalled();
    expect(importMissionAttachment).not.toHaveBeenCalled();
    expect(clipboardFileUris).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('payload Files sem arquivo e sem URI no sistema vira toast explicado', async () => {
    const host = await openLiveHost();
    clipboardFileUris.mockResolvedValue({ uris: [] });

    const event = pasteEvent(host.element, { types: ['Files'], files: [] });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardFileUris).toHaveBeenCalledOnce();
    const toast = useToastStore
      .getState()
      .toasts.find((item) => item.title === 'Nada foi colado no terminal');
    expect(toast).toBeDefined();
    expect(toast?.detail).toContain('prometeu um arquivo');
    expect(toast?.detail).toContain('Finder');
    expect(write).not.toHaveBeenCalled();
  });

  it('falha ao consultar o pasteboard do sistema vira toast, nunca silêncio', async () => {
    const host = await openLiveHost();
    clipboardFileUris.mockRejectedValue(new Error('ipc morto'));

    const event = pasteEvent(host.element, { types: ['Files'], files: [] });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    const toast = useToastStore
      .getState()
      .toasts.find((item) => item.title === 'Nada foi colado no terminal');
    expect(toast?.detail).toContain('área de transferência do sistema');
    expect(toast?.detail).toContain('Finder');
    expect(write).not.toHaveBeenCalled();
  });

  it('payload Files sem arquivo usa o file:// do pasteboard do sistema', async () => {
    const host = await openLiveHost();
    clipboardFileUris.mockResolvedValue({
      uris: ['file:///Users/ana/foto.jpg'],
    });
    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-foto.jpg',
    });

    const event = pasteEvent(host.element, { types: ['Files'], files: [] });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    expect(importDroppedUri).toHaveBeenCalledExactlyOnceWith(
      'file:///Users/ana/foto.jpg',
    );
    expect(write).toHaveBeenCalledWith(
      'pty-hidden',
      '.nexus/attachments/mission-context/k-foto.jpg ',
    );
  });

  it('drop de arquivo com caminho fora do projeto ignora o cap de 14 MB do renderer', async () => {
    const host = await openLiveHost();
    filePath = '/Users/ana/Movies/filme-grande.mp4';
    const video = new File(['x'], 'filme-grande.mp4', { type: 'video/mp4' });
    Object.defineProperty(video, 'size', { value: 20 * 1024 * 1024 });
    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-filme-grande.mp4',
    });

    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files: [video],
        types: ['Files'],
        getData: () => '',
        dropEffect: 'none',
      },
    });
    host.element.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(10);

    expect(importDroppedUri).toHaveBeenCalledExactlyOnceWith(
      'file:///Users/ana/Movies/filme-grande.mp4',
    );
    expect(importMissionAttachment).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      'pty-hidden',
      '.nexus/attachments/mission-context/k-filme-grande.mp4 ',
    );
  });

  it('F-593: PTY morta antes do paste — avisa que o pane está sem sessão, não que a cópia falhou', async () => {
    const host = await openLiveHost();
    filePath = '/Users/ana/Desktop/print-2026-09-19T22-22-51.png';
    const screenshot = new File(['x'], 'print-2026-09-19T22-22-51.png', {
      type: 'image/png',
    });
    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-print.png',
    });

    // Codex saiu: onExit dispara e zera host.sessionId ANTES do paste.
    localExitListeners.get('pty-hidden')!({ exitCode: 0 });

    const event = pasteEvent(host.element, { files: [screenshot] });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    expect(importDroppedUri).toHaveBeenCalledExactlyOnceWith(
      'file:///Users/ana/Desktop/print-2026-09-19T22-22-51.png',
    );
    // A cópia aconteceu — nada deve ser escrito num PTY que não existe mais.
    expect(write).not.toHaveBeenCalled();
    const toast = useToastStore
      .getState()
      .toasts.find((item) => item.title === 'Pane sem sessão ativa');
    expect(toast).toBeDefined();
    expect(toast?.detail).toContain('foi copiado');
    expect(toast?.detail).not.toContain('não pôde ser copiado');
    expect(
      useToastStore.getState().toasts.some((item) => item.title === 'Arquivo não colado no terminal'),
    ).toBe(false);
  });

  it('F-593: text/uri-list colado com PTY morta avisa sem digitar nada', async () => {
    const host = await openLiveHost();
    importDroppedUri.mockResolvedValue({
      ok: true,
      path: '.nexus/attachments/mission-context/k-audio.opus',
    });

    localExitListeners.get('pty-hidden')!({ exitCode: 0 });

    const event = pasteEvent(host.element, {
      data: { 'text/uri-list': 'file:///Users/ana/audio.opus' },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(event.defaultPrevented).toBe(true);
    expect(write).not.toHaveBeenCalled();
    const toast = useToastStore
      .getState()
      .toasts.find((item) => item.title === 'Pane sem sessão ativa');
    expect(toast).toBeDefined();
    expect(toast?.detail).toContain('foi copiado');
  });
});

describe('fechamento deliberado pelo main — helper não reabre como shell vazio', () => {
  const helper: PaneModel = { id: 'helper-auto-close', kind: 'cli-agent', adapterId: 'codex', title: 'Helper' };

  async function openHelper() {
    useLayoutStore.setState({ root: buildGridTree([helper]), focusedPaneId: helper.id });
    spawn.mockResolvedValueOnce({ ok: true, sessionId: 'pty-helper' });
    const host = getOrCreateHost(helper);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(helper, slot);
    expect(await waitForSession(helper.id, 1000)).toBe('pty-helper');
    spawn.mockClear();
    return host;
  }

  function pressKey(): void {
    for (const listener of [...xtermEvents.onData]) listener('x');
  }

  afterEach(() => discardPaneSpawnState(helper.id));

  it('exit antes do closeRequest + tecla no meio: não oferece nem abre shell', async () => {
    const host = await openHelper();
    const writeln = vi.spyOn(host.term, 'writeln');
    markPaneClosingDeliberately(helper.id, 'pty-helper');

    ptyExitListeners.get('pty-helper')!({ exitCode: 0 });
    pressKey();
    await vi.advanceTimersByTimeAsync(100);

    expect(spawn).not.toHaveBeenCalled();
    expect(writeln.mock.calls.flat().join('\n')).not.toMatch(/Digite qualquer tecla/);
  });

  it('se o closeRequest nunca chegar, volta ao convite normal de shell', async () => {
    const host = await openHelper();
    const writeln = vi.spyOn(host.term, 'writeln');
    markPaneClosingDeliberately(helper.id, 'pty-helper');
    ptyExitListeners.get('pty-helper')!({ exitCode: 0 });

    await vi.advanceTimersByTimeAsync(5_100);

    expect(writeln.mock.calls.flat().join('\n')).toMatch(/Digite qualquer tecla/);
    expect(host.awaitingDeliberateClose).toBe(false);
  });

  it('saída inesperada (sem aviso) segue oferecendo o shell como hoje', async () => {
    const host = await openHelper();
    const writeln = vi.spyOn(host.term, 'writeln');

    ptyExitListeners.get('pty-helper')!({ exitCode: 1 });

    expect(writeln.mock.calls.flat().join('\n')).toMatch(/Digite qualquer tecla/);
    expect(host.awaitingDeliberateClose).toBeFalsy();
  });
});

describe('F-367 — tecla em pane morto de missão: uma tentativa por janela', () => {
  const listMissions = vi.fn();
  const missionCommand = vi.fn();
  const missionSnapshot = vi.fn();
  let missionSeq = 0;

  function pressKey(key = 'k'): void {
    for (const listener of [...xtermEvents.onData]) listener(key);
  }

  function countNotice(writeln: ReturnType<typeof vi.spyOn>, needle: string): number {
    return writeln.mock.calls
      .flat()
      .filter((line: unknown) => typeof line === 'string' && line.includes(needle))
      .length;
  }

  // A janela de cooldown é estado de MÓDULO por missionId: cada teste usa a
  // sua, senão a segunda iteração cai na janela da primeira.
  function mountDeadWorker() {
    missionSeq += 1;
    const missionId = `mission-367-${missionSeq}`;
    const missionWorker: PaneModel = {
      id: `dead-mission-worker-367-${missionSeq}`,
      kind: 'cli-agent',
      adapterId: 'claude',
      title: 'Worker',
      role: 'worker',
      missionId,
    };
    listMissions.mockResolvedValue([{ id: missionId, status: 'running' }]);
    useOrchStore.setState({
      paneMissions: { [missionWorker.id]: missionId },
      missions: [{ id: missionId, status: 'running' } as never],
      handoffs: [],
    });
    useLayoutStore.setState({
      root: buildGridTree([missionWorker]),
      focusedPaneId: missionWorker.id,
    });
    return { missionWorker, missionId };
  }

  beforeEach(() => {
    listMissions.mockReset();
    missionCommand.mockReset().mockResolvedValue({});
    missionSnapshot.mockReset().mockResolvedValue(null);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        voice: { logVoice: vi.fn().mockResolvedValue(undefined) },
        pty: {
          spawn, kill, resize: vi.fn(), write: ptyWrite,
          onStateChange: () => () => {},
          onData: (sessionId: string, listener: (data: string) => void) => {
            ptyDataListeners.set(sessionId, listener);
            return () => ptyDataListeners.delete(sessionId);
          },
          onExit: (sessionId: string, listener: (event: { exitCode: number }) => void) => {
            ptyExitListeners.set(sessionId, listener);
            return () => ptyExitListeners.delete(sessionId);
          },
        },
        accounts: { list: vi.fn().mockResolvedValue([]) },
        orch: { listMissions },
        mission: { snapshot: missionSnapshot, command: missionCommand },
      },
    });
  });

  afterEach(() => {
    useOrchStore.setState({ paneMissions: {}, missions: [], handoffs: [] });
  });

  async function openDeadWorker(missionWorker: PaneModel) {
    spawn.mockResolvedValueOnce({ ok: true, sessionId: `pty-${missionWorker.id}` });
    const host = getOrCreateHost(missionWorker);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(missionWorker, slot);
    expect(await waitForSession(missionWorker.id, 1000)).toBe(
      `pty-${missionWorker.id}`,
    );
    const writeln = vi.spyOn(host.term, 'writeln');
    ptyExitListeners.get(`pty-${missionWorker.id}`)!({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(50);
    writeln.mockClear();
    return { host, writeln };
  }

  it('rajada de teclas dentro do cooldown: uma tentativa, um aviso de cada, um comando', async () => {
    const { missionWorker, missionId } = mountDeadWorker();
    const { writeln } = await openDeadWorker(missionWorker);

    for (let i = 0; i < 8; i += 1) {
      pressKey();
      await vi.advanceTimersByTimeAsync(20);
    }

    expect(countNotice(writeln, 'tecla recebida')).toBe(1);
    expect(countNotice(writeln, 'tentativa recente em curso')).toBeLessThanOrEqual(1);
    expect(missionCommand).toHaveBeenCalledTimes(1);
    expect(missionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'retry-kickoff', missionId }),
    );

    // Janela nova: a próxima tecla abre outra tentativa (e avisa de novo).
    await vi.advanceTimersByTimeAsync(15_000);
    pressKey();
    await vi.advanceTimersByTimeAsync(50);
    expect(missionCommand).toHaveBeenCalledTimes(2);
    expect(countNotice(writeln, 'tecla recebida')).toBe(2);
  });

  it('teclas com o desbloqueio em voo são engolidas — um listMissions só', async () => {
    const { missionWorker, missionId } = mountDeadWorker();
    let releaseMissions!: () => void;
    listMissions.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMissions = () =>
            resolve([{ id: missionId, status: 'running' }]);
        }),
    );
    const { writeln } = await openDeadWorker(missionWorker);

    for (let i = 0; i < 5; i += 1) pressKey();
    await vi.advanceTimersByTimeAsync(20);

    expect(listMissions).toHaveBeenCalledTimes(1);

    releaseMissions();
    await vi.advanceTimersByTimeAsync(50);
    expect(countNotice(writeln, 'tecla recebida')).toBe(1);
    expect(missionCommand).toHaveBeenCalledTimes(1);
  });

  it('guarda travada por IPC pendurado libera a tecla depois de 20 s (R1)', async () => {
    const { missionWorker } = mountDeadWorker();
    // listMissions NUNCA resolve — sem o teto a guarda calava o pane pra sempre.
    listMissions.mockImplementation(() => new Promise(() => {}));
    await openDeadWorker(missionWorker);

    pressKey();
    await vi.advanceTimersByTimeAsync(50);
    expect(listMissions).toHaveBeenCalledTimes(1);

    // Dentro do teto: teclas continuam engolidas em silêncio.
    pressKey();
    await vi.advanceTimersByTimeAsync(5_000);
    pressKey();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listMissions).toHaveBeenCalledTimes(1);

    // Passados 20 s do início do trabalho, a guarda considera o IPC
    // pendurado e solta — a próxima tecla inicia um novo unlock.
    await vi.advanceTimersByTimeAsync(10_500);
    pressKey();
    await vi.advanceTimersByTimeAsync(50);
    expect(listMissions).toHaveBeenCalledTimes(2);
  });
});

describe('F-368 — revive honesto: helper morto não promete o que não entrega', () => {
  const listMissions = vi.fn();
  const missionCommand = vi.fn();
  const missionSnapshot = vi.fn();
  let missionSeq = 0;

  function pressKey(key = 'k'): void {
    for (const listener of [...xtermEvents.onData]) listener(key);
  }

  function outputText(writeln: ReturnType<typeof vi.spyOn>): string {
    return writeln.mock.calls.flat().join('\n');
  }

  function mountMission(opts: { withMaestro: boolean }) {
    missionSeq += 1;
    const missionId = `mission-368-${missionSeq}`;
    const maestro: PaneModel = {
      id: `maestro-368-${missionSeq}`,
      kind: 'cli-agent',
      adapterId: 'claude',
      title: `Maestro · ${missionId}`,
      role: 'orchestrator',
      missionId,
    };
    const worker: PaneModel = {
      id: `worker-368-${missionSeq}`,
      kind: 'cli-agent',
      adapterId: 'claude',
      title: `Helper · ${missionId}`,
      role: 'worker',
      missionId,
    };
    const panes = opts.withMaestro ? [maestro, worker] : [worker];
    listMissions.mockResolvedValue([{ id: missionId, status: 'running' }]);
    useOrchStore.setState({
      paneMissions: Object.fromEntries(panes.map((p) => [p.id, missionId])),
      missions: [{ id: missionId, status: 'running' } as never],
      handoffs: [],
    });
    useLayoutStore.setState({
      root: buildGridTree(panes),
      focusedPaneId: worker.id,
    });
    return { missionId, maestro, worker };
  }

  beforeEach(() => {
    listMissions.mockReset();
    missionCommand.mockReset().mockResolvedValue({});
    missionSnapshot.mockReset().mockResolvedValue(null);
    spawn.mockImplementation(async (req: { paneId?: string }) => ({
      ok: true,
      sessionId: `pty-${req.paneId ?? 'anon'}`,
    }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        voice: { logVoice: vi.fn().mockResolvedValue(undefined) },
        pty: {
          spawn, kill, resize: vi.fn(), write: ptyWrite,
          onStateChange: () => () => {},
          onData: (sessionId: string, listener: (data: string) => void) => {
            ptyDataListeners.set(sessionId, listener);
            return () => ptyDataListeners.delete(sessionId);
          },
          onExit: (sessionId: string, listener: (event: { exitCode: number }) => void) => {
            ptyExitListeners.set(sessionId, listener);
            return () => ptyExitListeners.delete(sessionId);
          },
        },
        accounts: { list: vi.fn().mockResolvedValue([]) },
        orch: {
          listMissions,
          // A tecla vai a TODOS os onData — o Maestro vivo recebe como
          // input de operador; o mock absorve para isolar o pane morto.
          sendPaneOperatorInput: vi.fn().mockResolvedValue(true),
        },
        mission: { snapshot: missionSnapshot, command: missionCommand },
      },
    });
  });

  afterEach(() => {
    useOrchStore.setState({ paneMissions: {}, missions: [], handoffs: [] });
  });

  async function openLive(target: PaneModel) {
    const host = getOrCreateHost(target);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(target, slot);
    expect(await waitForSession(target.id, 1000)).toBe(`pty-${target.id}`);
    return host;
  }

  it('worker morto com Maestro vivo: sem kickoff e a mensagem aponta o pane', async () => {
    const { maestro, worker } = mountMission({ withMaestro: true });
    await openLive(maestro);
    const workerHost = await openLive(worker);
    const writeln = vi.spyOn(workerHost.term, 'writeln');
    ptyExitListeners.get(`pty-${worker.id}`)!({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(50);
    writeln.mockClear();

    pressKey();
    await vi.advanceTimersByTimeAsync(80);

    expect(missionCommand).not.toHaveBeenCalled();
    const text = outputText(writeln);
    expect(text).toContain('verificando a missão deste pane');
    expect(text).toContain('histórico');
    expect(text).toContain(`«${maestro.title}»`);
    expect(text).toContain('escreva lá');
  });

  it('worker morto SEM Maestro vivo: retry-kickoff + mensagem de reabrir', async () => {
    const { missionId, worker } = mountMission({ withMaestro: false });
    const workerHost = await openLive(worker);
    const writeln = vi.spyOn(workerHost.term, 'writeln');
    ptyExitListeners.get(`pty-${worker.id}`)!({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(50);
    writeln.mockClear();

    pressKey();
    await vi.advanceTimersByTimeAsync(80);

    expect(missionCommand).toHaveBeenCalledTimes(1);
    expect(missionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'retry-kickoff', missionId }),
    );
    const text = outputText(writeln);
    expect(text).toContain('reabre em outro pane');
    expect(text).toContain('histórico');
  });

  it('orquestrador morto mantém o aviso de religar neste pane', async () => {
    const { maestro } = mountMission({ withMaestro: true });
    const maestroHost = await openLive(maestro);
    const writeln = vi.spyOn(maestroHost.term, 'writeln');
    ptyExitListeners.get(`pty-${maestro.id}`)!({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(50);
    writeln.mockClear();

    pressKey();
    await vi.advanceTimersByTimeAsync(80);

    const text = outputText(writeln);
    expect(text).toContain('tentando religar o Maestro neste pane');
    expect(text).not.toContain('verificando a missão deste pane');
    // Orquestrador religa a própria CLI — nunca chuta o motor.
    expect(missionCommand).not.toHaveBeenCalled();
  });

  it('aviso de histórico silencia as próximas teclas da janela (R2)', async () => {
    const { maestro, worker } = mountMission({ withMaestro: true });
    await openLive(maestro);
    const workerHost = await openLive(worker);
    const writeln = vi.spyOn(workerHost.term, 'writeln');
    ptyExitListeners.get(`pty-${worker.id}`)!({ exitCode: 1 });
    await vi.advanceTimersByTimeAsync(50);
    writeln.mockClear();

    pressKey();
    await vi.advanceTimersByTimeAsync(80);
    expect(outputText(writeln)).toContain('histórico');
    expect(missionCommand).not.toHaveBeenCalled();

    // Janela de 15 s ainda aberta: nenhuma tecla nova pode imprimir a linha
    // de cooldown — a resposta já foi dada ("escreva no Maestro").
    writeln.mockClear();
    for (let i = 0; i < 3; i += 1) {
      pressKey();
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(outputText(writeln)).not.toContain('tentativa recente em curso');
    expect(missionCommand).not.toHaveBeenCalled();
  });

  it('grant expirado com Maestro vivo não dispara retry-kickoff automático', async () => {
    const { maestro, worker, missionId } = mountMission({ withMaestro: true });
    await openLive(maestro);
    spawn.mockImplementationOnce(async () => ({
      ok: false,
      error: 'unknown or expired orchestration spawn request',
    }));
    const granted: PaneModel = { ...worker, orchRequestId: 'req-368' };
    useLayoutStore.setState({
      root: buildGridTree([maestro, granted]),
      focusedPaneId: granted.id,
    });
    useOrchStore.setState({
      paneMissions: { [maestro.id]: missionId, [granted.id]: missionId },
      missions: [{ id: missionId, status: 'running' } as never],
      handoffs: [],
    });
    const host = getOrCreateHost(granted);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(granted, slot);
    const writeln = vi.spyOn(host.term, 'writeln');
    await vi.advanceTimersByTimeAsync(200);

    expect(missionCommand).not.toHaveBeenCalled();
    const text = outputText(writeln);
    expect(text).not.toContain('reemitindo');
    expect(text).toContain(`«${maestro.title}»`);
  });
});

describe('F-369 — TUI repinta depois de saída perdida', () => {
  const agent: PaneModel = {
    id: 'agent-tui',
    kind: 'cli-agent',
    adapterId: 'codex',
    title: 'Codex',
  };
  const OVER_BACKLOG = 2 * 1024 * 1024 + 64;

  const ptyResize = () => vi.mocked(window.nexus.pty.resize);

  /** Par (rows-1, rows) consecutivo na mesma sessão = um bounce de grade. */
  function bounceCount(): number {
    const calls = ptyResize().mock.calls;
    return calls.filter((call, i) => {
      const prev = calls[i - 1];
      return (
        prev !== undefined &&
        prev[0] === call[0] &&
        prev[1] === call[1] &&
        prev[2] === call[2] - 1
      );
    }).length;
  }

  async function openVisibleAgent() {
    useLayoutStore.setState({
      root: buildGridTree([agent]),
      focusedPaneId: agent.id,
    });
    const host = getOrCreateHost(agent);
    setHostSize(host.element, 1200, 800);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(agent, slot);
    expect(await waitForSession(agent.id, 1000)).toBe('pty-hidden');
    return host;
  }

  it('backlog >2 MiB dropado oculto → reveal → exatamente um bounce', async () => {
    const host = await openVisibleAgent();
    setHostVisibility(agent.id, false);
    expect(host.isVisible).toBe(false);
    ptyResize().mockClear();

    ptyDataListeners.get('pty-hidden')!('x'.repeat(OVER_BACKLOG));
    // A perda já aconteceu; bouncear oculto é desperdício — espera o reveal.
    expect(ptyResize()).not.toHaveBeenCalled();

    setHostVisibility(agent.id, true);
    await vi.advanceTimersByTimeAsync(60);
    expect(bounceCount()).toBe(1);

    // Flag consumida: um segundo reveal sem nova perda não bounceia.
    setHostVisibility(agent.id, false);
    setHostVisibility(agent.id, true);
    await vi.advanceTimersByTimeAsync(60);
    expect(bounceCount()).toBe(1);
  });

  it('reidratação de host hibernado → um bounce no resume seguinte', async () => {
    const host = await openVisibleAgent();
    // O hibernador só descarta o xterm com a grade cheia de hosts vivos.
    for (let i = 0; i < 24; i++) {
      getOrCreateHost({ id: `filler-${i}`, kind: 'shell', title: `t${i}` });
    }
    setHostVisibility(agent.id, false);
    expect(host.virtualized).not.toBeNull();
    ptyResize().mockClear();

    setHostVisibility(agent.id, true);
    await vi.advanceTimersByTimeAsync(60);
    // A reidratação devolve o xterm; o primeiro resume com grade consome a
    // flag UMA vez (o replay sozinho não reconstroi a moldura da TUI).
    refreshHost(agent.id);
    await vi.advanceTimersByTimeAsync(60);
    expect(bounceCount()).toBe(1);

    refreshHost(agent.id);
    await vi.advanceTimersByTimeAsync(60);
    expect(bounceCount()).toBe(1);
  });

  it('reidratado, visível e SEM foco → um bounce no tick do ResizeObserver (R7)', async () => {
    const host = await openVisibleAgent();
    for (let i = 0; i < 24; i++) {
      getOrCreateHost({ id: `filler-${i}`, kind: 'shell', title: `t${i}` });
    }
    setHostVisibility(agent.id, false);
    expect(host.virtualized).not.toBeNull();
    // De volta à tela mas SEM o foco — o bounce não pode depender de
    // resumeVisibleHost (que só roda no caminho focado).
    useLayoutStore.setState({ focusedPaneId: 'other-pane' });
    setHostVisibility(agent.id, true);
    await vi.advanceTimersByTimeAsync(60);
    ptyResize().mockClear();

    for (const tick of resizeObserverTicks.splice(0)) tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(bounceCount()).toBe(1);

    // Flag consumida: um segundo tick não bounceia de novo.
    for (const tick of resizeObserverTicks.splice(0)) tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(bounceCount()).toBe(1);
  });

  it('perda com o pane visível → bounce no frame seguinte', async () => {
    await openVisibleAgent();
    // Visível mas NÃO focado: a saída segue pela fila de fundo e estoura o
    // backlog — exatamente o caminho que dropava e deixava o pane quebrado.
    useLayoutStore.setState({ focusedPaneId: 'other-pane' });
    ptyResize().mockClear();

    ptyDataListeners.get('pty-hidden')!('x'.repeat(OVER_BACKLOG));
    // Nada no meio do drop — o bounce espera o próximo frame, depois que o
    // aviso de backlog drena.
    expect(ptyResize()).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(bounceCount()).toBe(1);
  });

  it('sem perda, o reveal não bounceia', async () => {
    await openVisibleAgent();
    setHostVisibility(agent.id, false);
    ptyResize().mockClear();

    ptyDataListeners.get('pty-hidden')!('texto pequeno');
    setHostVisibility(agent.id, true);
    await vi.advanceTimersByTimeAsync(60);
    expect(ptyResize()).not.toHaveBeenCalled();
  });
});

describe('F-370 — foco da janela repinta os terminais (macOS)', () => {
  const paneA: PaneModel = { id: 'f370-a', kind: 'shell', title: 'A' };
  const paneB: PaneModel = { id: 'f370-b', kind: 'shell', title: 'B' };
  const paneC: PaneModel = { id: 'f370-c', kind: 'shell', title: 'C' };

  function openShell(target: PaneModel) {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    attachHost(target, slot);
    const host = getOrCreateHost(target);
    setHostSize(host.element, 1200, 800);
    return host;
  }

  it('rajada de focus faz UMA passada só nos hosts abertos e visíveis', async () => {
    // window.ts desliga backgroundThrottling no macOS: o canvas segue
    // 'visible' ao voltar de outro app e `visibilitychange` nunca dispara.
    // O 'focus' da janela é o gatilho real desse retorno.
    useLayoutStore.setState({
      root: buildGridTree([paneA, paneB, paneC]),
      focusedPaneId: paneA.id,
    });
    const hostA = openShell(paneA);
    const hostB = openShell(paneB);
    const hostC = openShell(paneC);
    setHostVisibility(paneC.id, false);

    const fitA = vi.spyOn(hostA.fit, 'proposeDimensions');
    const fitB = vi.spyOn(hostB.fit, 'proposeDimensions');
    const fitC = vi.spyOn(hostC.fit, 'proposeDimensions');
    const focusA = vi.spyOn(hostA.term, 'focus');

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60);

    // Uma rajada = um rAF = uma medição por host visível, FOCADO INCLUSO.
    expect(fitA).toHaveBeenCalledTimes(1);
    expect(fitB).toHaveBeenCalledTimes(1);
    // Oculto não paga repaint.
    expect(fitC).not.toHaveBeenCalled();
    // R8: o retorno da janela nunca rouba o foco do DOM (textarea/dialog do
    // operador) — nem foca o terminal nem chama focusHost.
    expect(focusA).not.toHaveBeenCalled();
    expect(hostA.term.options.cursorBlink).toBe(true);
    expect(hostB.term.options.cursorBlink).toBe(false);
  });
});
