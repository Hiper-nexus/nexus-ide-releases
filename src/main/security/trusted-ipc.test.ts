import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMock = vi.hoisted(() => vi.fn());
const onMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: onMock },
}));

import {
  bindTrustedMainWindow,
  findTrustedMainWindow,
  handleTrusted,
  isLiveTrustedMainWindowSender,
  onTrusted,
} from './trusted-ipc';

function fakeWindow(url = 'nexus://app/index.html') {
  const listeners: Record<string, Array<() => void>> = {};
  const contents = {
    mainFrame: { id: 1 },
    destroyed: false,
    crashed: false,
    url,
    isDestroyed() {
      return this.destroyed;
    },
    isCrashed() {
      return this.crashed;
    },
    getURL() {
      return this.url;
    },
    once(event: string, callback: () => void) {
      (listeners[event] ??= []).push(callback);
    },
    fireDestroyed() {
      this.destroyed = true;
      for (const callback of listeners.destroyed ?? []) callback();
    },
  };
  const win = {
    webContents: contents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  return { win, contents };
}

function eventFor(
  contents: ReturnType<typeof fakeWindow>['contents'],
  frame = contents.mainFrame,
) {
  return { sender: contents, senderFrame: frame } as never;
}

describe('trusted IPC seam', () => {
  beforeEach(() => {
    handleMock.mockReset();
    onMock.mockReset();
    vi.restoreAllMocks();
  });

  it('accepts only the live bound main-frame renderer', () => {
    const { win, contents } = fakeWindow();
    bindTrustedMainWindow(win as never, 'nexus://app/index.html');
    expect(isLiveTrustedMainWindowSender(eventFor(contents))).toBe(true);
    expect(
      isLiveTrustedMainWindowSender(
        eventFor(contents, { id: 999 } as never),
      ),
    ).toBe(false);

    contents.crashed = true;
    expect(isLiveTrustedMainWindowSender(eventFor(contents))).toBe(false);
  });

  it('finds the bound main window among all windows and ignores unbound or dead ones', () => {
    const console = fakeWindow();
    const main = fakeWindow();
    const closed = fakeWindow();
    bindTrustedMainWindow(main.win as never, 'nexus://app/index.html');
    bindTrustedMainWindow(closed.win as never, 'nexus://app/index.html');
    closed.win.destroyed = true;
    expect(findTrustedMainWindow([console.win, closed.win, main.win] as never)).toBe(main.win);
    expect(findTrustedMainWindow([console.win, closed.win] as never)).toBeUndefined();
    expect(findTrustedMainWindow([])).toBeUndefined();
  });

  it('denies unknown, destroyed and cross-origin senders', () => {
    const unknown = fakeWindow();
    expect(
      isLiveTrustedMainWindowSender(eventFor(unknown.contents)),
    ).toBe(false);

    const destroyed = fakeWindow();
    bindTrustedMainWindow(
      destroyed.win as never,
      'nexus://app/index.html',
    );
    destroyed.win.destroyed = true;
    expect(
      isLiveTrustedMainWindowSender(eventFor(destroyed.contents)),
    ).toBe(false);

    const navigated = fakeWindow();
    bindTrustedMainWindow(
      navigated.win as never,
      'nexus://app/index.html',
    );
    navigated.contents.url = 'https://evil.example/index.html';
    expect(
      isLiveTrustedMainWindowSender(eventFor(navigated.contents)),
    ).toBe(false);
  });

  it('blocks invoke handlers for unverified senders', () => {
    const trusted = fakeWindow();
    bindTrustedMainWindow(trusted.win as never, 'nexus://app/index.html');
    const handler = vi.fn();
    handleTrusted('settings:write', handler);
    const wrapped = handleMock.mock.calls[0]![1] as (
      event: unknown,
      ...args: unknown[]
    ) => unknown;

    expect(() =>
      wrapped(eventFor(fakeWindow().contents), { key: 'x' }),
    ).toThrow(/não autorizado/);
    expect(handler).not.toHaveBeenCalled();

    wrapped(eventFor(trusted.contents), { key: 'x' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('drops untrusted send events and allows the bound sender', () => {
    const trusted = fakeWindow();
    bindTrustedMainWindow(trusted.win as never, 'nexus://app/index.html');
    const listener = vi.fn();
    onTrusted('updater:install', listener);
    const wrapped = onMock.mock.calls[0]![1] as (
      event: unknown,
      ...args: unknown[]
    ) => void;

    wrapped(eventFor(fakeWindow().contents));
    expect(listener).not.toHaveBeenCalled();
    wrapped(eventFor(trusted.contents));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('unbinds on destruction and never logs URL path, query or fragment', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const trusted = fakeWindow();
    bindTrustedMainWindow(trusted.win as never, 'nexus://app/index.html');
    trusted.contents.fireDestroyed();
    trusted.contents.destroyed = false;
    expect(
      isLiveTrustedMainWindowSender(eventFor(trusted.contents)),
    ).toBe(false);

    const attacker = fakeWindow(
      'https://evil.example/private?token=secret-value#credential',
    );
    handleTrusted('secret:write', vi.fn());
    const wrapped = handleMock.mock.calls.at(-1)![1] as (
      event: unknown,
    ) => unknown;
    expect(() => wrapped(eventFor(attacker.contents))).toThrow();
    const logged = String(warn.mock.calls.at(-1)?.[0] ?? '');
    expect(logged).toContain('origin=https://evil.example');
    expect(logged).not.toContain('/private');
    expect(logged).not.toContain('secret-value');
    expect(logged).not.toContain('credential');
  });

  it('fails closed without throwing a second diagnostic error for a dead sender', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deadSender = {
      getURL: () => {
        throw new Error('dead');
      },
      get mainFrame() {
        throw new Error('dead');
      },
    };
    handleTrusted('secret:write', vi.fn());
    const wrapped = handleMock.mock.calls.at(-1)![1] as (
      event: unknown,
    ) => unknown;

    expect(() =>
      wrapped({ sender: deadSender, senderFrame: null } as never),
    ).toThrow(/não autorizado/);
    expect(String(warn.mock.calls.at(-1)?.[0] ?? '')).toContain(
      'origin=[invalid-origin], frame=unknown',
    );
  });
});
