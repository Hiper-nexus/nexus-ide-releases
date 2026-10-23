import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-test',
  projectId: 'project-test',
  checkoutId: 'checkout-test',
  rootRealPath: '/workspace/test',
  identitySource: 'manifest',
});

/** Structural NativeImage double: size, encodings and a proportional resize. */
function fakeImage(width: number, height: number, png: Buffer = Buffer.from('png')): {
  getSize: () => { width: number; height: number };
  toPNG: () => Buffer;
  toJPEG: (quality: number) => Buffer;
  resize: (size: { width?: number; height?: number }) => ReturnType<typeof fakeImage>;
} {
  return {
    getSize: () => ({ width, height }),
    toPNG: () => png,
    toJPEG: () => Buffer.from('jpeg'),
    resize: (size) => {
      const ratio = size.width ? size.width / width : (size.height ?? height) / height;
      return fakeImage(Math.round(width * ratio), Math.round(height * ratio), png);
    },
  };
}

const state = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (...args: unknown[]) => void>();
  const browserSession = {
    resolveHost: vi.fn(async () => ({
      endpoints: [{ address: '93.184.216.34', port: 0 }],
    })),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    // Session handlers are installed once per session (securedSessions), so
    // keep them outside the per-test mock call log.
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      sessionHandlers.set(event, handler);
    }),
    webRequest: {
      onBeforeRequest: vi.fn(),
      onCompleted: vi.fn((listener: unknown) => {
        guestHandlers.set('webRequest:onCompleted', [
          listener as (...args: unknown[]) => void,
        ]);
      }),
      onErrorOccurred: vi.fn((listener: unknown) => {
        guestHandlers.set('webRequest:onErrorOccurred', [
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
    goBack: vi.fn(),
    goForward: vi.fn(),
    isLoading: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    debugger: { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async ():Promise<unknown> => ({ root: {} })), on: vi.fn(), removeListener: vi.fn() },

    setWebRTCIPHandlingPolicy: vi.fn(),
    loadURL: vi.fn(async () => {}),
    stop: vi.fn(),
    close: vi.fn(),
    getUserAgent: vi.fn(() => 'desktop-ua'),
    setUserAgent: vi.fn(),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
    reload: vi.fn(),
    capturePage: vi.fn(async (rect?: { width: number; height: number }) => ({
      getSize: () => ({ width: rect?.width ?? 1280, height: rect?.height ?? 800 }),
      toPNG: () => Buffer.from('png'),
    })),
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
    sessionHandlers,
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
    onHandlers: new Map<string, (...args: any[]) => unknown>(),
    paneInfo: vi.fn(),
    getMissionWorkflow: vi.fn(),
    assertMutationAllowed: vi.fn(),
    fromWebContents: vi.fn(() => win),
    webContentsAvailable: true,
    profileMode: 'isolated' as 'isolated' | 'personal',
    decisionConfiguration: 'initial',
    canVisual: vi.fn(() => false),
    visualJudge: vi.fn(async () => ({ status: 'answered' as const, signals: {}, model: 'clef', route: 'test' })),
    encodeBitmap: vi.fn((_bitmap: Buffer, _size: unknown) => ({ toPNG: () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2WQAAAAASUVORK5CYII=', 'base64') })),
    imageFromBuffer: vi.fn((buffer: Buffer) => fakeImage(1280, 3000, buffer)),
    views: [] as Array<{
      setVisible: ReturnType<typeof vi.fn>;
      setBounds: ReturnType<typeof vi.fn>;
      getBounds: ReturnType<typeof vi.fn>;
      webPreferences: Record<string, unknown>;
    }>,
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
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 800 }));
    setBackgroundColor = vi.fn();

    readonly webPreferences: Record<string, unknown>;

    constructor(options: { webPreferences: Record<string, unknown> }) {
      this.webPreferences = options.webPreferences;
      state.views.push(this);
    }
  },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) =>
      state.handlers.set(channel, handler),
    on: (channel: string, handler: (...args: any[]) => unknown) =>
      state.onHandlers.set(channel, handler),
  },
  session: { fromPartition: state.fromPartition },
  nativeImage: { createFromBitmap: state.encodeBitmap, createFromBuffer: state.imageFromBuffer },
}));

vi.mock('./browser-artifact-store', () => ({
  createScopedBrowserArtifactStore: () => ({
    assertWritable: vi.fn(),
    recordScreenshot: vi.fn((shot: { width: number }) => ({
      id: `shot-${shot.width}`,
      projectId: 'project-test',
      checkoutId: 'checkout-test',
      path: `/tmp/shot-${shot.width}.png`,
      storageKey: `shot-${shot.width}`,
      sha256: 'x'.repeat(64),
    })),
  }),
}));

vi.mock('./browser-automation-runtime', () => ({
  runBrowserAutomation: state.runAutomation,
  registerBrowserAutomationResponseHandler: vi.fn(),
  rejectPendingBrowserAutomation: vi.fn(),
}));

