import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';
import { RENDERER_PROTOCOL_ENTRY_URL } from './renderer-protocol';
import { WINDOW_CHANNELS } from '../shared/channels';

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    browserWindowConstructor: vi.fn(),
    cspHook: vi.fn(),
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showErrorBox: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    dock: undefined,
    focus: vi.fn(),
  },
  BrowserWindow: class MockBrowserWindow {
    constructor(options: unknown) {
      harness.browserWindowConstructor(options);
    }
  },
  dialog: {
    showErrorBox: harness.showErrorBox,
    showMessageBox: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: harness.cspHook,
      },
    },
  },
  shell: {
    openExternal: harness.openExternal,
    openPath: harness.openPath,
  },
}));

vi.mock('./pty/pty-manager', () => ({
  killSessionsFor: vi.fn(),
}));

vi.mock('./runtime-process-inventory', () => ({
  liveRuntimeProcessSummary: vi.fn(() => ({ total: 0, busy: 0 })),
  sealRuntimeProcessAdmissionForShutdown: vi.fn(),
}));

vi.mock('./agent-runtime/agent-runtime-bridge', () => ({
  handleRenderProcessGone: vi.fn(),
}));

vi.mock('./macos-activation-policy', () => ({
  applyMacOSDockIcon: vi.fn(),
  ensureRegularMacOSActivation: vi.fn(),
  reassertMacOSDockPresence: vi.fn(),
}));

import {
  bindTrustedMainWindow,
  createMainWindow,
  handleOpenExternalRequest,
  registerCsp,
  registerExternalLinkIpc,
} from './window';

interface FakeRenderer {
  sender: WebContents;
  frame: object;
  window: BrowserWindow;
  destroySender(): void;
  crashSender(): void;
  destroyWindow(): void;
  navigate(url: string): void;
}

function fakeRenderer(url = RENDERER_PROTOCOL_ENTRY_URL): FakeRenderer {
  let senderDestroyed = false;
  let senderCrashed = false;
  let windowDestroyed = false;
  let currentUrl = url;
  const frame = {};
  const destroyedListeners: Array<() => void> = [];
  const sender = {
    mainFrame: frame,
    getURL: () => currentUrl,
    isDestroyed: () => senderDestroyed,
    isCrashed: () => senderCrashed,
    once: (event: string, listener: () => void) => {
      if (event === 'destroyed') destroyedListeners.push(listener);
    },
  } as unknown as WebContents;
  const window = {
    webContents: sender,
    isDestroyed: () => windowDestroyed,
  } as unknown as BrowserWindow;
  return {
    sender,
    frame,
    window,
    destroySender: () => {
      senderDestroyed = true;
      for (const listener of destroyedListeners) listener();
    },
    crashSender: () => {
      senderCrashed = true;
    },
    destroyWindow: () => {
      windowDestroyed = true;
    },
    navigate: (next) => {
      currentUrl = next;
    },
  };
}

function invokeOpenExternal(sender: WebContents, senderFrame: object, raw: unknown) {
  return handleOpenExternalRequest(
    { sender, senderFrame } as never,
    raw,
  );
}

describe('main renderer CSP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  });

  it('does not construct/load a renderer and retries registration after CSP hook failure', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.cspHook.mockImplementationOnce(() => {
      throw new Error('webRequest unavailable');
    });

    expect(createMainWindow()).toBeNull();
    expect(harness.browserWindowConstructor).not.toHaveBeenCalled();
    expect(harness.showErrorBox).toHaveBeenCalledTimes(1);

    expect(() => registerCsp(undefined)).not.toThrow();
    expect(harness.cspHook).toHaveBeenCalledTimes(2);

    const installed = harness.cspHook.mock.calls[1]?.[0] as
      | ((
          details: { responseHeaders?: Record<string, string[]> },
          callback: (result: { responseHeaders: Record<string, string[]> }) => void,
        ) => void)
      | undefined;
    const callback = vi.fn();
    installed?.({ responseHeaders: {} }, callback);
    const csp = callback.mock.calls[0]?.[0]?.responseHeaders?.[
      'Content-Security-Policy'
    ]?.[0];
    expect(csp).toContain("frame-ancestors 'none'");
    consoleError.mockRestore();
  });
});

