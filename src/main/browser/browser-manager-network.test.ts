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
    webRequest: { onBeforeRequest: vi.fn(), onCompleted: vi.fn() },
  };
  const guest = {
    id: 22,
    session: browserSession,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
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
    views: [] as Array<{ setVisible: ReturnType<typeof vi.fn> }>,
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
    setBackgroundColor = vi.fn();

    constructor(options: { webPreferences: Record<string, unknown> }) {
      state.order.push('view');
      state.webPreferences = options.webPreferences;
      state.views.push(this);
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
  isAgentRequestedBrowser: vi.fn(() => false),
  forgetParkedBrowserPane: vi.fn(),
  registerParkedBrowserCloser: vi.fn(),
  wasParkedBrowserClosed: vi.fn(() => false),
  getPaneAuthzInfoOwnedBy: state.paneInfo,
  getPaneAuthzInfoOwnedByPane: state.paneInfo,
  getDevServerForPane: vi.fn(() => null),
  listPaneSnapshots: vi.fn(() => []),
  requestMissionPaneClose: vi.fn(async () => true),
  requestPaneClose: vi.fn(async () => true),
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({
    getMissionWorkflow: state.getMissionWorkflow,
    assertMutationAllowed: state.assertMutationAllowed,
  }),
}));

const sendDesignSelectionToAgent = vi.hoisted(() => vi.fn());
vi.mock('../orch/design-send', () => ({ sendDesignSelectionToAgent }));
const profileHarness = vi.hoisted(() => ({
  mode: 'isolated' as 'isolated' | 'personal',
  assertConnection: undefined as (() => void) | undefined,
}));
vi.mock('./browser-personal-profile', () => ({
  browserProfileMode: () => profileHarness.mode,
  rememberAgentBrowser: vi.fn(),
  connectPersonalProfile: async (_contents: unknown, assertConnection: () => void) => {
    profileHarness.assertConnection = assertConnection;
    return async () => { assertConnection(); };
  },
}));

import {
  assertBrowserAtExactUrl,
  assertTrustedLocalDesignPreview,
  browserDesignSessionKey,
  destroyBrowser,
  destroyBrowserWithProof,
  ensureBrowser,
  getBrowserViewCount,
  loadBrowser,
  lockBrowserToExactUrl,
  registerBrowserIpc,
} from './browser-manager';
import {
  ingestDesignEvent,
  prepareDesignModeTransition,
} from './design-session';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
  forgetRendererWorkspace,
} from '../persistence/renderer-workspace-scope';
import {
  forgetParkedBrowserPane,
  registerParkedBrowserCloser,
  wasParkedBrowserClosed,
} from '../orch/pane-registry';

