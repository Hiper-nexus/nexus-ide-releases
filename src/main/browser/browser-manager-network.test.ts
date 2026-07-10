import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const order: string[] = [];
  const browserSession = {
    resolveHost: vi.fn(async () => ({
      endpoints: [{ address: '93.184.216.34', port: 0 }],
    })),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  };
  const guest = {
    id: 22,
    session: browserSession,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    getURL: vi.fn(() => 'about:blank'),
    getTitle: vi.fn(() => ''),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    setWebRTCIPHandlingPolicy: vi.fn(),
    loadURL: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const owner = {
    id: 11,
    once: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
  };
  const win = {
    isDestroyed: vi.fn(() => false),
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  };
  const proxy = {
    port: 43123,
    proxyRules: 'http://127.0.0.1:43123',
    close: vi.fn(async () => {}),
  };
  return {
    order,
    browserSession,
    guest,
    owner,
    win,
    proxy,
    proxyPolicy: undefined as
      | {
          privateTargetAddresses: (
            targetKey: string,
          ) => ReadonlySet<string> | undefined;
        }
      | undefined,
    webPreferences: undefined as Record<string, unknown> | undefined,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => state.win },
  WebContentsView: class MockWebContentsView {
    webContents = state.guest;
    setVisible = vi.fn();
    setBounds = vi.fn();

    constructor(options: { webPreferences: Record<string, unknown> }) {
      state.order.push('view');
      state.webPreferences = options.webPreferences;
    }
  },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  session: { fromPartition: vi.fn(() => state.browserSession) },
}));

const installPinnedBrowserProxy = vi.hoisted(() => vi.fn());
vi.mock('./browser-network-proxy', () => ({
  installPinnedBrowserProxy,
}));

vi.mock('../orch/preview-server', () => ({
  isRunningPreviewUrl: () => false,
}));

import { destroyBrowser, ensureBrowser, loadBrowser } from './browser-manager';

describe('browser manager pinned network boundary', () => {
  it('installs the proxy before constructing WebContents and closes it with the pane', async () => {
    installPinnedBrowserProxy.mockImplementation(async (_session, policy) => {
      state.order.push('proxy-start');
      await Promise.resolve();
      state.order.push('proxy-ready');
      state.proxyPolicy = policy;
      return state.proxy;
    });

    await ensureBrowser(state.owner as never, 'pane-network-test');

    expect(state.order).toEqual(['proxy-start', 'proxy-ready', 'view']);
    expect(state.webPreferences).toMatchObject({
      session: state.browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(state.webPreferences).not.toHaveProperty('partition');
    expect(state.win.contentView.addChildView).toHaveBeenCalledOnce();
    expect(state.guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp',
    );

    state.browserSession.resolveHost.mockResolvedValue({
      endpoints: [{ address: '127.0.0.1', port: 0 }],
    });
    await loadBrowser('pane-network-test', 'http://private.test:8080/', {
      privateAccessConfirmed: true,
    });
    expect(
      [...(state.proxyPolicy?.privateTargetAddresses('private.test:8080') ?? [])],
    ).toEqual(['127.0.0.1']);

    destroyBrowser('pane-network-test');
    expect(state.proxy.close).toHaveBeenCalledOnce();
  });
});
