import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-test',
  projectId: 'project-test',
  checkoutId: 'checkout-test',
  rootRealPath: '/workspace/test',
  identitySource: 'manifest',
});

const state = vi.hoisted(() => {
  const browserSession = {
    resolveHost: vi.fn(async () => ({
      endpoints: [{ address: '93.184.216.34', port: 0 }],
    })),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn(),
      onCompleted: vi.fn((listener: unknown) => {
        guestHandlers.set('webRequest:onCompleted', [
          listener as (...args: unknown[]) => void,
        ]);
      }),
    },
  };
  const guestHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const guest = {
    id: 22,
    session: browserSession,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      guestHandlers.set(event, [...(guestHandlers.get(event) ?? []), handler]);
      return guest;
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      guestHandlers.set(event, [...(guestHandlers.get(event) ?? []), handler]);
      return guest;
    }),
    removeListener: vi.fn(),
    send: vi.fn(),
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
    getUserAgent: vi.fn(() => 'desktop-ua'),
    setUserAgent: vi.fn(),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
    reload: vi.fn(),
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
    browserSession,
    guest,
    guestHandlers,
    owner,
    win,
    proxy,
    runAutomation: vi.fn(
      async (_paneId: string, _wc: unknown, command: string): Promise<unknown> => {
        if (command === 'click') {
          return {
            clicked: true,
            element: { ref: 'e1', tag: 'button', role: 'button', name: 'OK' },
          };
        }
        if (command === 'read') {
          return {
            url: 'https://example.test/app',
            title: 'App',
            readyState: 'complete',
            bodyText: 'Corpo visível',
            headings: [{ level: 1, text: 'App' }],
            elements: [],
            truncated: false,
            viewport: {
              scrollY: 0,
              scrollHeight: 800,
              innerHeight: 800,
              pagesBelow: 0,
            },
            alerts: [],
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    ),
    fromPartition: vi.fn((_partition: string) => browserSession),
    handlers: new Map<string, (...args: any[]) => unknown>(),
    paneInfo: vi.fn(),
    getMissionWorkflow: vi.fn(),
    assertMutationAllowed: vi.fn(),
    fromWebContents: vi.fn(() => win),
    webContentsAvailable: true,
    views: [] as Array<{ setVisible: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn> }>,
  };
});

