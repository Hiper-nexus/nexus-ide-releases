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
import { buildGridTree } from '../lib/split-tree';
import {
  attachHost,
  cancelPaneRecovery,
  discardPaneSpawnState,
  getOrCreateHost,
  getPaneSessionId,
  hibernateHost,
  holdSpawnUntilApproved,
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
