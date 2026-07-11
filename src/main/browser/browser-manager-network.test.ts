import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_CHANNELS } from '../../shared/channels';
import type { ProjectExecutionScope } from '../../shared/types';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-test',
  projectId: 'project-test',
  checkoutId: 'checkout-test',
  rootRealPath: '/workspace/test',
  identitySource: 'manifest',
});
const scopeB: ProjectExecutionScope = Object.freeze({
  ...scope,
  projectId: 'project-b',
  checkoutId: 'checkout-b',
  rootRealPath: '/workspace/b',
});

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
    fromPartition: vi.fn((_partition: string) => browserSession),
    handlers: new Map<string, (...args: any[]) => unknown>(),
    paneInfo: vi.fn(),
    getMissionWorkflow: vi.fn(),
    assertMutationAllowed: vi.fn(),
    fromWebContents: vi.fn(() => win),
    webContentsAvailable: true,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: state.fromWebContents },
  WebContentsView: class MockWebContentsView {
    get webContents() {
      return state.webContentsAvailable ? state.guest : undefined;
    }
    setVisible = vi.fn();
    setBounds = vi.fn();

    constructor(options: { webPreferences: Record<string, unknown> }) {
      state.order.push('view');
      state.webPreferences = options.webPreferences;
    }
  },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) =>
      state.handlers.set(channel, handler),
    on: vi.fn(),
  },
  session: { fromPartition: state.fromPartition },
}));

const installPinnedBrowserProxy = vi.hoisted(() => vi.fn());
vi.mock('./browser-network-proxy', () => ({
  installPinnedBrowserProxy,
}));

const isRunningPreviewUrlForScope = vi.hoisted(() => vi.fn(() => false));
vi.mock('../orch/preview-server', () => ({
  isRunningPreviewUrl: () => false,
  isRunningPreviewUrlForScope,
}));

vi.mock('../orch/pane-registry', () => ({
  getPaneAuthzInfoOwnedBy: state.paneInfo,
  getPaneAuthzInfoOwnedByPane: state.paneInfo,
  getDevServerForPane: vi.fn(() => null),
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({
    getMissionWorkflow: state.getMissionWorkflow,
    assertMutationAllowed: state.assertMutationAllowed,
  }),
}));

const sendDesignSelectionToAgent = vi.hoisted(() => vi.fn());
vi.mock('../orch/design-send', () => ({ sendDesignSelectionToAgent }));

import {
  assertTrustedLocalDesignPreview,
  browserDesignSessionKey,
  destroyBrowser,
  ensureBrowser,
  getBrowserViewCount,
  loadBrowser,
  registerBrowserIpc,
} from './browser-manager';
import {
  ingestDesignEvent,
  prepareDesignModeTransition,
} from './design-session';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';