function fire(event: string, ...args: unknown[]): void {
  for (const handler of state.guestHandlers.get(event) ?? []) {
    handler(...args);
  }
}

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: state.fromWebContents },
  WebContentsView: class MockWebContentsView {
    get webContents() {
      return state.webContentsAvailable ? state.guest : undefined;
    }
    setVisible = vi.fn();
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();

    constructor(_options: { webPreferences: Record<string, unknown> }) {
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

vi.mock('./browser-automation-runtime', () => ({
  runBrowserAutomation: state.runAutomation,
  registerBrowserAutomationResponseHandler: vi.fn(),
  rejectPendingBrowserAutomation: vi.fn(),
}));

const installPinnedBrowserProxy = vi.hoisted(() => vi.fn());
vi.mock('./browser-network-proxy', () => ({
  installPinnedBrowserProxy,
}));

vi.mock('../orch/preview-server', () => ({
  isRunningPreviewUrl: () => false,
  isRunningPreviewUrlForScope: () => false,
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
vi.mock('./browser-personal-profile', () => ({
  browserProfileMode: () => 'isolated',
  rememberAgentBrowser: vi.fn(),
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({
    getMissionWorkflow: state.getMissionWorkflow,
    assertMutationAllowed: state.assertMutationAllowed,
  }),
}));

vi.mock('../orch/design-send', () => ({
  sendDesignSelectionToAgent: vi.fn(),
}));

import {
  clickBrowserElement,
  destroyBrowser,
  ensureBrowser,
  loadBrowser,
  pressBrowserKey,
  readBrowserPage,
  setBrowserBounds,
} from './browser-manager';
import { isAgentRequestedBrowser } from '../orch/pane-registry';

const PANE = 'pane-actions-test';

async function boot(): Promise<void> {
  installPinnedBrowserProxy.mockResolvedValue(state.proxy);
  await ensureBrowser(state.owner as never, scope, PANE);
}

describe('browser manager actions (after/changed, errors, judge, text)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.guestHandlers.clear();
    state.views.length = 0;
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(false);
    destroyBrowser(PANE, scope);
    state.guest.getURL.mockReturnValue('about:blank');
    state.guest.getTitle.mockReturnValue('');
    state.guest.isDestroyed.mockReturnValue(false);
    state.guest.on.mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        state.guestHandlers.set(event, [
          ...(state.guestHandlers.get(event) ?? []),
          handler,
        ]);
        return state.guest;
      },
    );
    state.guest.once.mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        state.guestHandlers.set(event, [
          ...(state.guestHandlers.get(event) ?? []),
          handler,
        ]);
        return state.guest;
      },
    );
    state.guest.removeListener.mockImplementation(() => state.guest);
    state.paneInfo.mockReturnValue(null);
    state.getMissionWorkflow.mockReturnValue({ contract: null, workflow: null });
    state.runAutomation.mockImplementation(
      async (_paneId: string, _wc: unknown, command: string) => {
        if (command === 'click') {
          return {
            clicked: true,
            element: { ref: 'e1', tag: 'button', role: 'button', name: 'OK' },
          };
        }
        if (command === 'press') return { pressed: true, key: 'Enter' };
        if (command === 'read') {
          return {
            url: 'https://example.test/app',
            title: 'App',
            readyState: 'complete',
            bodyText: 'Corpo visível',
            headings: [{ level: 1, text: 'App' }],
            elements: [],
            truncated: false,
            viewport: {
              scrollY: 0,
              scrollHeight: 800,
              innerHeight: 800,
              pagesBelow: 0,
            },
            alerts: [],
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    );
  });

  it('click by ref gains after/changed and an error report', async () => {
    await boot();
    const result = await clickBrowserElement(PANE, scope, 'e1');
    expect(result.clicked).toBe(true);
    expect(result.changed).toEqual({
      url: false,
      title: false,
      navigated: 'none',
    });
    expect(result.after?.loading).toBe(false);
    expect(result.errors).toEqual({
      consoleErrors: 0,
      httpErrors: 0,
      loadErrors: 0,
      items: [],
    });
    destroyBrowser(PANE, scope);
  });

  it('reports a new-document navigation that starts during the action', async () => {
    await boot();
    state.guest.getURL.mockReturnValue('https://example.test/app');
    state.runAutomation.mockImplementation(async (_p, _wc, command: string) => {
      if (command !== 'click') throw new Error('unexpected');
      fire('did-start-navigation', {}, 'https://example.test/depois', false, true);
      fire('did-start-loading');
      fire('did-navigate', {}, 'https://example.test/depois');
      state.guest.getURL.mockReturnValue('https://example.test/depois');
      setTimeout(() => fire('did-stop-loading'), 0);
      return {
        clicked: true,
        element: { ref: 'e1', tag: 'button', role: 'button', name: 'OK' },
      };
    });
    const result = await clickBrowserElement(PANE, scope, 'e1');
    expect(result.changed?.navigated).toBe('new-document');
    expect(result.changed?.url).toBe(true);
    destroyBrowser(PANE, scope);
  });

  it('reports a same-document navigation via did-navigate-in-page', async () => {
    await boot();
    state.guest.getURL.mockReturnValue('https://example.test/app#secao');
    state.runAutomation.mockImplementation(async (_p, _wc, command: string) => {
      if (command !== 'click') throw new Error('unexpected');
      fire('did-start-navigation', {}, 'https://example.test/app#secao', true, true);
      fire('did-navigate-in-page', {}, 'https://example.test/app#secao');
      return {
        clicked: true,
        element: { ref: 'e1', tag: 'button', role: 'button', name: 'OK' },
      };
    });
    const result = await clickBrowserElement(PANE, scope, 'e1');
    expect(result.changed?.navigated).toBe('same-document');
    destroyBrowser(PANE, scope);
  });

  it('counts console/http/load errors since the previous action', async () => {
    await boot();
    // Errors observed during the action are reported on its result.
    state.runAutomation.mockImplementation(async (_p, _wc, command: string) => {
      if (command === 'read') {
        return {
          url: 'https://example.test/app',
          title: 'App',
          readyState: 'complete',
          bodyText: 'Corpo visível',
          headings: [],
          elements: [],
          truncated: false,
          viewport: {
            scrollY: 0,
            scrollHeight: 800,
            innerHeight: 800,
            pagesBelow: 0,
          },
          alerts: [],
        };
      }
      if (command !== 'click') throw new Error('unexpected');
      // Modern signature: (event, messageDetails).
      fire('console-message', {}, { level: 3, message: 'TypeError: boom' });
      // Legacy positional signature: (event, level, message, line, sourceId).
      fire('console-message', {}, 'error', 'legacy positional boom', 1, 'x');
      fire('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.test/x', true);
      state.guestHandlers.get('webRequest:onCompleted')?.[0]?.({
        webContentsId: state.guest.id,
        statusCode: 500,
        method: 'GET',
        url: 'https://example.test/api?token=segredo',
      });
      return {
        clicked: true,
        element: { ref: 'e1', tag: 'button', role: 'button', name: 'OK' },
      };
    });

    const first = await clickBrowserElement(PANE, scope, 'e1');
    expect(first.errors?.consoleErrors).toBe(2);
    expect(first.errors?.httpErrors).toBe(1);
    expect(first.errors?.loadErrors).toBe(1);
    expect(first.errors?.items.length).toBe(4);
    const http = first.errors?.items.find((item) => item.kind === 'http');
    expect(http?.urlPath).not.toContain('segredo');

    // read reports the same window without resetting it.
    const read = await readBrowserPage(PANE, scope);
    expect(read.errors.consoleErrors).toBe(2);
    // the next action opens a fresh window
    state.runAutomation.mockImplementation(async (_p, _wc, command: string) => {
      if (command !== 'click') throw new Error('unexpected');
      return {
        clicked: true,
        element: { ref: 'e1', tag: 'button', role: 'button', name: 'OK' },
      };
    });
    const second = await clickBrowserElement(PANE, scope, 'e1');
    expect(second.errors?.consoleErrors).toBe(0);
    destroyBrowser(PANE, scope);
  });

  it('resolves click by accessible text and returns candidates on ambiguity', async () => {
    await boot();
    const find = vi.fn(async () => ({
      paneId: PANE,
      matches: [
        { ref: 'e9', tag: 'a', role: 'link', name: 'Ver squads', score: 1 },
      ],
      total: 1,
    }));
    const resolved = await clickBrowserElement(PANE, scope, { text: 'Ver squads' }, {
      deps: { find },
    });
    expect(resolved.clicked).toBe(true);
    expect(resolved.resolvedBy).toBe('text');

    const ambiguous = await clickBrowserElement(PANE, scope, { text: 'menu' }, {
      deps: {
        find: vi.fn(async () => ({
          paneId: PANE,
          matches: [
            { ref: 'e1', tag: 'button', role: 'button', name: 'Menu A', score: 0.75 },
            { ref: 'e2', tag: 'button', role: 'button', name: 'Menu B', score: 0.75 },
          ],
          total: 2,
        })),
        jevEnabled: () => false,
      },
    });
    expect(ambiguous.clicked).toBe(false);
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.candidates).toHaveLength(2);

    await expect(
      clickBrowserElement(PANE, scope, { text: 'inexistente' }, {
        deps: {
          find: vi.fn(async () => ({ paneId: PANE, matches: [], total: 0 })),
        },
      }),
    ).rejects.toThrow(/nenhum elemento visível combina/i);
    destroyBrowser(PANE, scope);
  });

  it('uses Jev to break a 2-5 candidate tie at confidence >= 0.7', async () => {
    await boot();
    const jev = vi.fn(async (_req: unknown) => ({
      model: 'test-model',
      answers: {
        element: {
          type: 'choice' as const,
          choice: 'e2',
          probabilities: { e1: 0.2, e2: 0.8 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const find = vi.fn(async () => ({
      paneId: PANE,
      matches: [
        { ref: 'e1', tag: 'button', role: 'button', name: 'Menu A', score: 0.75 },
        { ref: 'e2', tag: 'button', role: 'button', name: 'Menu B', score: 0.75 },
      ],
      total: 2,
    }));
    const recordDecision = vi.fn();
    const result = await clickBrowserElement(PANE, scope, { text: 'menu' }, {
      deps: {
        find,
        jev,
        jevEnabled: () => true,
        jevReady: () => true,
        recordDecision,
      },
    });
    expect(jev).toHaveBeenCalledOnce();
    expect(jev.mock.calls[0][0]).toMatchObject({ surface: 'browserTool' });
    expect(result.clicked).toBe(true);
    expect(result.resolvedBy).toBe('jev');
    expect(result.confidence).toBe(0.8);
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'browserTool' }),
    );
    destroyBrowser(PANE, scope);
  });

  it('attaches a Jev page judgment to read and fails open', async () => {
    await boot();
    const jev = vi.fn(async (_req: unknown) => ({
      model: 'test-model',
      answers: {
        errorVisible: { type: 'noul' as const, noul: 0.1 },
        blockedByHuman: { type: 'noul' as const, noul: 0.9 },
        stillLoading: { type: 'noul' as const, noul: 0.0 },
        pageKind: {
          type: 'choice' as const,
          choice: 'login',
          probabilities: { login: 0.95 },
          confidence: 0.95,
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const judged = await readBrowserPage(PANE, scope, {
      judge: true,
      deps: {
        jev,
        jevEnabled: () => true,
        jevReady: () => true,
        recordDecision: vi.fn(),
      },
    });
    expect(judged.judgment).toEqual({
      errorVisible: 0.1,
      blockedByHuman: 0.9,
      stillLoading: 0,
      pageKind: { choice: 'login', confidence: 0.95 },
      model: 'test-model',
    });
    expect(jev.mock.calls[0][0]).toMatchObject({
      surface: 'browserTool',
      timeoutMs: 4_000,
    });

    const disabled = await readBrowserPage(PANE, scope, {
      judge: true,
      deps: { jevEnabled: () => false },
    });
    expect(disabled.judgment).toBeNull();
    expect(disabled.judgmentSkipped).toBe('surface-disabled');

    const failing = await readBrowserPage(PANE, scope, {
      judge: true,
      deps: {
        jev: vi.fn(async (_req: unknown) => {
          throw new Error('offline');
        }),
        jevEnabled: () => true,
        jevReady: () => true,
      },
    });
    expect(failing.judgment).toBeNull();
    expect(failing.judgmentSkipped).toBe('judge-unavailable');
    destroyBrowser(PANE, scope);
  });

  it('press returns after/changed and errors too', async () => {
    await boot();
    const result = await pressBrowserKey(PANE, scope, { key: 'Enter' });
    expect(result.pressed).toBe(true);
    expect(result.changed?.navigated).toBe('none');
    expect(result.errors).toBeDefined();
    destroyBrowser(PANE, scope);
  });
});

describe('loadBrowser device emulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.guestHandlers.clear();
    state.views.length = 0;
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(false);
    destroyBrowser(PANE, scope);
    state.guest.getURL.mockReturnValue('about:blank');
    state.guest.isDestroyed.mockReturnValue(false);
    state.guest.once.mockImplementation(() => state.guest);
    state.guest.removeListener.mockImplementation(() => state.guest);
  });

  it('emulates the mobile breakpoint before navigating, reusing the real UA/viewport', async () => {
    await boot();
    await loadBrowser(PANE, 'https://example.test/app', { scope, device: 'mobile' });
    expect(state.guest.setUserAgent).toHaveBeenCalledWith(
      expect.stringContaining('iPhone'),
    );
    expect(state.guest.enableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ viewSize: { width: 390, height: 844 } }),
    );
    destroyBrowser(PANE, scope);
  });

  it('emulates the tablet breakpoint with the iPad UA', async () => {
    await boot();
    await loadBrowser(PANE, 'https://example.test/app', { scope, device: 'tablet' });
    expect(state.guest.setUserAgent).toHaveBeenCalledWith(
      expect.stringContaining('iPad'),
    );
    expect(state.guest.enableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ viewSize: { width: 800, height: 1366 } }),
    );
    destroyBrowser(PANE, scope);
  });

  it('desktop disables emulation and restores the original UA', async () => {
    await boot();
    await loadBrowser(PANE, 'https://example.test/mobile', { scope, device: 'mobile' });
    await loadBrowser(PANE, 'https://example.test/desktop', { scope, device: 'desktop' });
    expect(state.guest.disableDeviceEmulation).toHaveBeenCalledOnce();
    expect(state.guest.setUserAgent).toHaveBeenLastCalledWith('desktop-ua');
    destroyBrowser(PANE, scope);
  });

  it('leaves emulation untouched when no device is requested', async () => {
    await boot();
    await loadBrowser(PANE, 'https://example.test/app', { scope });
    expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(state.guest.disableDeviceEmulation).not.toHaveBeenCalled();
    destroyBrowser(PANE, scope);
  });
});

describe('setBrowserBounds viewport floor for agent-owned panes', () => {
  it('gives an agent-owned pane a decent off-window viewport instead of a degenerate UI slot', async () => {
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(true);
    await boot();
    const view = state.views.at(-1)!;
    setBrowserBounds(
      { view, agentOwned: true } as never,
      { x: 10, y: 10, width: 356, height: 138 },
    );
    expect(view.setVisible).toHaveBeenCalledWith(true);
    expect(view.setBounds).toHaveBeenCalledWith({
      x: 50_000,
      y: 50_000,
      width: 1280,
      height: 800,
    });
    destroyBrowser(PANE, scope);
  });

  it('leaves the operator-owned pane untouched at its real, small size', async () => {
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(false);
    await boot();
    const view = state.views.at(-1)!;
    setBrowserBounds(
      { view, agentOwned: false } as never,
      { x: 10, y: 10, width: 356, height: 138 },
    );
    expect(view.setBounds).toHaveBeenCalledWith({
      x: 10,
      y: 10,
      width: 356,
      height: 138,
    });
    destroyBrowser(PANE, scope);
  });
});