describe('browser manager pinned network boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.order.length = 0;
    state.views.length = 0;
    state.handlers.clear();
    state.webContentsAvailable = true;
    state.guest.getURL.mockReturnValue('about:blank');
    state.guest.isDestroyed.mockReturnValue(false);
    state.guest.once.mockImplementation(() => state.guest);
    state.guest.removeListener.mockImplementation(() => state.guest);
    state.guest.close.mockImplementation(() => undefined);
    state.proxy.close.mockResolvedValue(undefined);
    state.paneInfo.mockReturnValue(null);
    state.getMissionWorkflow.mockReturnValue({ contract: null, workflow: null });
    profileHarness.mode = 'isolated';
    profileHarness.assertConnection = undefined;
  });

  it('lets the outgoing personal profile flush its immutable view after a workspace switch', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    registerBrowserIpc({} as never);
    profileHarness.mode = 'personal';
    await ensureBrowser(state.owner as never, scope, 'pane-outgoing-profile');
    bindResolvedRendererWorkspaceScope(state.owner, scopeB);
    // A troca só afasta a vista (F-168); o perfil ainda descarrega quando ela
    // encerra, com a janela já noutro projeto.
    expect(state.guest.close).not.toHaveBeenCalled();
    expect(() => profileHarness.assertConnection?.()).not.toThrow();
    destroyBrowser('pane-outgoing-profile', scope);
    await vi.waitFor(() => expect(state.guest.close).toHaveBeenCalled());
    clearRendererWorkspaceScope(state.owner);
  });

  it('parks a browser when the window switches project and hands the live page back', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    registerBrowserIpc({} as never);
    await ensureBrowser(state.owner as never, scope, 'pane-parked');
    const view = state.views.at(-1)!;

    // Campo 26/09: o operador foi a outro projeto e o agente perdeu o painel
    // do Coolify ("unknown pane") até voltar — e voltava sem a página.
    bindResolvedRendererWorkspaceScope(state.owner, scopeB);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(state.guest.close).not.toHaveBeenCalled();
    expect(getBrowserViewCount()).toBe(1);

    // O agente do projeto segue navegando com a janela noutro projeto.
    await loadBrowser('pane-parked', 'https://app.coolify.io/servers', { scope });
    expect(state.guest.loadURL).toHaveBeenCalledWith('https://app.coolify.io/servers');

    // Na volta, o layout salvo traz a URL de quando a janela saiu; a página
    // viva vence e nada recarrega.
    state.guest.getURL.mockReturnValue('https://app.coolify.io/servers');
    state.guest.loadURL.mockClear();
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    const back = await ensureBrowser(
      state.owner as never,
      scope,
      'pane-parked',
      'https://app.coolify.io/projects',
    );
    expect(state.guest.loadURL).not.toHaveBeenCalled();
    expect(back.url).toBe('https://app.coolify.io/servers');
    expect(state.owner.send).toHaveBeenCalledWith(
      BROWSER_CHANNELS.state,
      expect.objectContaining({
        paneId: 'pane-parked',
        url: 'https://app.coolify.io/servers',
      }),
    );

    // Readotada, a vista volta a seguir a URL que o renderer pedir.
    await ensureBrowser(
      state.owner as never,
      scope,
      'pane-parked',
      'https://app.coolify.io/projects',
    );
    await vi.waitFor(() =>
      expect(state.guest.loadURL).toHaveBeenCalledWith('https://app.coolify.io/projects'),
    );
    destroyBrowser('pane-parked', scope);
    expect(forgetParkedBrowserPane).toHaveBeenCalledWith(
      state.owner,
      'pane-parked',
      scope,
    );
    clearRendererWorkspaceScope(state.owner);
  });

  it('ends only the closed project browsers and keeps the ones parked from another project', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    registerBrowserIpc({} as never);
    await ensureBrowser(state.owner as never, scope, 'pane-kept');
    bindResolvedRendererWorkspaceScope(state.owner, scopeB);
    await ensureBrowser(state.owner as never, scopeB, 'pane-closed');
    expect(getBrowserViewCount()).toBe(2);

    // Fechar o projeto B encerra os navegadores dele, como os terminais.
    clearRendererWorkspaceScope(state.owner);
    expect(getBrowserViewCount()).toBe(1);

    // Tirar A da lista é fechamento explícito do que ficou afastado dele.
    forgetRendererWorkspace(state.owner, scope.rootRealPath);
    expect(getBrowserViewCount()).toBe(0);
  });

  it('closes a parked browser when the agent closes it with the project off screen', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    registerBrowserIpc({} as never);
    await ensureBrowser(state.owner as never, scope, 'pane-agent-closed');
    bindResolvedRendererWorkspaceScope(state.owner, scopeB);
    const closer = vi.mocked(registerParkedBrowserCloser).mock.calls.at(-1)?.[0];
    expect(closer).toBeTypeOf('function');

    closer!(state.owner as never, 'pane-agent-closed', scope);
    expect(getBrowserViewCount()).toBe(0);

    // O layout salvo de A ainda traz o pane; na volta ele não renasce.
    vi.mocked(wasParkedBrowserClosed).mockReturnValueOnce(true);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    await expect(
      ensureBrowser(state.owner as never, scope, 'pane-agent-closed', 'https://example.com/'),
    ).rejects.toThrow(/closed while its project was in the background/);
    expect(getBrowserViewCount()).toBe(0);
    clearRendererWorkspaceScope(state.owner);
  });

  it('still ends an automated review browser when the window switches project', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    registerBrowserIpc({} as never);
    await ensureBrowser(state.owner as never, scope, 'pane-review-switch');
    const approved = 'http://127.0.0.1:43112/';
    state.guest.getURL.mockReturnValue(approved);
    lockBrowserToExactUrl('pane-review-switch', scope, approved);

    bindResolvedRendererWorkspaceScope(state.owner, scopeB);
    expect(getBrowserViewCount()).toBe(0);
    expect(state.guest.close).toHaveBeenCalled();
    clearRendererWorkspaceScope(state.owner);
  });

  it('locks an automated review WebContents to the exact approved URL', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    await ensureBrowser(state.owner as never, scope, 'pane-review-lock');
    const approved = 'http://127.0.0.1:43111/';
    state.guest.getURL.mockReturnValue(approved);
    lockBrowserToExactUrl('pane-review-lock', scope, approved);
    expect(() =>
      assertBrowserAtExactUrl('pane-review-lock', scope, approved),
    ).not.toThrow();

    const willNavigate = state.guest.on.mock.calls.find(
      ([event]) => event === 'will-navigate',
    )?.[1] as ((event: { preventDefault(): void }, url: string) => void) | undefined;
    expect(willNavigate).toBeTypeOf('function');
    const blocked = { preventDefault: vi.fn() };
    willNavigate!(blocked, 'https://attacker.example/');
    expect(blocked.preventDefault).toHaveBeenCalledOnce();

    const allowed = { preventDefault: vi.fn() };
    willNavigate!(allowed, approved);
    expect(allowed.preventDefault).not.toHaveBeenCalled();

    state.guest.getURL.mockReturnValue('https://attacker.example/');
    expect(() =>
      assertBrowserAtExactUrl('pane-review-lock', scope, approved),
    ).toThrow(/left its approved local preview URL/i);
    destroyBrowser('pane-review-lock', scope);
  });

  it('awaits both WebContents destruction and pinned proxy shutdown for review cleanup', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    await ensureBrowser(state.owner as never, scope, 'pane-review-proof');
    let destroyed = false;
    let onDestroyed: (() => void) | undefined;
    state.guest.isDestroyed.mockImplementation(() => destroyed);
    state.guest.once.mockImplementation((event: string, handler: () => void) => {
      if (event === 'destroyed') onDestroyed = handler;
      return state.guest;
    });
    state.guest.close.mockImplementation(() => {
      destroyed = true;
      onDestroyed?.();
    });
    let resolveProxy!: () => void;
    state.proxy.close.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveProxy = resolve;
      }),
    );

    let settled = false;
    const cleanup = destroyBrowserWithProof(
      'pane-review-proof',
      scope,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(state.guest.close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    resolveProxy();
    await expect(cleanup).resolves.toBeUndefined();
    expect(state.guest.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(state.proxy.close).toHaveBeenCalledOnce();
  });

  it('fails physical proof when WebContents close throws or destroyed state stays false', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    await ensureBrowser(state.owner as never, scope, 'pane-review-close-throw');
    state.guest.close.mockImplementationOnce(() => {
      throw new Error('close refused');
    });
    await expect(
      destroyBrowserWithProof('pane-review-close-throw', scope),
    ).rejects.toThrow(/close failed.*close refused/i);
    expect(state.proxy.close).toHaveBeenCalledOnce();

    await ensureBrowser(state.owner as never, scope, 'pane-review-still-live');
    let onDestroyed: (() => void) | undefined;
    state.guest.once.mockImplementation((event: string, handler: () => void) => {
      if (event === 'destroyed') onDestroyed = handler;
      return state.guest;
    });
    state.guest.close.mockImplementationOnce(() => {
      onDestroyed?.();
    });
    await expect(
      destroyBrowserWithProof('pane-review-still-live', scope),
    ).rejects.toThrow(/WebContents remains alive/i);
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

  it('does not call loadURL after authority is revoked during DNS assessment', async () => {
    installPinnedBrowserProxy.mockResolvedValue(state.proxy);
    await ensureBrowser(state.owner as never, scope, 'pane-revoked-dns');
    state.guest.loadURL.mockClear();
    let resolveDns!: (value: {
      endpoints: Array<{ address: string; port: number }>;
    }) => void;
    state.browserSession.resolveHost.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDns = resolve;
      }),
    );
    let current = true;
    const pending = loadBrowser(
      'pane-revoked-dns',
      'https://example.com/',
      {
        scope,
        assertCurrentAuthority: () => {
          if (!current) throw new Error('session_authority_revoked');
        },
      },
    );
    await vi.waitFor(() =>
      expect(state.browserSession.resolveHost).toHaveBeenCalled(),
    );
    current = false;
    resolveDns({ endpoints: [{ address: '93.184.216.34', port: 0 }] });

    await expect(pending).rejects.toThrow('session_authority_revoked');
    expect(state.guest.loadURL).not.toHaveBeenCalled();
    destroyBrowser('pane-revoked-dns', scope);
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