describe('browser manager pinned network boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.order.length = 0;
    state.handlers.clear();
    state.webContentsAvailable = true;
    state.paneInfo.mockReturnValue(null);
    state.getMissionWorkflow.mockReturnValue({ contract: null, workflow: null });
  });
  it('permits direct write-back only for an active process-owned local preview', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    state.guest.getURL.mockReturnValue('http://127.0.0.1:43111/page');
    await ensureBrowser(state.owner as never, scope, 'pane-preview');
    const key = browserDesignSessionKey(scope, 'pane-preview');
    const generation = '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f';
    prepareDesignModeTransition(key, generation, true);
    expect(
      ingestDesignEvent(key, {
        eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e70',
        generation,
        type: 'mode',
        at: 1,
        mode: { active: true, reason: 'enable' },
      }).ok,
    ).toBe(true);

    isRunningPreviewUrlForScope.mockReturnValueOnce(true);
    expect(() =>
      assertTrustedLocalDesignPreview(
        state.owner as never,
        scope,
        'pane-preview',
        'pane-agent',
      ),
    ).not.toThrow();

    state.guest.getURL.mockReturnValue('https://example.com/');
    expect(() =>
      assertTrustedLocalDesignPreview(
        state.owner as never,
        scope,
        'pane-preview',
        'pane-agent',
      ),
    ).toThrow(/local preview/i);
    destroyBrowser('pane-preview', scope);
  });

  it('rejects stale target context initially and when it drifts before PTY injection', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    await ensureBrowser(state.owner as never, scope, 'pane-design-send');
    registerBrowserIpc({} as never);
    const invoke = state.handlers.get(BROWSER_CHANNELS.designSend);
    expect(invoke).toBeTypeOf('function');
    const currentPane = {
      paneId: 'pane-agent',
      sessionId: 'pty-agent',
      kind: 'cli-agent' as const,
      missionId: 'mission-a',
      contextRevision: 'context-revision-a',
      scope,
    };
    state.getMissionWorkflow.mockReturnValue({
      contract: { contract: { contextRevision: 'context-revision-b' } },
      workflow: { stage: 'execution' },
    });
    state.paneInfo.mockReturnValue(currentPane);
    await expect(
      invoke!({ sender: state.owner }, {
        paneId: 'pane-design-send',
        targetPaneId: 'pane-agent',
      }),
    ).rejects.toThrow(/current frozen context revision/i);

    state.getMissionWorkflow.mockReturnValue({
      contract: { contract: { contextRevision: 'context-revision-a' } },
      workflow: { stage: 'execution' },
    });
    state.paneInfo
      .mockReturnValueOnce(currentPane)
      .mockReturnValueOnce({ ...currentPane, contextRevision: 'context-revision-old' });
    sendDesignSelectionToAgent.mockImplementationOnce(async (_input, deps) =>
      deps.inject('pty-agent', 'safe prompt'),
    );
    await expect(
      invoke!({ sender: state.owner }, {
        paneId: 'pane-design-send',
        targetPaneId: 'pane-agent',
      }),
    ).rejects.toThrow(/current frozen context revision/i);
    destroyBrowser('pane-design-send', scope);
    clearRendererWorkspaceScope(state.owner);
  });

  it('installs the proxy before constructing WebContents and closes it with the pane', async () => {
    installPinnedBrowserProxy.mockImplementation(async (_session, policy) => {
      state.order.push('proxy-start');
      await Promise.resolve();
      state.order.push('proxy-ready');
      state.proxyPolicy = policy;
      return state.proxy;
    });

    await ensureBrowser(state.owner as never, scope, 'pane-network-test');

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
      scope,
      privateAccessConfirmed: true,
    });
    expect(
      [...(state.proxyPolicy?.privateTargetAddresses('private.test:8080') ?? [])],
    ).toEqual(['127.0.0.1']);

    destroyBrowser('pane-network-test', scope);
    expect(state.proxy.close).toHaveBeenCalledOnce();
  });

  it('allows the same pane id in isolated project partitions', async () => {
    // Ensure no leftover owner↔scope bind from design-send tests above.
    clearRendererWorkspaceScope(state.owner);
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    state.fromPartition.mockClear();
    await ensureBrowser(state.owner as never, scope, 'same-pane');
    // Creating the same pane id for a *different* project must not require the
    // owner to stay bound to the first scope (owner can host multi-project).
    clearRendererWorkspaceScope(state.owner);
    await ensureBrowser(state.owner as never, scopeB, 'same-pane');

    expect(getBrowserViewCount()).toBe(2);
    const partitions = state.fromPartition.mock.calls.map(([partition]) => partition);
    expect(partitions).toHaveLength(2);
    expect(partitions[0]).not.toBe(partitions[1]);
    expect(String(partitions[0])).not.toContain(scope.projectId);
    expect(String(partitions[1])).not.toContain(scopeB.projectId);

    destroyBrowser('same-pane', scope);
    expect(getBrowserViewCount()).toBe(1);
    destroyBrowser('same-pane', scopeB);
    expect(getBrowserViewCount()).toBe(0);
  });

  it('closes a pane safely when Electron destroys its owner during shutdown', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    await ensureBrowser(state.owner as never, scope, 'shutdown-pane');
    state.fromWebContents.mockImplementationOnce(() => {
      throw new TypeError('Object has been destroyed');
    });

    expect(() => destroyBrowser('shutdown-pane', scope)).not.toThrow();
    expect(state.guest.close).toHaveBeenCalled();
    expect(state.proxy.close).toHaveBeenCalled();
  });

  it('uses cached pane state when WebContents disappears during an async event', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    await ensureBrowser(state.owner as never, scope, 'shutdown-state-pane');
    const didStopLoading = state.guest.on.mock.calls.find(
      ([event]) => event === 'did-stop-loading',
    )?.[1] as (() => void) | undefined;
    expect(didStopLoading).toBeTypeOf('function');
    state.webContentsAvailable = false;

    expect(() => didStopLoading!()).not.toThrow();
    expect(state.owner.send).toHaveBeenCalledWith(
      BROWSER_CHANNELS.state,
      expect.objectContaining({
        paneId: 'shutdown-state-pane',
        url: 'about:blank',
        loading: false,
      }),
    );
    destroyBrowser('shutdown-state-pane', scope);
    expect(state.proxy.close).toHaveBeenCalled();
  });

  it('rejects an in-flight BrowserView when its renderer changes project', async () => {
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    registerBrowserIpc({} as never);
    let resolveProxy!: (proxy: typeof state.proxy) => void;
    installPinnedBrowserProxy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProxy = resolve;
        }),
    );

    const pending = ensureBrowser(
      state.owner as never,
      scope,
      'scope-switch-race',
    );
    await vi.waitFor(() =>
      expect(installPinnedBrowserProxy).toHaveBeenCalled(),
    );
    bindResolvedRendererWorkspaceScope(state.owner, scopeB);
    resolveProxy(state.proxy);

    await expect(pending).rejects.toThrow(/scope changed during creation/i);
    expect(getBrowserViewCount()).toBe(0);
    expect(state.proxy.close).toHaveBeenCalled();
    clearRendererWorkspaceScope(state.owner);
  });
});