describe('external link renderer authority', () => {
  beforeAll(() => {
    registerExternalLinkIpc();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows https only from the live main frame of a bound main window', () => {
    const renderer = fakeRenderer();
    bindTrustedMainWindow(renderer.window, RENDERER_PROTOCOL_ENTRY_URL);
    const openExternal = harness.handlers.get(WINDOW_CHANNELS.openExternal);

    expect(
      openExternal?.(
        { sender: renderer.sender, senderFrame: renderer.frame },
        'https://accounts.example.test/device',
      ),
    ).toEqual({ ok: true });
    expect(harness.openExternal).toHaveBeenCalledWith(
      'https://accounts.example.test/device',
    );
  });

  it('rejects an unbound WebContents even when it reports the trusted renderer URL', () => {
    const attacker = fakeRenderer();

    expect(
      invokeOpenExternal(
        attacker.sender,
        attacker.frame,
        'https://accounts.example.test/device',
      ),
    ).toEqual({ ok: false, error: 'renderer não autorizado' });
    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it('applies the same main-renderer authority to auth and legal native effects', async () => {
    const attacker = fakeRenderer();
    const event = { sender: attacker.sender, senderFrame: attacker.frame };
    const authLogin = harness.handlers.get(WINDOW_CHANNELS.authLogin);
    const openLegalNotices = harness.handlers.get(WINDOW_CHANNELS.openLegalNotices);

    expect(authLogin).toBeTypeOf('function');
    expect(openLegalNotices).toBeTypeOf('function');
    expect(await authLogin?.(event, 'github')).toEqual({
      ok: false,
      error: 'renderer não autorizado',
    });
    expect(await openLegalNotices?.(event)).toEqual({
      ok: false,
      error: 'renderer não autorizado',
    });
    expect(harness.openExternal).not.toHaveBeenCalled();
    expect(harness.openPath).not.toHaveBeenCalled();
  });

  it('lets the bound main renderer reach auth payload validation', async () => {
    const renderer = fakeRenderer();
    bindTrustedMainWindow(renderer.window, RENDERER_PROTOCOL_ENTRY_URL);
    const authLogin = harness.handlers.get(WINDOW_CHANNELS.authLogin);

    expect(
      await authLogin?.(
        { sender: renderer.sender, senderFrame: renderer.frame },
        'microsoft',
      ),
    ).toEqual({ ok: false, error: 'provider inválido' });
  });

  it('rejects subframes, navigated renderers and dead/crashed owners', () => {
    const subframe = fakeRenderer();
    bindTrustedMainWindow(subframe.window, RENDERER_PROTOCOL_ENTRY_URL);
    expect(
      invokeOpenExternal(
        subframe.sender,
        {},
        'https://accounts.example.test/device',
      ),
    ).toEqual({ ok: false, error: 'renderer não autorizado' });

    const navigated = fakeRenderer();
    bindTrustedMainWindow(navigated.window, RENDERER_PROTOCOL_ENTRY_URL);
    navigated.navigate('https://attacker.example/');
    expect(
      invokeOpenExternal(
        navigated.sender,
        navigated.frame,
        'https://accounts.example.test/device',
      ),
    ).toEqual({ ok: false, error: 'renderer não autorizado' });

    const crashed = fakeRenderer();
    bindTrustedMainWindow(crashed.window, RENDERER_PROTOCOL_ENTRY_URL);
    crashed.crashSender();
    expect(
      invokeOpenExternal(
        crashed.sender,
        crashed.frame,
        'https://accounts.example.test/device',
      ),
    ).toEqual({ ok: false, error: 'renderer não autorizado' });

    const deadWindow = fakeRenderer();
    bindTrustedMainWindow(deadWindow.window, RENDERER_PROTOCOL_ENTRY_URL);
    deadWindow.destroyWindow();
    expect(
      invokeOpenExternal(
        deadWindow.sender,
        deadWindow.frame,
        'https://accounts.example.test/device',
      ),
    ).toEqual({ ok: false, error: 'renderer não autorizado' });

    const destroyed = fakeRenderer();
    bindTrustedMainWindow(destroyed.window, RENDERER_PROTOCOL_ENTRY_URL);
    destroyed.destroySender();
    expect(
      invokeOpenExternal(
        destroyed.sender,
        destroyed.frame,
        'https://accounts.example.test/device',
      ),
    ).toEqual({ ok: false, error: 'renderer não autorizado' });

    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    'http://accounts.example.test/device',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'not a url',
  ])('keeps URL protocol parsing fail-closed for %s', (raw) => {
    const renderer = fakeRenderer();
    bindTrustedMainWindow(renderer.window, RENDERER_PROTOCOL_ENTRY_URL);

    expect(
      invokeOpenExternal(renderer.sender, renderer.frame, raw),
    ).toMatchObject({ ok: false });
    expect(harness.openExternal).not.toHaveBeenCalled();
  });
});