vi.mock('../decision-models/decision-availability', async original => ({
  ...await original<typeof import('../decision-models/decision-availability')>(),
  decisionConfigurationKey: () => state.decisionConfiguration,
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
  browserProfileMode: () => state.profileMode,
  connectPersonalProfile: vi.fn(async () => async () => {}),
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

vi.mock('./browser-visual-judgment', () => ({
  canJudgeBrowserVisual: () => state.canVisual(),
  judgeBrowserVisual: state.visualJudge,
}));

import {
  analyzeBrowserResponsive,
  captureBrowserScreenshot,
  RESPONSIVE_LOAD_TIMEOUT_MS,
  clickBrowserElement,
  destroyBrowser,
  ensureBrowser,
  historyBrowserPane,
  hoverBrowserElement,
  selectBrowserOption,
  loadBrowser,
  lockBrowserToExactUrl,
  openCdpRelayForPane,
  pressBrowserKey,
  readBrowserPage,
  readBrowserPageCompact,
  registerBrowserIpc,
  captureRedactedBrowserVisual,
} from './browser-manager';
import { BROWSER_CHANNELS } from '../../shared/channels';
import { bindResolvedRendererWorkspaceScope, clearRendererWorkspaceScope, forgetRendererWorkspace } from '../persistence/renderer-workspace-scope';
import { isAgentRequestedBrowser } from '../orch/pane-registry';

const PANE = 'pane-actions-test';

async function boot(): Promise<void> {
  installPinnedBrowserProxy.mockResolvedValue(state.proxy);
  await ensureBrowser(state.owner as never, scope, PANE);
}

/**
 * Pane que já commitou um documento — o estado de um pane real com página
 * aberta. O `getURL()` do fixture já devolve a página; sem o `did-navigate`
 * o Main não teria prova do RenderWidgetHostView e a emulação de device
 * ficaria (corretamente) pendente.
 */
async function bootCommitted(url = 'https://example.test/app'): Promise<void> {
  await boot();
  fire('did-navigate', {}, url);
}

describe('browser manager actions (after/changed, errors, judge, text)', () => {
  it('captures only a scoped masked copy and rejects navigation or mask movement', async () => {
    await boot();
    const masks = { width: 4, height: 4, scrollX: 0, scrollY: 0, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] };
    state.runAutomation.mockResolvedValue(masks);
    const original = Buffer.alloc(8 * 8 * 4, 70);
    const captured = { getSize: () => ({ width: 8, height: 8 }), toBitmap: () => original } as never;
    state.guest.capturePage.mockResolvedValueOnce(captured).mockResolvedValueOnce(captured);
    const snapshot = await captureRedactedBrowserVisual(PANE, scope);
    expect(snapshot.image.content_type).toBe('image/png');
    expect(state.encodeBitmap.mock.calls[0][0].subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 255]));
    expect(original[0]).toBe(70);
    fire('did-start-navigation', {}, 'https://example.test/new', false, true);
    expect(snapshot.assertCurrent).toThrow('visual snapshot changed');
    state.runAutomation.mockResolvedValueOnce(masks).mockResolvedValueOnce({ ...masks, scrollY: 10 });
    await expect(captureRedactedBrowserVisual(PANE, scope)).rejects.toThrow('visual masks changed');
    state.guest.capturePage.mockClear();
    await expect(captureRedactedBrowserVisual(PANE, { ...scope, checkoutId: 'another' })).rejects.toThrow();
    expect(state.guest.capturePage).not.toHaveBeenCalled();
  });
  it('rejects a capture whose sensitive rectangles moved between the two collections', async () => {
    await boot();
    const base = { width: 4, height: 4, scrollX: 0, scrollY: 0 };
    const first = { ...base, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] };
    const moved = { ...base, rectangles: [{ x: 2, y: 2, width: 1, height: 1 }] };
    const captured = { getSize: () => ({ width: 8, height: 8 }), toBitmap: () => Buffer.alloc(8 * 8 * 4, 70) } as never;
    state.runAutomation.mockResolvedValueOnce(first).mockResolvedValueOnce(moved);
    state.guest.capturePage.mockResolvedValueOnce(captured);
    state.encodeBitmap.mockClear();
    await expect(captureRedactedBrowserVisual(PANE, scope)).rejects.toThrow('visual masks changed');
    expect(state.encodeBitmap).not.toHaveBeenCalled();
  });
  it('refuses to capture a pane bound to the personal profile before touching the page', async () => {
    state.profileMode = 'personal';
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    await boot();
    state.runAutomation.mockClear(); state.guest.capturePage.mockClear();
    await expect(captureRedactedBrowserVisual(PANE, scope)).rejects.toMatchObject({
      code: 'personal_profile', message: expect.stringContaining('perfil pessoal'),
    });
    expect(state.runAutomation).not.toHaveBeenCalled();
    expect(state.guest.capturePage).not.toHaveBeenCalled();
    expect(state.guest.debugger.sendCommand).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    state.decisionConfiguration = 'initial';
    state.profileMode = 'isolated';
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

  it('asks Jev with the first-option check and returns candidates outside the 2–5 range', async () => {
    await boot();
    const jev = vi.fn(async (_req: unknown) => ({
      model: 'test-model',
      answers: { element: { type: 'choice' as const, choice: 'e1', probabilities: {}, confidence: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const deps = { jev, jevEnabled: () => true, jevReady: () => true, recordDecision: vi.fn() };
    const many = Array.from({ length: 8 }, (_, index) => ({
      ref: `e${index + 1}`, tag: 'button', role: 'button', name: `Excluir ${index + 1}`, score: 0.75,
    }));
    const crowded = await clickBrowserElement(PANE, scope, { text: 'excluir' }, {
      deps: { ...deps, find: vi.fn(async () => ({ paneId: PANE, matches: many, total: 8 })) },
    });
    expect(jev).not.toHaveBeenCalled();
    expect(crowded.clicked).toBe(false);
    expect(crowded.ambiguous).toBe(true);
    expect(crowded.candidates).toHaveLength(8);
    expect(state.runAutomation).not.toHaveBeenCalledWith(PANE, expect.anything(), 'click', expect.anything(),
      undefined, expect.anything());

    const tied = await clickBrowserElement(PANE, scope, { text: 'excluir' }, {
      deps: { ...deps, find: vi.fn(async () => ({ paneId: PANE, matches: many.slice(0, 2), total: 2 })) },
    });
    expect(tied.resolvedBy).toBe('jev');
    expect(jev.mock.calls[0][0]).toMatchObject({
      orderCheck: { minConfidence: 0.7 },
      timeoutMs: expect.any(Number),
    });
    expect((jev.mock.calls[0][0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(1_500);
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
      retryOnTimeout: false,
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

  it('reuses an identical focused read, invalidates changed text and keeps full text when disabled', async () => {
    await boot();
    const originalRead = await state.runAutomation(PANE, state.guest, 'read') as Record<string, unknown>;
    let bodyText = 'Resposta. '.repeat(90) + 'Detalhes. '.repeat(180);
    state.runAutomation.mockImplementation(async () => ({ ...originalRead, bodyText }));
    const jev = vi.fn(async (_req: unknown) => ({
      model: 'test-model',
      answers: {
        errorVisible: { type: 'noul' as const, noul: 0.1 },
        focus_p0: { type: 'noul' as const, noul: 0.95 },
        focus_p1: { type: 'noul' as const, noul: 0.1 },
        focus_p2: { type: 'noul' as const, noul: 0.1 },
      },
      usage: { input_tokens: 100, output_tokens: 0 },
    }));
    const recordDecision = vi.fn();
    const recordOptimization = vi.fn();
    const options = { focus: 'Qual a resposta?', deps: {
      jev, jevEnabled: () => true, jevReady: () => true, recordDecision, recordOptimization,
    } };
    const first = await readBrowserPage(PANE, scope, options);
    expect(first.contextSelection?.applied).toBe(true);
    expect(first.bodyText.length).toBeLessThan(bodyText.length);
    const reused = await readBrowserPage(PANE, scope, options);
    expect(reused.judgmentReused).toBe(true);
    expect(reused.bodyText).toBe(first.bodyText);
    expect(jev).toHaveBeenCalledOnce();
    expect(recordDecision).toHaveBeenCalledOnce();
    expect(recordOptimization).toHaveBeenCalledWith(expect.objectContaining({
      optimization: expect.objectContaining({ jevRequestsAvoided: 1 }),
    }));
    const compact = await readBrowserPageCompact(PANE, scope, options);
    expect(compact.outline).toContain(first.bodyText);
    expect(compact.contextSelection?.applied).toBe(true);
    expect(compact.judgmentReused).toBe(true);
    expect(jev).toHaveBeenCalledOnce();
    await readBrowserPage(PANE, scope, { ...options, sessionId: 'other-session', missionId: 'other-mission' });
    expect(jev).toHaveBeenCalledTimes(2);
    bodyText += ' atualizado';
    await readBrowserPage(PANE, scope, options);
    expect(jev).toHaveBeenCalledTimes(3);
    const disabled = await readBrowserPage(PANE, scope, { ...options, judge: false });
    expect(disabled.bodyText).toBe(bodyText);
    expect(disabled.contextSelection).toBeUndefined();
    expect(jev).toHaveBeenCalledTimes(3);
    destroyBrowser(PANE, scope);
  });

  it('does not reuse a previous provider judgment after configuration changes', async () => {
    await boot();
    const jev = vi.fn(async () => ({ model: state.decisionConfiguration === 'initial' ? 'jev-1.13.0' : 'clef',
      answers: { errorVisible: { type: 'noul' as const, noul: 0.1 } },
      usage: { input_tokens: 100, output_tokens: 0 } }));
    const options = { judge: true, deps: { jev, jevEnabled: () => true, jevReady: () => true, recordDecision: () => 'id', recordOptimization: () => 'id' } };
    const first = await readBrowserPage(PANE, scope, options);
    const reused = await readBrowserPage(PANE, scope, options);
    expect(first.judgment?.model).toBe('jev-1.13.0');
    expect(reused.judgmentReused).toBe(true);
    state.decisionConfiguration = 'changed';
    const changed = await readBrowserPage(PANE, scope, options);
    expect(changed.judgment?.model).toBe('clef');
    expect(changed.judgmentReused).not.toBe(true);
    expect(jev).toHaveBeenCalledTimes(2);
  });

  it('judges navigate and reuses the cached verdict on the next judged action of the same page', async () => {
    await boot();
    const jev = vi.fn(async (_req: unknown) => ({
      model: 'test-model',
      answers: { errorVisible: { type: 'noul' as const, noul: 0.2 } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }));
    const deps = {
      jev,
      jevEnabled: () => true,
      jevReady: () => true,
      recordDecision: vi.fn(),
      recordOptimization: vi.fn(),
    };
    const nav = await loadBrowser(PANE, 'https://example.test/app', { scope, judge: true, deps });
    expect(nav.judgment).toMatchObject({ errorVisible: 0.2, model: 'test-model' });
    expect(jev).toHaveBeenCalledOnce();
    const pressed = await pressBrowserKey(PANE, scope, { key: 'Enter', judge: true, deps });
    expect(pressed.judgment).toMatchObject({ errorVisible: 0.2 });
    expect(jev).toHaveBeenCalledOnce();
    destroyBrowser(PANE, scope);
  });

  it('answers inside the judgment budget when the provider stalls', async () => {
    await boot();
    const jev = vi.fn((_req: unknown) => new Promise<never>(() => {}));
    const started = Date.now();
    const nav = await loadBrowser(PANE, 'https://example.test/app', {
      scope,
      judge: true,
      deps: { jev, jevEnabled: () => true, jevReady: () => true },
    });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(nav.judgment).toBeNull();
    expect(nav.judgmentSkipped).toBe('budget-exceeded');
    destroyBrowser(PANE, scope);
  });

  it('delivers a visual judgment that missed the budget on the next judged read instead of dropping it', async () => {
    await boot();
    const jev = vi.fn(async (_req: unknown) => ({
      model: 'test-model', answers: {}, usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const deps = { jev, jevEnabled: () => true, jevReady: () => true };
    let land!: (value: { status: 'answered'; signals: Record<string, number>; model: string; route: string }) => void;
    state.visualJudge.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    state.canVisual.mockReturnValue(true);
    try {
      const nav = await loadBrowser(PANE, 'https://example.test/slow', { scope, judge: true, deps });
      expect(nav.visualJudgment).toEqual({ status: 'pending' });
      land({ status: 'answered', signals: { visibleError: 0.1 }, model: 'clef', route: 'test' });
      await new Promise((resolve) => setImmediate(resolve));
      const read = await readBrowserPage(PANE, scope, { judge: true, deps });
      expect(read.visualJudgment).toMatchObject({ status: 'answered', signals: { visibleError: 0.1 } });
      const again = await readBrowserPage(PANE, scope, { judge: true, deps });
      expect(again.visualJudgment).toBeUndefined();
      expect(state.visualJudge).toHaveBeenCalledOnce();
    } finally {
      state.canVisual.mockReturnValue(false);
    }
    destroyBrowser(PANE, scope);
  });

  it('waits for the requests an action started and a quiet window before describing the page', async () => {
    await boot();
    const onBefore = state.browserSession.webRequest.onBeforeRequest.mock.calls.at(-1)?.[1] as
      (details: Record<string, unknown>, callback: (response: { cancel?: boolean }) => void) => void;
    const onCompleted = state.guestHandlers.get('webRequest:onCompleted')![0]!;
    state.runAutomation.mockImplementationOnce(async () => {
      // The click starts an XHR that answers only 400 ms later.
      onBefore({ id: 7, url: 'https://example.test/api/save', resourceType: 'xhr', webContentsId: 22 }, () => {});
      setTimeout(() => onCompleted({ id: 7, url: 'https://example.test/api/save', statusCode: 200, webContentsId: 22 }), 400);
      return { clicked: true, element: { ref: 'e1', tag: 'button', role: 'button', name: 'Salvar' } };
    });
    const started = Date.now();
    await clickBrowserElement(PANE, scope, 'e1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(400 + 250);

    const quiet = Date.now();
    await clickBrowserElement(PANE, scope, 'e1');
    // No request and no navigation: the short grace, not the quiet window.
    expect(Date.now() - quiet).toBeLessThan(400);
    destroyBrowser(PANE, scope);
  });

  it('never waits past the cap for a request that never ends (long poll)', async () => {
    await boot();
    const onBefore = state.browserSession.webRequest.onBeforeRequest.mock.calls.at(-1)?.[1] as
      (details: Record<string, unknown>, callback: (response: { cancel?: boolean }) => void) => void;
    state.runAutomation.mockImplementationOnce(async () => {
      onBefore({ id: 8, url: 'https://example.test/poll', resourceType: 'xhr', webContentsId: 22 }, () => {});
      return { clicked: true, element: { ref: 'e1', tag: 'button', role: 'button', name: 'Abrir' } };
    });
    const started = Date.now();
    await clickBrowserElement(PANE, scope, 'e1');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(2_500);
    destroyBrowser(PANE, scope);
  }, 10_000);

  describe('real input through webContents.sendInputEvent', () => {
    const element = { ref: 'e1', tag: 'button', role: 'button', name: 'Conta' };
    const defaultAutomation = state.runAutomation.getMockImplementation()!;
    function nativeAutomation(delivered: boolean, prepared: Record<string, unknown> = { token: 'i1', x: 140, y: 50, element }) {
      state.runAutomation.mockImplementation(async (_pane: string, _wc: unknown, command: string): Promise<unknown> => {
        if (command === 'input_prepare') return prepared;
        if (command === 'input_confirm') return { delivered };
        if (command === 'click') return { clicked: true, element };
        if (command === 'press') return { pressed: true, key: 'Enter' };
        if (command === 'hover') return { hovered: true, element };
        throw new Error(`unexpected command ${command}`);
      });
    }
    afterEach(() => {
      delete (state.guest as { sendInputEvent?: unknown }).sendInputEvent;
      delete (state.guest as { getZoomFactor?: unknown }).getZoomFactor;
      state.runAutomation.mockImplementation(defaultAutomation);
    });

    it('clicks with a real mouse down/up at the element center (zoom applied) and no synthetic click', async () => {
      await boot();
      const sendInputEvent = vi.fn();
      Object.assign(state.guest, { sendInputEvent, getZoomFactor: () => 1.5 });
      nativeAutomation(true);
      const result = await clickBrowserElement(PANE, scope, 'e1');
      expect(sendInputEvent.mock.calls.map((call) => call[0])).toEqual([
        { type: 'mouseMove', x: 210, y: 75 },
        { type: 'mouseDown', x: 210, y: 75, button: 'left', clickCount: 1 },
        { type: 'mouseUp', x: 210, y: 75, button: 'left', clickCount: 1 },
      ]);
      expect(result).toMatchObject({ clicked: true, input: 'native', element: { name: 'Conta' } });
      expect(state.runAutomation.mock.calls.map((call) => call[2])).not.toContain('click');
      destroyBrowser(PANE, scope);
    });

    it('falls back to the synthetic sequence when the page never saw a trusted event', async () => {
      await boot();
      Object.assign(state.guest, { sendInputEvent: vi.fn() });
      nativeAutomation(false);
      const result = await clickBrowserElement(PANE, scope, 'e1');
      expect(result).toMatchObject({ clicked: true, input: 'synthetic' });
      expect(state.runAutomation.mock.calls.map((call) => call[2])).toContain('click');
      destroyBrowser(PANE, scope);
    });

    it('falls back without sending input when the element is covered', async () => {
      await boot();
      const sendInputEvent = vi.fn();
      Object.assign(state.guest, { sendInputEvent });
      nativeAutomation(true, { token: null, reason: 'occluded' });
      const result = await clickBrowserElement(PANE, scope, 'e1');
      expect(sendInputEvent).not.toHaveBeenCalled();
      expect(result).toMatchObject({ input: 'synthetic', nativeSkipped: 'occluded' });
      destroyBrowser(PANE, scope);
    });

    it('presses Enter as keyDown + char "\\r" + keyUp so forms submit and fields receive text', async () => {
      await boot();
      const sendInputEvent = vi.fn();
      Object.assign(state.guest, { sendInputEvent });
      nativeAutomation(true, { token: 'i2' });
      const result = await pressBrowserKey(PANE, scope, { key: 'Enter' });
      expect(sendInputEvent.mock.calls.map((call) => call[0])).toEqual([
        { type: 'keyDown', keyCode: 'Enter', modifiers: [] },
        { type: 'char', keyCode: '\r', modifiers: [] },
        { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
      ]);
      expect(result).toMatchObject({ pressed: true, key: 'Enter', input: 'native' });
      expect(state.runAutomation.mock.calls.map((call) => call[2])).not.toContain('press');

      sendInputEvent.mockClear();
      await pressBrowserKey(PANE, scope, { key: 'ArrowDown' });
      expect(sendInputEvent.mock.calls.map((call) => call[0])).toEqual([
        { type: 'keyDown', keyCode: 'Down', modifiers: [] },
        { type: 'keyUp', keyCode: 'Down', modifiers: [] },
      ]);

      sendInputEvent.mockClear();
      await pressBrowserKey(PANE, scope, { key: 'a', modifiers: ['Control'] });
      // A shortcut never types its letter.
      expect(sendInputEvent.mock.calls.map((call) => call[0])).toEqual([
        { type: 'keyDown', keyCode: 'a', modifiers: ['control'] },
        { type: 'keyUp', keyCode: 'a', modifiers: ['control'] },
      ]);
      destroyBrowser(PANE, scope);
    });

    it('hovers with a real mouse move so :hover and pointer handlers react', async () => {
      await boot();
      const sendInputEvent = vi.fn();
      Object.assign(state.guest, { sendInputEvent });
      nativeAutomation(true);
      const result = await hoverBrowserElement(PANE, scope, 'e1');
      expect(sendInputEvent.mock.calls.map((call) => call[0])).toEqual([{ type: 'mouseMove', x: 140, y: 50 }]);
      expect(result).toMatchObject({ hovered: true, input: 'native' });
      destroyBrowser(PANE, scope);
    });
  });

  describe('select', () => {
    const defaultAutomation = state.runAutomation.getMockImplementation()!;
    afterEach(() => state.runAutomation.mockImplementation(defaultAutomation));

    it('chooses a native option through the page primitive', async () => {
      await boot();
      state.runAutomation.mockImplementation(async (_pane: string, _wc: unknown, command: string, ...rest: unknown[]): Promise<unknown> => {
        const args = rest[0];
        if (command === 'select') {
          expect(args).toEqual({ ref: 'e4', option: 'São Paulo' });
          return { selected: true, ref: 'e4', option: { label: 'São Paulo', index: 1 } };
        }
        return defaultAutomation(_pane, _wc, command);
      });
      const result = await selectBrowserOption(PANE, scope, 'e4', { option: 'São Paulo' });
      expect(result).toMatchObject({ selected: true, via: 'native-select', option: { label: 'São Paulo' } });
      expect(result.changed).toBeDefined();
      destroyBrowser(PANE, scope);
    });

    it('opens an ARIA combobox and clicks the option with that name', async () => {
      await boot();
      const clicked: string[] = [];
      state.runAutomation.mockImplementation(async (_pane: string, _wc: unknown, command: string, ...rest: unknown[]): Promise<unknown> => {
        const args = rest[0];
        if (command === 'select') throw new Error('browser element is not a native select');
        if (command === 'click') {
          clicked.push((args as { ref: string }).ref);
          return { clicked: true, element: { ref: (args as { ref: string }).ref, tag: 'div', role: 'option', name: 'x' } };
        }
        if (command === 'find') {
          return {
            matches: [
              { ref: 'e9', tag: 'span', role: 'span', name: 'Brasil', score: 1 },
              { ref: 'e7', tag: 'div', role: 'option', name: 'Brasil', score: 1 },
            ],
            total: 2,
          };
        }
        return defaultAutomation(_pane, _wc, command);
      });
      const result = await selectBrowserOption(PANE, scope, 'e3', { option: 'Brasil' });
      expect(clicked).toEqual(['e3', 'e7']);
      expect(result).toMatchObject({ selected: true, via: 'aria-listbox', option: { label: 'Brasil' } });
      destroyBrowser(PANE, scope);
    });

    it('returns the option candidates without clicking when the ARIA option is ambiguous', async () => {
      await boot();
      const clicked: string[] = [];
      state.runAutomation.mockImplementation(async (_pane: string, _wc: unknown, command: string, ...rest: unknown[]): Promise<unknown> => {
        const args = rest[0];
        if (command === 'select') throw new Error('browser element is not a native select');
        if (command === 'click') {
          clicked.push((args as { ref: string }).ref);
          return { clicked: true, element: { ref: 'e3', tag: 'button', role: 'combobox', name: 'País' } };
        }
        if (command === 'find') {
          return {
            matches: [
              { ref: 'e7', tag: 'div', role: 'option', name: 'Guiné', score: 0.9 },
              { ref: 'e8', tag: 'div', role: 'option', name: 'Guiné-Bissau', score: 0.9 },
            ],
            total: 2,
          };
        }
        return defaultAutomation(_pane, _wc, command);
      });
      const result = await selectBrowserOption(PANE, scope, 'e3', { option: 'guine' });
      expect(clicked).toEqual(['e3']);
      expect(result).toMatchObject({ selected: false, ambiguous: true });
      expect(result.candidates?.map((candidate) => candidate.ref)).toEqual(['e7', 'e8']);
      destroyBrowser(PANE, scope);
    });
  });

  describe('screenshot options', () => {
    const defaultAutomation = state.runAutomation.getMockImplementation()!;
    beforeEach(() => registerBrowserIpc({} as never));
    afterEach(() => {
      state.runAutomation.mockImplementation(defaultAutomation);
      state.guest.debugger.sendCommand.mockImplementation(async (): Promise<unknown> => ({ root: {} }));
    });

    it('attaches a bounded inline image (longest side ≤ 1568) to the result', async () => {
      await boot();
      state.guest.capturePage.mockResolvedValueOnce(fakeImage(2560, 1600) as never);
      const shot = await captureBrowserScreenshot(PANE, scope, undefined, { includeImage: true });
      expect(shot.image?.mimeType).toBe('image/png');
      expect(typeof shot.image?.data).toBe('string');
      expect(shot.image).toMatchObject({ width: 1568, height: 980 });
      expect(shot.width).toBe(2560);
      destroyBrowser(PANE, scope);
    });

    it('never inlines pixels of a pane on the personal profile', async () => {
      state.profileMode = 'personal';
      bindResolvedRendererWorkspaceScope(state.owner, scope);
      await boot();
      const shot = await captureBrowserScreenshot(PANE, scope, undefined, { includeImage: true });
      expect(shot.image).toBeUndefined();
      expect(shot.imageOmitted).toBe('personal_profile');
      destroyBrowser(PANE, scope);
    });

    it('captures the whole page beyond the viewport through the debugger and detaches it', async () => {
      await boot();
      state.guest.debugger.attach.mockClear();
      state.guest.debugger.detach.mockClear();
      const commands: Array<[string, unknown]> = [];
      state.guest.debugger.sendCommand.mockImplementation(async (...call: unknown[]): Promise<unknown> => {
        const [method, params] = call as [string, unknown];
        commands.push([method, params]);
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1280, height: 3000 } };
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('full').toString('base64') };
        return {};
      });
      const shot = await captureBrowserScreenshot(PANE, scope, undefined, { fullPage: true });
      expect(commands.map(([method]) => method)).toEqual(['Page.getLayoutMetrics', 'Page.captureScreenshot']);
      expect(commands[1]![1]).toMatchObject({ captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 3000, scale: 1 } });
      expect(state.guest.debugger.attach).toHaveBeenCalledOnce();
      expect(state.guest.debugger.detach).toHaveBeenCalledOnce();
      expect(shot).toMatchObject({ fullPage: true, width: 1280, height: 3000 });
      destroyBrowser(PANE, scope);
    });

    it.each([
      ['a wide page', { width: 20000, height: 3000 }],
      ['a tall page', { width: 1280, height: 20000 }],
    ])('marks %s past the capture limit as truncated, with its real size', async (_label, page) => {
      await boot();
      state.guest.debugger.sendCommand.mockImplementation(async (...call: unknown[]): Promise<unknown> => {
        const [method] = call as [string];
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: page };
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('full').toString('base64') };
        return {};
      });
      const shot = await captureBrowserScreenshot(PANE, scope, undefined, { fullPage: true });
      expect(shot).toMatchObject({
        truncated: true,
        capturedCss: { width: Math.min(page.width, 16384), height: Math.min(page.height, 16384) },
        viewport: page,
      });
      destroyBrowser(PANE, scope);
    });

    it('refuses fullPage together with an element ref instead of mislabelling the capture', async () => {
      await boot();
      state.guest.capturePage.mockClear();
      await expect(
        captureBrowserScreenshot(PANE, scope, undefined, { fullPage: true, ref: 'e1' }),
      ).rejects.toThrow(/either fullPage or ref/);
      expect(state.guest.capturePage).not.toHaveBeenCalled();
      destroyBrowser(PANE, scope);
    });

    it('renders the dark theme for the capture and puts the page back afterwards', async () => {
      await boot();
      const media: unknown[] = [];
      state.guest.debugger.sendCommand.mockImplementation(async (...call: unknown[]): Promise<unknown> => {
        const [method, params] = call as [string, unknown];
        if (method === 'Emulation.setEmulatedMedia') media.push(params);
        return {};
      });
      const shot = await captureBrowserScreenshot(PANE, scope, undefined, { theme: 'dark' });
      expect(media).toEqual([
        { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
        { features: [] },
      ]);
      expect(shot.theme).toBe('dark');
      destroyBrowser(PANE, scope);
    });

    it('crops to one element by ref', async () => {
      await boot();
      state.runAutomation.mockImplementation(async (_pane: string, _wc: unknown, command: string): Promise<unknown> => {
        if (command === 'element_rect') return { x: 100, y: 200, width: 300, height: 50 };
        return defaultAutomation(_pane, _wc, command);
      });
      state.guest.capturePage.mockClear();
      const shot = await captureBrowserScreenshot(PANE, scope, undefined, { ref: 'e5' });
      expect(state.guest.capturePage).toHaveBeenCalledWith({ x: 92, y: 192, width: 316, height: 66 });
      expect(shot.element).toBe('e5');
      destroyBrowser(PANE, scope);
    });
  });

  it('an agent pane never blocks on alert/confirm/prompt; the operator pane keeps native dialogs', async () => {
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(true);
    await boot();
    expect(state.views.at(-1)?.webPreferences).toMatchObject({ disableDialogs: true });
    destroyBrowser(PANE, scope);
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(false);
    await boot();
    expect(state.views.at(-1)?.webPreferences).toMatchObject({ safeDialogs: true, disableDialogs: false });
    destroyBrowser(PANE, scope);
  });

  it('goes back, forward and reloads through the action contract (after/changed/errors)', async () => {
    await boot();
    state.guest.canGoBack.mockReturnValue(false);
    const none = await historyBrowserPane(PANE, scope, 'back');
    expect(none).toMatchObject({ navigated: false, reason: 'no-history' });
    expect(state.guest.goBack).not.toHaveBeenCalled();

    state.guest.canGoBack.mockReturnValue(true);
    const back = await historyBrowserPane(PANE, scope, 'back');
    expect(state.guest.goBack).toHaveBeenCalledOnce();
    expect(back).toMatchObject({ navigated: true, action: 'back' });
    expect(back.changed).toBeDefined();
    expect(back.errors).toBeDefined();

    state.guest.canGoForward.mockReturnValue(true);
    await historyBrowserPane(PANE, scope, 'forward');
    expect(state.guest.goForward).toHaveBeenCalledOnce();
    await historyBrowserPane(PANE, scope, 'reload');
    expect(state.guest.reload).toHaveBeenCalledOnce();
    destroyBrowser(PANE, scope);
  });

  it('reports a refused download instead of cancelling it in silence', async () => {
    await boot();
    const onDownload = state.sessionHandlers.get('will-download') as
      (event: { preventDefault: () => void }, item: unknown, wc: unknown) => void;
    const preventDefault = vi.fn();
    onDownload({ preventDefault }, {
      getFilename: () => 'relatorio-token=abcdefghijklmnop1234.pdf',
      getMimeType: () => 'application/pdf',
    }, state.guest);
    expect(preventDefault).toHaveBeenCalled();
    const read = await readBrowserPage(PANE, scope);
    expect(read.errors.items.at(-1)?.message).toMatch(/download blocked/);
    expect(read.errors.items.at(-1)?.message).toContain('application/pdf');
    destroyBrowser(PANE, scope);
  });

  it('does not read the page for a judgment that cannot run', async () => {
    await boot();
    state.runAutomation.mockClear();
    const off = await clickBrowserElement(PANE, scope, 'e1', { judge: true, deps: { jevEnabled: () => false } });
    expect(off.judgmentSkipped).toBe('surface-disabled');
    const noKey = await loadBrowser(PANE, 'https://example.test/app', {
      scope, judge: true, deps: { jevEnabled: () => true, jevReady: () => false },
    });
    expect(noKey.judgmentSkipped).toBe('no-credential');
    const commands = state.runAutomation.mock.calls.map((call) => call[2]);
    expect(commands).not.toContain('read');
    destroyBrowser(PANE, scope);
  });

  it('refuses a local dev server and names the preview path that works', async () => {
    await boot();
    await expect(loadBrowser(PANE, 'http://localhost:5173/', { scope }))
      .rejects.toThrow(/private.*nexus_preview_start.*nexus_browser_open.*nexus_browser_responsive/s);
    await expect(loadBrowser(PANE, 'file:///tmp/app/index.html', { scope }))
      .rejects.toThrow(/nexus_preview_start/);
    destroyBrowser(PANE, scope);
  });

  it('reports a subresource the policy blocked instead of dropping it silently', async () => {
    await boot();
    const onBeforeRequest = state.browserSession.webRequest.onBeforeRequest.mock.calls.at(-1)?.[1] as
      (details: Record<string, unknown>, callback: (response: { cancel?: boolean }) => void) => void;
    const cancelled = await new Promise<{ cancel?: boolean }>((resolve) => {
      onBeforeRequest({ url: 'http://localhost:8787/api/clientes', resourceType: 'xhr' }, resolve);
    });
    expect(cancelled).toEqual({ cancel: true });
    const read = await readBrowserPage(PANE, scope);
    expect(read.errors.loadErrors).toBe(1);
    expect(read.errors.items[0]?.message).toMatch(/blocked \(private-network\): http:\/\/localhost:8787/);
    destroyBrowser(PANE, scope);
  });

  it('runs the post-navigate visual check only with consent and never without the surface', async () => {
    await boot();
    const jev = vi.fn(async (_req: unknown) => ({
      model: 'test-model',
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const deps = { jev, jevEnabled: () => true, jevReady: () => true };
    const first = await loadBrowser(PANE, 'https://example.test/a', { scope, judge: true, deps });
    expect(first.visualJudgment).toBeUndefined();
    expect(state.visualJudge).not.toHaveBeenCalled();
    state.canVisual.mockReturnValue(true);
    try {
      const second = await loadBrowser(PANE, 'https://example.test/b', { scope, judge: true, deps });
      expect(second.visualJudgment).toMatchObject({ status: 'answered' });
      expect(state.visualJudge).toHaveBeenCalledWith(
        expect.objectContaining({ paneId: PANE, scope }),
      );
      const third = await loadBrowser(PANE, 'https://example.test/c', {
        scope,
        judge: true,
        deps: { ...deps, jevEnabled: () => false },
      });
      expect(third.judgmentSkipped).toBe('surface-disabled');
      expect(third.visualJudgment).toBeUndefined();
      expect(state.visualJudge).toHaveBeenCalledOnce();
    } finally {
      state.canVisual.mockReturnValue(false);
    }
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

  it('forwards a bounded hold with the current invocation cancellation authority', async () => {
    await boot();
    const controller = new AbortController();
    const assertCurrentAuthority = vi.fn();
    await pressBrowserKey(PANE, scope, { key: 'Enter', holdMs: 80, signal: controller.signal, assertCurrentAuthority });
    expect(state.runAutomation).toHaveBeenCalledWith(PANE, state.guest, 'press', { key: 'Enter', holdMs: 80 }, undefined,
      expect.objectContaining({ signal: controller.signal, assertCurrentAuthority: expect.any(Function) }));
    expect(assertCurrentAuthority).toHaveBeenCalled();
    destroyBrowser(PANE, scope);
  });

  it('does not send a press after invocation cancellation', async () => {
    await boot();
    const controller = new AbortController(); controller.abort();
    state.runAutomation.mockClear();
    await expect(pressBrowserKey(PANE, scope, { key: 'Enter', holdMs: 80, signal: controller.signal })).rejects.toThrow('authority or document changed');
    expect(state.runAutomation).not.toHaveBeenCalled();
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

  it('sets the device UA before navigating but only touches the native emulation after the first document commits', async () => {
    // Electron 43.8.3: `WebContents::EnableDeviceEmulation` faz
    // `frame_host->GetView()->GetRenderWidgetHost()` sem checar o GetView().
    // Num pane recém-criado (vista escondida, nenhum documento) o GetView() é
    // null e o Main morre com SIGSEGV em null+0xf8 — foi o crash de 23/10 no
    // `nexus_browser_open` com device. A UA não depende de render view e pode
    // ir antes; as métricas entram no commit, quando o widget existe.
    await boot();
    await loadBrowser(PANE, 'https://example.test/app', { scope, device: 'mobile' });
    expect(state.guest.setUserAgent).toHaveBeenCalledWith(
      expect.stringContaining('iPhone'),
    );
    expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
    fire('did-navigate', {}, 'https://example.test/app');
    expect(state.guest.enableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ viewSize: { width: 390, height: 844 } }),
    );
    destroyBrowser(PANE, scope);
  });

  it('inspects masks before the deep CDP walk and clamps the emulated viewport like a screenshot', async () => {
    await boot();
    await loadBrowser(PANE, 'https://example.test/app', { scope, device: 'mobile' });
    const masks = { width: 390, height: 844, scrollX: 0, scrollY: 0, rectangles: [{ x: 0, y: 0, width: 10, height: 10 }] };
    state.guest.debugger.attach.mockClear(); state.runAutomation.mockClear();
    state.runAutomation.mockResolvedValueOnce(masks).mockResolvedValueOnce(masks);
    const captured = { getSize: () => ({ width: 390, height: 800 }), toBitmap: () => Buffer.alloc(390 * 800 * 4, 5) } as never;
    state.guest.capturePage.mockResolvedValueOnce(captured);
    await captureRedactedBrowserVisual(PANE, scope);
    expect(state.runAutomation.mock.invocationCallOrder[0]).toBeLessThan(state.guest.debugger.attach.mock.invocationCallOrder[0]);
    expect(state.guest.capturePage).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 390, height: 800 });
    destroyBrowser(PANE, scope);
  });

  it('reaplica a emulação no commit de cada navegação (o widget novo nasce sem ela)', async () => {
    // Smoke 28/09: "mobile" de 390 media viewport 989 — a emulação morria com
    // o RenderFrameHost trocado pela navegação e o responsive auditava a
    // mesma largura nos três dispositivos.
    await boot();
    await loadBrowser(PANE, 'https://example.test/app', { scope, device: 'mobile' });
    vi.mocked(state.guest.enableDeviceEmulation).mockClear();
    fire('did-navigate', {}, 'https://example.test/app');
    expect(state.guest.enableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ viewSize: { width: 390, height: 844 } }),
    );
    await loadBrowser(PANE, 'https://example.test/desktop', { scope, device: 'desktop' });
    vi.mocked(state.guest.enableDeviceEmulation).mockClear();
    fire('did-navigate', {}, 'https://example.test/desktop');
    expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
    destroyBrowser(PANE, scope);
  });

  it('emulates the tablet breakpoint with the iPad UA', async () => {
    await boot();
    await loadBrowser(PANE, 'https://example.test/app', { scope, device: 'tablet' });
    expect(state.guest.setUserAgent).toHaveBeenCalledWith(
      expect.stringContaining('iPad'),
    );
    expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
    fire('did-navigate', {}, 'https://example.test/app');
    expect(state.guest.enableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ viewSize: { width: 800, height: 1366 } }),
    );
    destroyBrowser(PANE, scope);
  });

  it('desktop disables emulation and restores the original UA', async () => {
    await boot();
    await loadBrowser(PANE, 'https://example.test/mobile', { scope, device: 'mobile' });
    fire('did-navigate', {}, 'https://example.test/mobile');
    await loadBrowser(PANE, 'https://example.test/desktop', { scope, device: 'desktop' });
    expect(state.guest.disableDeviceEmulation).toHaveBeenCalledOnce();
    expect(state.guest.setUserAgent).toHaveBeenLastCalledWith('desktop-ua');
    destroyBrowser(PANE, scope);
  });

  it('never calls the native emulation on a pane that has not committed a document', async () => {
    // Regressão do crash de 23/10: o turno do agente abriu o pane com
    // `nexus_browser_open({device:'mobile'})` e o Main morreu antes do
    // primeiro load. O contrato aqui é o inverso: sem commit, nem enable nem
    // disable chegam ao WebContents.
    await boot();
    await loadBrowser(PANE, 'https://example.test/mobile', { scope, device: 'mobile' });
    await loadBrowser(PANE, 'https://example.test/desktop', { scope, device: 'desktop' });
    expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(state.guest.disableDeviceEmulation).not.toHaveBeenCalled();
    destroyBrowser(PANE, scope);
  });

  it('a refused navigation (file:// or private address) does not touch the device', async () => {
    await boot();
    await expect(
      loadBrowser(PANE, 'file:///etc/hosts', { scope, device: 'mobile' }),
    ).rejects.toThrow();
    state.browserSession.resolveHost.mockResolvedValueOnce({
      endpoints: [{ address: '10.0.0.5', port: 0 }],
    });
    await expect(
      loadBrowser(PANE, 'https://intranet.example.test/', { scope, device: 'mobile' }),
    ).rejects.toThrow();
    expect(state.guest.setUserAgent).not.toHaveBeenCalled();
    expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(state.guest.loadURL).not.toHaveBeenCalled();
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

describe('agent pane viewport floor via the real bounds IPC', () => {
  function sendBounds(bounds: Record<string, unknown>): void {
    registerBrowserIpc({} as never);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    const onBounds = state.onHandlers.get(BROWSER_CHANNELS.bounds)!;
    onBounds({ sender: state.owner }, { paneId: PANE, bounds });
  }

  it('keeps a visible agent pane at the operator geometry (Mobile 375px preset)', async () => {
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(true);
    await boot();
    const view = state.views.at(-1)!;
    sendBounds({ x: 120, y: 40, width: 375, height: 700, visible: true });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 120, y: 40, width: 375, height: 700 });
    destroyBrowser(PANE, scope);
  });

  it('gives a hidden agent pane a decent off-window viewport', async () => {
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(true);
    await boot();
    const view = state.views.at(-1)!;
    sendBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 50_000,
      y: 50_000,
      width: 1280,
      height: 800,
    });
    destroyBrowser(PANE, scope);
  });

  it('keeps hiding a hidden operator-owned pane', async () => {
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(false);
    await boot();
    const view = state.views.at(-1)!;
    sendBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.setBounds).not.toHaveBeenCalled();
    destroyBrowser(PANE, scope);
  });
});

describe('analyzeBrowserResponsive (nexus_browser_responsive)', () => {
  const AUDIT = {
    layoutWidth: 390,
    scrollWidth: 520,
    horizontalOverflow: true,
    overflowing: [],
    clipped: [],
    truncated: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.guestHandlers.clear();
    state.views.length = 0;
    vi.mocked(isAgentRequestedBrowser).mockReturnValue(false);
    destroyBrowser(PANE, scope);
    state.guest.getURL.mockReturnValue('https://example.test/app');
    state.guest.isDestroyed.mockReturnValue(false);
    state.guest.once.mockImplementation(() => state.guest);
    state.guest.removeListener.mockImplementation(() => state.guest);
    state.runAutomation.mockImplementation(async (_p, _wc, command: string) => {
      if (command === 'layout_audit') return AUDIT;
      throw new Error(`unexpected command ${command}`);
    });
    registerBrowserIpc({} as never);
  });

  it('captures and audits mobile/tablet/desktop, then restores the native device and page', async () => {
    await bootCommitted();
    const result = await analyzeBrowserResponsive(PANE, scope);
    expect(result.breakpoints.map((b) => b.device)).toEqual(['mobile', 'tablet', 'desktop']);
    expect(result.breakpoints[0]).toMatchObject({ audit: AUDIT });
    // Emulated breakpoints are captured at their own viewport (clamped to the view).
    expect(state.guest.capturePage.mock.calls.map((call) => call[0])).toEqual([
      { x: 0, y: 0, width: 390, height: 800 },
      { x: 0, y: 0, width: 800, height: 800 },
      undefined,
    ]);
    expect(result.breakpoints.map((b) => 'screenshot' in b && b.screenshot.width)).toEqual([390, 800, 1280]);
    expect(result.restored).toBe(true);
    // 3 breakpoints + 1 restore, all through the guarded navigation.
    expect(state.guest.loadURL).toHaveBeenCalledTimes(4);
    expect(state.guest.loadURL).toHaveBeenLastCalledWith('https://example.test/app');
    expect(state.guest.disableDeviceEmulation).toHaveBeenCalled();
    expect(state.guest.setUserAgent).toHaveBeenLastCalledWith('desktop-ua');
    destroyBrowser(PANE, scope);
  });

  // F-1326: a pane narrower/shorter than the emulated device paints only the
  // view's bounds; that capture must never pass as a complete breakpoint.
  it('flags an emulated breakpoint cut to a small pane instead of returning it as complete', async () => {
    await boot();
    state.views[0].getBounds.mockReturnValue({ x: 0, y: 0, width: 309, height: 136 });
    const result = await analyzeBrowserResponsive(PANE, scope, { devices: ['tablet', 'desktop'] });
    const [tablet, desktop] = result.breakpoints.map((b) => ('screenshot' in b ? b.screenshot : null));
    expect(tablet).toMatchObject({
      width: 309,
      truncated: true,
      capturedCss: { width: 309, height: 136 },
      viewport: { width: 800, height: expect.any(Number) },
    });
    // The pane's own width is the desktop viewport: that capture is whole.
    expect(desktop).not.toHaveProperty('truncated');
    destroyBrowser(PANE, scope);
  });

  it('restores the operator\'s own mobile preview after the run', async () => {
    await bootCommitted();
    await loadBrowser(PANE, 'https://example.test/app', { scope, device: 'mobile' });
    vi.mocked(state.guest.enableDeviceEmulation).mockClear();
    await analyzeBrowserResponsive(PANE, scope, { devices: ['desktop'] });
    expect(state.guest.enableDeviceEmulation).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewSize: { width: 390, height: 844 } }),
    );
    destroyBrowser(PANE, scope);
  });

  it('restores the original state even when a breakpoint fails', async () => {
    await bootCommitted();
    let audits = 0;
    state.runAutomation.mockImplementation(async (_p, _wc, command: string) => {
      if (command !== 'layout_audit') throw new Error('unexpected');
      audits += 1;
      if (audits === 2) throw new Error('page crashed mid-audit');
      return AUDIT;
    });
    await expect(analyzeBrowserResponsive(PANE, scope)).rejects.toThrow(/crashed/);
    expect(state.guest.disableDeviceEmulation).toHaveBeenCalled();
    expect(state.guest.setUserAgent).toHaveBeenLastCalledWith('desktop-ua');
    expect(state.guest.loadURL).toHaveBeenLastCalledWith('https://example.test/app');
    destroyBrowser(PANE, scope);
  });

  // P2-9: the restore reload is a navigation — never after the caller lost
  // authority, and never over a navigation that happened during the run.
  const auditThen = (sideEffect: () => void | Promise<void>) => {
    let audits = 0;
    state.runAutomation.mockImplementation(async (_p, _wc, command: string) => {
      if (command !== 'layout_audit') throw new Error('unexpected');
      audits += 1;
      if (audits === 1) await sideEffect();
      return AUDIT;
    });
  };

  it('does not reload the page after authority is revoked mid-run (device still restored)', async () => {
    await bootCommitted();
    let revoked = false;
    auditThen(() => { revoked = true; });
    await expect(analyzeBrowserResponsive(PANE, scope, {
      assertCurrentAuthority: () => { if (revoked) throw new Error('session_authority_revoked'); },
    })).rejects.toThrow(/revoked/);
    expect(state.guest.loadURL).toHaveBeenCalledTimes(1);
    expect(state.guest.disableDeviceEmulation).toHaveBeenCalled();
    destroyBrowser(PANE, scope);
  });

  it('does not reload the page after the run is cancelled', async () => {
    await boot();
    const controller = new AbortController();
    auditThen(() => controller.abort());
    await expect(analyzeBrowserResponsive(PANE, scope, { signal: controller.signal })).rejects.toThrow();
    expect(state.guest.loadURL).toHaveBeenCalledTimes(1);
    destroyBrowser(PANE, scope);
  });

  it('stops and does not overwrite the operator navigating elsewhere during the run', async () => {
    await boot();
    auditThen(async () => {
      await loadBrowser(PANE, 'https://example.test/other', { scope });
    });
    await expect(analyzeBrowserResponsive(PANE, scope)).rejects.toThrow(/navigated elsewhere/);
    // Breakpoint 1 + the operator's load; no further breakpoint, no restore.
    expect(state.guest.loadURL).toHaveBeenCalledTimes(2);
    expect(state.guest.loadURL).toHaveBeenLastCalledWith('https://example.test/other');
    destroyBrowser(PANE, scope);
  });

  it('skips only the restore reload when the operator navigates during the last breakpoint', async () => {
    await boot();
    auditThen(async () => {
      await loadBrowser(PANE, 'https://example.test/other', { scope });
    });
    const result = await analyzeBrowserResponsive(PANE, scope, { devices: ['desktop'] });
    expect(result.breakpoints).toHaveLength(1);
    expect(result.restored).toBe(false);
    expect(result.restoreError).toMatch(/navigated elsewhere/);
    expect(state.guest.loadURL).toHaveBeenLastCalledWith('https://example.test/other');
    destroyBrowser(PANE, scope);
  });

  it('does not overwrite a click-through navigation inside the page during the run', async () => {
    await boot();
    auditThen(() => fire('did-start-navigation', {}, 'https://example.test/next', false, true));
    await expect(analyzeBrowserResponsive(PANE, scope)).rejects.toThrow(/navigated elsewhere/);
    expect(state.guest.loadURL).toHaveBeenCalledTimes(1);
    destroyBrowser(PANE, scope);
  });

  // Astra 5 (P2): the check before the load is not enough — prepareNavigation
  // awaits DNS/pins, and a navigation in that gap must not be overwritten.
  const navigateDuringDns = (onCall: number) => {
    let calls = 0;
    state.browserSession.resolveHost.mockImplementation(async () => {
      calls += 1;
      if (calls === onCall) fire('did-start-navigation', {}, 'https://example.test/next', false, true);
      return { endpoints: [{ address: '93.184.216.34', port: 0 }] };
    });
  };
  const restoreDns = () => {
    state.browserSession.resolveHost.mockReset();
    state.browserSession.resolveHost.mockResolvedValue({ endpoints: [{ address: '93.184.216.34', port: 0 }] });
  };

  it('does not load nor emulate a breakpoint over a navigation that happened while its DNS check awaited', async () => {
    await boot();
    navigateDuringDns(1);
    try {
      await expect(analyzeBrowserResponsive(PANE, scope)).rejects.toThrow(/navigated elsewhere/);
      expect(state.guest.loadURL).not.toHaveBeenCalled();
      expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
    } finally {
      restoreDns();
      destroyBrowser(PANE, scope);
    }
  });

  it('does not reload the original page over a navigation that happened while the restore awaited DNS', async () => {
    await boot();
    // 1st resolve: the desktop breakpoint; 2nd: the restore reload.
    navigateDuringDns(2);
    try {
      const result = await analyzeBrowserResponsive(PANE, scope, { devices: ['desktop'] });
      expect(result.breakpoints).toHaveLength(1);
      expect(result.restored).toBe(false);
      expect(result.restoreError).toMatch(/navigated elsewhere/);
      expect(state.guest.loadURL).toHaveBeenCalledTimes(1);
    } finally {
      restoreDns();
      destroyBrowser(PANE, scope);
    }
  });

  it('does not reload over a click-through navigation that aborted the breakpoint load (ERR_ABORTED)', async () => {
    await bootCommitted();
    state.guest.loadURL.mockImplementationOnce(async () => {
      // The operator clicks a link while our load is in flight: Chromium
      // aborts ours and starts theirs.
      fire('did-start-navigation', {}, 'https://example.test/next', false, true);
      throw new Error('ERR_ABORTED (-3) loading https://example.test/app');
    });
    try {
      await expect(analyzeBrowserResponsive(PANE, scope, { devices: ['desktop'] })).rejects.toThrow(/ERR_ABORTED/);
      // Only our aborted load; no restore reload over the operator's page…
      expect(state.guest.loadURL).toHaveBeenCalledTimes(1);
      // …but the device emulation still goes back.
      expect(state.guest.disableDeviceEmulation).toHaveBeenCalled();
    } finally {
      state.guest.loadURL.mockImplementation(async () => {});
      destroyBrowser(PANE, scope);
    }
  });

  it('keeps the DNS guard: a host now resolving privately is never loaded or emulated', async () => {
    await boot();
    state.browserSession.resolveHost.mockResolvedValue({
      endpoints: [{ address: '10.0.0.5', port: 0 }],
    });
    try {
      await expect(analyzeBrowserResponsive(PANE, scope)).rejects.toThrow();
      expect(state.guest.loadURL).not.toHaveBeenCalled();
      expect(state.guest.enableDeviceEmulation).not.toHaveBeenCalled();
      expect(state.guest.capturePage).not.toHaveBeenCalled();
    } finally {
      state.browserSession.resolveHost.mockResolvedValue({
        endpoints: [{ address: '93.184.216.34', port: 0 }],
      });
      destroyBrowser(PANE, scope);
    }
  });

  it('P2-18: a breakpoint whose load never settles times out explicitly; the run and the restore go on', async () => {
    await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let loads = 0;
      state.guest.loadURL.mockImplementation(() => {
        loads += 1;
        // Breakpoint "tablet" hangs forever; every other load settles.
        return loads === 2 ? new Promise<void>(() => {}) : Promise.resolve();
      });
      const run = analyzeBrowserResponsive(PANE, scope);
      await vi.advanceTimersByTimeAsync(RESPONSIVE_LOAD_TIMEOUT_MS);
      const result = await run;
      expect(result.breakpoints.map((b) => b.device)).toEqual(['mobile', 'tablet', 'desktop']);
      expect(result.breakpoints[1]).toEqual({
        device: 'tablet', loadTimedOut: true, error: expect.stringMatching(/timed out after 30s/),
      });
      expect('audit' in result.breakpoints[2]).toBe(true);
      expect(state.guest.stop).toHaveBeenCalledTimes(1);
      expect(result.restored).toBe(true);
      expect(state.guest.loadURL).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
      state.guest.loadURL.mockImplementation(async () => {});
      destroyBrowser(PANE, scope);
    }
  });

  it('P2-18: a restore reload that hangs is reported, not awaited forever', async () => {
    await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let loads = 0;
      state.guest.loadURL.mockImplementation(() => {
        loads += 1;
        return loads === 2 ? new Promise<void>(() => {}) : Promise.resolve();
      });
      const run = analyzeBrowserResponsive(PANE, scope, { devices: ['desktop'] });
      await vi.advanceTimersByTimeAsync(RESPONSIVE_LOAD_TIMEOUT_MS);
      const result = await run;
      expect(result.breakpoints).toHaveLength(1);
      expect(result.restored).toBe(false);
      expect(result.restoreError).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
      state.guest.loadURL.mockImplementation(async () => {});
      destroyBrowser(PANE, scope);
    }
  });

  it('ordinary navigation keeps no load deadline', async () => {
    await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settle!: () => void;
      state.guest.loadURL.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
      let failed = false;
      void loadBrowser(PANE, 'https://example.test/slow', { scope }).catch(() => { failed = true; });
      await vi.advanceTimersByTimeAsync(RESPONSIVE_LOAD_TIMEOUT_MS * 4);
      expect(state.guest.loadURL).toHaveBeenCalledWith('https://example.test/slow');
      expect(failed).toBe(false);
      expect(state.guest.stop).not.toHaveBeenCalled();
      settle();
    } finally {
      vi.useRealTimers();
      state.guest.loadURL.mockImplementation(async () => {});
      destroyBrowser(PANE, scope);
    }
  });

  it('refuses a pane with no page open', async () => {
    await boot();
    state.guest.getURL.mockReturnValue('about:blank');
    await expect(analyzeBrowserResponsive(PANE, scope)).rejects.toThrow(/no page open/);
    destroyBrowser(PANE, scope);
  });

  it('attaches the preview CDP relay with the scoped browser key', async () => {
    await boot();
    state.guest.getURL.mockReturnValue('http://127.0.0.1:43123/');
    const origin = 'http://127.0.0.1:43123';
    const other = { ...scope, projectId: 'other-project' };
    const attachState = vi.spyOn(state.guest.debugger, 'isAttached').mockReturnValue(true);
    const opened = openCdpRelayForPane(PANE, scope, { write: () => undefined }, origin);
    expect(opened).not.toBeNull();
    expect(openCdpRelayForPane(PANE, other, { write: () => undefined }, origin)).toBeNull();
    expect(openCdpRelayForPane(PANE, scope, { write: () => undefined }, 'http://127.0.0.1:9')).toBeNull();
    opened?.detach();
    attachState.mockRestore();
    destroyBrowser(PANE, scope);
  });
});


describe('F-1069: CDP relay factory for a real Main-owned browser entry', () => {
  const debuggerListeners = new Set<unknown>();

  beforeEach(() => {
    destroyBrowser(PANE, scope);
    vi.clearAllMocks();
    state.guestHandlers.clear();
    state.guest.isDestroyed.mockReturnValue(false);
    state.owner.isDestroyed.mockReturnValue(false);
    state.win.isDestroyed.mockReturnValue(false);
    state.guest.getURL.mockReturnValue('https://example.test/owned');
    let attached = false;
    vi.spyOn(state.guest.debugger, 'isAttached').mockImplementation(() => attached);
    state.guest.debugger.attach.mockImplementation(() => { attached = true; });
    state.guest.debugger.detach.mockImplementation(() => { attached = false; });
    debuggerListeners.clear();
    state.guest.debugger.on.mockImplementation((event, listener) => {
      if (event === 'message') debuggerListeners.add(listener);
    });
    state.guest.debugger.removeListener.mockImplementation((event, listener) => {
      if (event === 'message') debuggerListeners.delete(listener);
    });
  });

  afterEach(() => {
    state.guest.isDestroyed.mockReturnValue(false);
    state.owner.isDestroyed.mockReturnValue(false);
    state.win.isDestroyed.mockReturnValue(false);
    destroyBrowser(PANE, scope);
    vi.restoreAllMocks();
    state.guest.debugger.attach.mockReset();
    state.guest.debugger.detach.mockReset();
    state.guest.debugger.on.mockReset();
    state.guest.debugger.removeListener.mockReset();
  });

  it('resolves the scoped entry created by ensureBrowser and passes CDP through its debugger', async () => {
    await boot();
    const messages: unknown[] = [];
    const relay = openCdpRelayForPane(PANE, scope, {
      write: raw => messages.push(JSON.parse(raw)),
    });
    expect(relay).not.toBeNull();
    try {
      relay!.connection.receive(JSON.stringify({
        id: 1, method: 'Page.getFrameTree', sessionId: 'nexus-preview-page',
      }));
      await vi.waitFor(() => expect(messages).toEqual([
        { id: 1, sessionId: 'nexus-preview-page', result: { root: {} } },
      ]));
      expect(state.guest.debugger.sendCommand).toHaveBeenCalledWith('Page.getFrameTree', {}, undefined);
    } finally {
      relay?.detach();
    }
  });

  it('refuses a failed debugger attach and releases its listener without detaching an unowned debugger', async () => {
    await boot();
    state.guest.debugger.attach.mockImplementationOnce(() => {
      throw new Error('debugger attach unavailable');
    });
    const relay = openCdpRelayForPane(PANE, scope, { write: () => undefined });
    try {
      expect(relay).toBeNull();
      expect(debuggerListeners.size).toBe(0);
      expect(state.guest.debugger.detach).not.toHaveBeenCalled();
    } finally {
      relay?.detach();
    }
  });

  it('retries a failed factory attach with a fresh lease and working CDP connection', async () => {
    await boot();
    state.guest.debugger.attach.mockImplementationOnce(() => {
      throw new Error('debugger attach unavailable');
    });
    const messages: unknown[] = [];
    const options = { write: (raw: string) => messages.push(JSON.parse(raw)) };
    const failed = openCdpRelayForPane(PANE, scope, options);
    const retry = openCdpRelayForPane(PANE, scope, options);
    try {
      expect(state.guest.debugger.attach).toHaveBeenCalledTimes(2);
      expect(failed).toBeNull();
      expect(retry).not.toBeNull();
      expect(debuggerListeners.size).toBe(1);
      retry!.connection.receive(JSON.stringify({
        id: 2, method: 'Page.getFrameTree', sessionId: 'nexus-preview-page',
      }));
      await vi.waitFor(() => expect(messages).toEqual([
        { id: 2, sessionId: 'nexus-preview-page', result: { root: {} } },
      ]));
      retry!.detach();
      expect(debuggerListeners.size).toBe(0);
      expect(state.guest.debugger.detach).toHaveBeenCalledTimes(1);
    } finally {
      failed?.detach();
      retry?.detach();
    }
  });

  it('shares a debugger acquired by another consumer during attach without detaching it', async () => {
    await boot();
    state.guest.debugger.attach.mockImplementationOnce(() => {
      vi.mocked(state.guest.debugger.isAttached).mockReturnValue(true);
      throw new Error('another debugger consumer attached');
    });
    const relay = openCdpRelayForPane(PANE, scope, { write: () => undefined });
    try {
      expect(relay).not.toBeNull();
      expect(debuggerListeners.size).toBe(1);
    } finally {
      relay?.detach();
    }
    expect(debuggerListeners.size).toBe(0);
    expect(state.guest.debugger.detach).not.toHaveBeenCalled();
  });

  it('does not borrow an entry by raw pane id, foreign checkout, or forged scope identity', async () => {
    await boot();
    const options = { write: () => undefined };
    expect(openCdpRelayForPane(PANE, { ...scope, checkoutId: 'foreign' }, options)).toBeNull();
    expect(openCdpRelayForPane(PANE, { ...scope, rootRealPath: '/foreign' }, options)).toBeNull();
    expect(openCdpRelayForPane(PANE, { ...scope, installationId: 'foreign' }, options)).toBeNull();
    expect(openCdpRelayForPane('unknown-pane', scope, options)).toBeNull();
    expect(state.guest.debugger.attach).not.toHaveBeenCalled();
  });

  it('refuses a closed pane, destroyed tab, or dead owner/window', async () => {
    await boot();
    const options = { write: () => undefined };
    state.guest.isDestroyed.mockReturnValue(true);
    expect(openCdpRelayForPane(PANE, scope, options)).toBeNull();
    state.guest.isDestroyed.mockReturnValue(false);
    state.owner.isDestroyed.mockReturnValue(true);
    expect(openCdpRelayForPane(PANE, scope, options)).toBeNull();
    state.owner.isDestroyed.mockReturnValue(false);
    state.win.isDestroyed.mockReturnValue(true);
    expect(openCdpRelayForPane(PANE, scope, options)).toBeNull();
    state.win.isDestroyed.mockReturnValue(false);
    destroyBrowser(PANE, scope);
    expect(openCdpRelayForPane(PANE, scope, options)).toBeNull();
    expect(state.guest.debugger.attach).not.toHaveBeenCalled();
  });

  it('keeps the relay scoped to a parked project and refuses it after that workspace is forgotten', async () => {
    registerBrowserIpc({} as never);
    bindResolvedRendererWorkspaceScope(state.owner, scope);
    await boot();
    const foreign = { ...scope, projectId: 'foreign', checkoutId: 'foreign', rootRealPath: '/foreign' };
    bindResolvedRendererWorkspaceScope(state.owner, foreign);
    let relay: ReturnType<typeof openCdpRelayForPane> = null;
    try {
      relay = openCdpRelayForPane(PANE, scope, { write: () => undefined });
      expect(relay).not.toBeNull();
      expect(openCdpRelayForPane(PANE, foreign, { write: () => undefined })).toBeNull();
      relay!.detach();
      forgetRendererWorkspace(state.owner, scope.rootRealPath);
      expect(openCdpRelayForPane(PANE, scope, { write: () => undefined })).toBeNull();
    } finally {
      relay?.detach();
      clearRendererWorkspaceScope(state.owner);
    }
  });

  it('preserves shared relay leases and detaches only the last owned attach', async () => {
    await boot();
    const options = { write: () => undefined };
    const first = openCdpRelayForPane(PANE, scope, options);
    const second = openCdpRelayForPane(PANE, scope, options);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    try {
      expect(state.guest.debugger.attach).toHaveBeenCalledTimes(1);
      first!.detach();
      first!.detach();
      expect(state.guest.debugger.detach).not.toHaveBeenCalled();
      second!.detach();
      expect(state.guest.debugger.detach).toHaveBeenCalledTimes(1);
    } finally {
      first?.detach();
      second?.detach();
    }
  });

  it('does not detach a debugger already owned by another Main consumer', async () => {
    await boot();
    vi.spyOn(state.guest.debugger, 'isAttached').mockReturnValue(true);
    const relay = openCdpRelayForPane(PANE, scope, { write: () => undefined });
    expect(relay).not.toBeNull();
    relay!.detach();
    expect(state.guest.debugger.attach).not.toHaveBeenCalled();
    expect(state.guest.debugger.detach).not.toHaveBeenCalled();
  });
});


describe('F-1076: static preview never grants raw CDP access', () => {
  let fixture: string;
  let previewApi: typeof import('../orch/preview-server');
  beforeEach(async () => {
    previewApi = await vi.importActual<typeof import('../orch/preview-server')>('../orch/preview-server');
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-static-cdp-'));
    fs.writeFileSync(path.join(fixture, 'index.html'), '<h1>static preview remains usable</h1>');
    await boot();
    vi.spyOn(state.guest.debugger, 'isAttached').mockReturnValue(true);
    state.guest.debugger.attach.mockClear();state.guest.debugger.on.mockClear();
  });
  afterEach(() => {
    previewApi.stopAllPreviews();
    destroyBrowser(PANE, scope);
    vi.restoreAllMocks();
    fs.rmSync(fixture, {recursive:true,force:true});
  });
  it('does not advertise a Main-owned browser through discovery, even on its preview origin', async () => {
    const preview = await previewApi.startPreview(fixture, scope);
    state.guest.getURL.mockReturnValue(preview.url);
    const staticPage = await fetch(preview.url);
    expect(staticPage.status).toBe(200);
    expect(await staticPage.text()).toContain('static preview remains usable');
    const discovery = await fetch(new URL('/json/version', preview.url));
    expect(discovery.status).toBe(404);
    expect(await discovery.text()).not.toContain('webSocketDebuggerUrl');
  });
  it('refuses actual WebSocket upgrades with arbitrary local credentials', async () => {
    const preview = await previewApi.startPreview(fixture, scope);
    state.guest.getURL.mockReturnValue(preview.url);
    const ws = new WebSocket(`ws://127.0.0.1:${preview.port}/cdp/${PANE}`, {headers:{Authorization:'Bearer arbitrary-local-token'}});
    const outcome = await new Promise<string>(resolve => {
      ws.once('open', () => { ws.close(); resolve('opened'); });
      ws.once('unexpected-response', (_req,res) => { res.resume(); ws.terminate(); resolve(`http-${res.statusCode}`); });
      ws.once('error', () => resolve('refused'));
    });
    expect(outcome).not.toBe('opened');
    expect(state.guest.debugger.attach).not.toHaveBeenCalled();
    expect(state.guest.debugger.on).not.toHaveBeenCalled();
    expect(state.guest.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything(), expect.anything());
  });
});

describe('F-1078: retained isolated CDP factory lease boundaries', () => {
  const relays:NonNullable<ReturnType<typeof openCdpRelayForPane>>[]=[];
  const openLease=(options:{write:(raw:string)=>void;signal?:AbortSignal;assertCurrentAuthority?:()=>void})=>{const relay=openCdpRelayForPane(PANE,scope,options);if(relay)relays.push(relay);return relay;};
  beforeEach(async()=>{
    destroyBrowser(PANE,scope);vi.clearAllMocks();state.guestHandlers.clear();state.profileMode='isolated';
    state.guest.isDestroyed.mockReturnValue(false);state.owner.isDestroyed.mockReturnValue(false);state.win.isDestroyed.mockReturnValue(false);
    state.guest.getURL.mockReturnValue('https://example.test/owned');
    vi.spyOn(state.guest.debugger,'isAttached').mockReturnValue(true);
    bindResolvedRendererWorkspaceScope(state.owner,scope);
    await boot();
  });
  afterEach(()=>{
    for(const relay of relays.splice(0))relay.detach();
    state.guest.isDestroyed.mockReturnValue(false);state.owner.isDestroyed.mockReturnValue(false);state.win.isDestroyed.mockReturnValue(false);
    destroyBrowser(PANE,scope);clearRendererWorkspaceScope(state.owner);vi.restoreAllMocks();
  });
  it('drops commands and releases listeners after main-frame navigation',async()=>{
    const write=vi.fn();const relay=openLease({write})!;
    expect(relay).not.toBeNull();
    for(const handler of state.guestHandlers.get('did-start-navigation')??[])handler({},'https://foreign.test/',false,true);
    state.guest.getURL.mockReturnValue('https://foreign.test/');
    relay.connection.receive(JSON.stringify({id:1,method:'Runtime.evaluate',sessionId:'nexus-preview-page',params:{expression:'document.title'}}));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(state.guest.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate',expect.anything(),expect.anything());
    expect(write).not.toHaveBeenCalled();expect(state.guest.debugger.removeListener).toHaveBeenCalledWith('message',expect.any(Function));
  });
  it('aborts retained authority and suppresses late native responses',async()=>{
    const controller=new AbortController();const write=vi.fn();let resolveSend!:(value:unknown)=>void;
    state.guest.debugger.sendCommand.mockImplementationOnce(()=>new Promise(resolve=>{resolveSend=resolve;}));
    const options={write,signal:controller.signal,assertCurrentAuthority:()=>{if(controller.signal.aborted)throw Error('revoked');}};
    const relay=openLease(options)!;
    relay.connection.receive(JSON.stringify({id:1,method:'Page.getFrameTree',sessionId:'nexus-preview-page'}));
    await vi.waitFor(()=>expect(resolveSend).toBeDefined());controller.abort();resolveSend({secret:'new-document'});
    await new Promise(resolve=>setTimeout(resolve,0));expect(write).not.toHaveBeenCalled();
    expect(state.guest.debugger.removeListener).toHaveBeenCalledWith('message',expect.any(Function));
  });
  it('rejects destroyed owner/current entry on every native command',async()=>{
    const write=vi.fn();const relay=openLease({write})!;
    state.owner.isDestroyed.mockReturnValue(true);
    relay.connection.receive(JSON.stringify({id:1,method:'Page.getFrameTree',sessionId:'nexus-preview-page'}));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(state.guest.debugger.sendCommand).not.toHaveBeenCalledWith('Page.getFrameTree',{},undefined);expect(write).not.toHaveBeenCalled();
  });
  it('refuses fresh raw factory access to an automated exact-surface browser',async()=>{
    lockBrowserToExactUrl(PANE,scope,'https://example.test/owned');
    expect(openLease({write:()=>undefined})).toBeNull();
  });
  it('refuses personal-profile entries before debugger attach',async()=>{
    destroyBrowser(PANE,scope);state.profileMode='personal';await boot();
    expect(openLease({write:()=>undefined})).toBeNull();
  });
  it('invalidates an old entry when the same pane is destroyed and recreated',async()=>{
    const write=vi.fn();const relay=openLease({write})!;
    destroyBrowser(PANE,scope);await boot();
    relay.connection.receive(JSON.stringify({id:1,method:'Page.getFrameTree',sessionId:'nexus-preview-page'}));
    await new Promise(resolve=>setTimeout(resolve,0));expect(write).not.toHaveBeenCalled();
    expect(state.guest.debugger.sendCommand).not.toHaveBeenCalledWith('Page.getFrameTree',{},undefined);
  });
  it('suppresses an already-queued native event after detach',async()=>{
    const write=vi.fn();const relay=openLease({write})!;
    relay.connection.receive(JSON.stringify({id:1,method:'Target.setAutoAttach'}));
    await vi.waitFor(()=>expect(write).toHaveBeenCalledTimes(2));
    const listener=state.guest.debugger.on.mock.calls.find(call=>call[0]==='message')?.[1] as (...args:unknown[])=>void;
    expect(listener).toBeTypeOf('function');write.mockClear();relay.detach();
    listener({},'Page.loadEventFired',{},undefined);
    relay.connection.event('Page.loadEventFired',{},undefined);
    expect(write).not.toHaveBeenCalled();
  });
});
