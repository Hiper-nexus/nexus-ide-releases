/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccessStore } from '../state/access-store';
import type { PaneModel } from '../../shared/types';

const hostStubs = vi.hoisted(() => ({
  waitForBrowserPaneCreated: vi.fn(async () => ({})),
}));
vi.mock('../browser/browser-host', () => ({
  waitForBrowserPaneCreated: hostStubs.waitForBrowserPaneCreated,
}));

import { DevServerChip } from './DevServerChip';
import { useDevServerStore } from '../state/dev-server-store';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const SHELL_PANE: PaneModel = { id: 'pane-shell', kind: 'shell', title: 'shell' };

let container: HTMLDivElement;
let root: Root;
let load: ReturnType<typeof vi.fn>;

function render(pane: PaneModel): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<DevServerChip pane={pane} />);
  });
}

beforeEach(() => {
  useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
  load = vi.fn(async () => ({}));
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { browser: { load }, layout: { save: vi.fn(), load: vi.fn() } },
  });
  useLayoutStore.getState().setPanes([SHELL_PANE]);
  useDevServerStore.getState().reset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('DevServerChip', () => {
  it('renders nothing without a detected dev server for the pane', () => {
    render(SHELL_PANE);
    expect(container.querySelector('[data-testid=devserver-chip]')).toBeNull();
  });

  it('shows host:port once a dev server is detected for the pane', () => {
    render(SHELL_PANE);
    act(() => {
      useDevServerStore.getState().setDetected({
        paneId: 'pane-shell',
        sessionId: 'sess-1',
        url: 'http://localhost:5173/',
        urls: ['http://localhost:5173/'],
        detectedAt: 1,
      });
    });
    const chip = container.querySelector('[data-testid=devserver-chip]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('localhost:5173');
  });

  it('opens a browser pane at the detected URL on click', async () => {
    render(SHELL_PANE);
    act(() => {
      useDevServerStore.getState().setDetected({
        paneId: 'pane-shell',
        sessionId: 'sess-1',
        url: 'http://localhost:5173/',
        urls: ['http://localhost:5173/'],
        detectedAt: 1,
      });
    });
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid=devserver-chip]',
    )!;
    await act(async () => {
      chip.click();
    });
    const browserPane = listPanes(useLayoutStore.getState().root).find(
      (p) => p.kind === 'browser',
    );
    expect(browserPane).toBeDefined();
    expect(hostStubs.waitForBrowserPaneCreated).toHaveBeenCalledWith(browserPane!.id);
    expect(load).toHaveBeenCalledWith(browserPane!.id, 'http://localhost:5173/');
  });

  it('never renders on browser panes', () => {
    const browserPane: PaneModel = { id: 'pane-br', kind: 'browser', title: 'b' };
    useLayoutStore.getState().setPanes([SHELL_PANE, browserPane]);
    act(() => {
      useDevServerStore.getState().setDetected({
        paneId: 'pane-br',
        sessionId: 'sess-2',
        url: 'http://localhost:3000',
        urls: ['http://localhost:3000'],
        detectedAt: 1,
      });
    });
    render(browserPane);
    expect(container.querySelector('[data-testid=devserver-chip]')).toBeNull();
  });
});

describe('useDevServerStore', () => {
  it('ignores payloads without a resolved paneId and keeps the latest per pane', () => {
    const store = useDevServerStore.getState();
    store.setDetected({
      paneId: null,
      sessionId: 's',
      url: 'http://localhost:1234',
      urls: ['http://localhost:1234'],
      detectedAt: 1,
    });
    expect(useDevServerStore.getState().byPane).toEqual({});
    store.setDetected({
      paneId: 'p1',
      sessionId: 's',
      url: 'http://localhost:1234',
      urls: ['http://localhost:1234'],
      detectedAt: 2,
    });
    store.setDetected({
      paneId: 'p1',
      sessionId: 's',
      url: 'http://localhost:1234',
      urls: ['http://localhost:1234', 'http://192.168.0.2:1234'],
      detectedAt: 3,
    });
    expect(useDevServerStore.getState().byPane.p1.urls).toHaveLength(2);
  });
});
