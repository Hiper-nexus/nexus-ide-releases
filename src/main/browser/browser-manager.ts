import {
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  session as electronSession,
} from 'electron';
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BROWSER_CHANNELS } from '../../shared/channels';
import {
  BROWSER_DESIGN_CHANNELS,
  type BrowserDesignAnnotationMarker,
  type BrowserDesignEvent,
  type BrowserDesignRect,
} from '../../shared/browser-design';
import type {
  BrowserAutomationCommand,
  BrowserElementDescriptor,
  BrowserPageReadResult,
  BrowserWaitCondition,
} from '../../shared/browser-automation';
import type {
  BrowserPaneBounds,
  BrowserPaneState,
  BrowserScreenshotResult,
} from '../../shared/types';
import {
  isRunningPreviewUrl,
  isRunningPreviewUrlForScope,
} from '../orch/preview-server';
import {
  assessBrowserUrl,
  browserAddressesMatchPrivatePins,
  browserNetworkTargetKey,
  normalizeBrowserUrl,
  redactBrowserUrl,
  type BrowserAddressResolver,
  type BrowserUrlAllowed,
  type BrowserUrlBlockKind,
} from './url-policy';
import {
  browserClickResultSchema,
  browserElementDescriptorSchema,
  browserFillResultSchema,
  browserHoverResultSchema,
  browserPageReadResultSchema,
  browserPressResultSchema,
  browserScrollResultSchema,
  browserWaitResultSchema,
} from './browser-automation-schema';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
  requireLiveRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import { createScopedBrowserArtifactStore } from './browser-artifact-store';
import {
  registerBrowserAutomationResponseHandler,
  rejectPendingBrowserAutomation,
  runBrowserAutomation,
} from './browser-automation-runtime';
import {
  installPinnedBrowserProxy,
  type PinnedBrowserProxy,
} from './browser-network-proxy';
import {
  browserDesignAnnotationMarkersResultSchema,
  browserDesignModeResultSchema,
  browserStylePreviewClearResultSchema,
  browserStylePreviewResultSchema,
} from './browser-design-schema';
import {
  abortDesignModeTransition,
  addDesignAnnotation,
  clearDesignAnnotations,
  clearDesignSession,
  deleteDesignAnnotation,
  getDesignAnnotationSummaries,
  getDesignAnnotations,
  getDesignGeneration,
  getLastSelection,
  getSelections,
  ingestDesignEvent,
  isDesignModeActive,
  onDesignEvent,
  prepareDesignModeTransition,
} from './design-session';
import { clampScreenshotClip } from './screenshot-clip';
import {
  sendDesignAnnotationsToAgent,
  sendDesignSelectionToAgent,
} from '../orch/design-send';
import { readWorkspaceDesignSystem } from '../orch/design-system-reader';
import { searchWorkspaceForSelection } from '../orch/design-code-search';
import {
  getDevServerForPane,
  getPaneAuthzInfoOwnedBy,
  getPaneAuthzInfoOwnedByPane,
} from '../orch/pane-registry';
import { injectPastedPrompt } from '../orch/tool-util';
import { resolveCwdForScope } from '../orch/workspace-path';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { z } from 'zod';

interface BrowserEntry {
  paneId: string;
  scope: ProjectExecutionScope;
  owner: WebContents;
  view: WebContentsView;
  url: string;
  title: string;
  loading: boolean;
  error?: string;
  allowedPrivateTargets: Map<string, Set<string>>;
  resolveHostname: BrowserAddressResolver;
  networkProxy: PinnedBrowserProxy;
}

const browsers = new Map<string, BrowserEntry>();
const browserCreations = new Map<string, Promise<BrowserEntry>>();
/**
 * Geometry can arrive from the renderer before create finishes (slot mounts
 * immediately, WebContentsView is async). Stash the latest bounds and apply
 * them as soon as the entry exists — otherwise the view stays 0×0 / hidden
 * until a later resize.
 */
const pendingBoundsByKey = new Map<
  string,
  { bounds: BrowserPaneBounds; owner: WebContents }
>();
const ELEMENT_SHOT_PADDING = 8;
const DNS_TIMEOUT_MS = 3_000;
const securedSessions = new WeakSet<Session>();
// Emulação mobile do preview responsivo: breakpoint ≤480 troca UA + métricas
// para o site servir o layout mobile REAL (não só a largura estreitada).
const MOBILE_EMULATION_MAX_WIDTH = 480;
const MOBILE_EMULATION_HEIGHT = 844;
const MOBILE_EMULATION_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const originalUserAgents = new Map<string, string>();
let browserRuntimeManager: ProjectRuntimeManager | null = null;
let unsubscribeBrowserScopeChanges: (() => void) | null = null;

const paneIdSchema = z.string().min(1).max(128);
const createSchema = z.object({
  paneId: paneIdSchema,
  url: z.string().max(4096).optional(),
});
const boundsSchema = z.object({
  paneId: paneIdSchema,
  bounds: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    visible: z.boolean().optional(),
  }),
});
const loadSchema = z.object({
  paneId: paneIdSchema,
  url: z.string().min(1).max(4096),
});
const paneSchema = z.object({ paneId: paneIdSchema });
const designModeSchema = z.object({
  paneId: paneIdSchema,
  active: z.boolean(),
});
const designSendSchema = z
  .object({
    paneId: paneIdSchema,
    targetPaneId: paneIdSchema,
    instruction: z.string().max(2_000).optional(),
    dir: z.string().max(4_096).optional(),
    intent: z.enum(['context', 'clone']).optional(),
    dryRun: z.boolean().optional(),
    styleDiff: z
      .record(
        z.string().min(1).max(64),
        z
          .object({ from: z.string().max(512), to: z.string().max(512) })
          .strict(),
      )
      .refine((diff) => Object.keys(diff).length <= 64)
      .optional(),
  })
  .strict();
const designPreviewSchema = z
  .object({
    paneId: paneIdSchema,
    selector: z.string().min(1).max(1_024),
    styles: z
      .record(z.string().min(1).max(64), z.string().min(1).max(512))
      .refine((styles) => {
        const count = Object.keys(styles).length;
        return count >= 1 && count <= 64;
      }),
  })
  .strict();
const designPreviewClearSchema = z
  .object({
    paneId: paneIdSchema,
    selector: z.string().min(1).max(1_024).optional(),
  })
  .strict();
const designAnnotateSchema = z
  .object({
    paneId: paneIdSchema,
    comment: z.string().min(1).max(2_000),
    intent: z.enum(['fix', 'change', 'question', 'approve']),
    priority: z.enum(['blocking', 'important', 'suggestion']).optional(),
  })
  .strict();
const designAnnotationDeleteSchema = z
  .object({
    paneId: paneIdSchema,
    annotationId: z.string().uuid(),
  })
  .strict();
const designAnnotationsSendSchema = z
  .object({
    paneId: paneIdSchema,
    // Optional so a dry run (clipboard copy) works without any agent pane;
    // the handler enforces it for real sends.
    targetPaneId: paneIdSchema.optional(),
    dir: z.string().max(4_096).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

function browserKey(scope: ProjectExecutionScope, paneId: string): string {
  return `${scope.projectId}\0${scope.checkoutId}\0${paneId}`;
}

/** Opaque key shared with the design-session store; never crosses IPC. */
export function browserDesignSessionKey(
  scope: ProjectExecutionScope,
  paneId: string,
): string {
  return browserKey(scope, paneId);
}

function loopbackOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) return null;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Direct source write-back is only allowed from a main-owned local preview.
 * Public/third-party pages always stay on the selection→agent path.
 */
export function assertTrustedLocalDesignPreview(
  owner: WebContents,
  scope: ProjectExecutionScope,
  browserPaneId: string,
  missionPaneId: string,
): void {
  const key = browserKey(scope, browserPaneId);
  const entry = browsers.get(key);
  if (!entry || entry.owner !== owner || !sameProjectScope(entry.scope, scope)) {
    throw new Error('design write-back requires an owned browser pane in this project');
  }
  if (!isDesignModeActive(key)) {
    throw new Error('design write-back requires active design mode');
  }
  const currentUrl = entry.view.webContents.getURL() || entry.url;
  if (isRunningPreviewUrlForScope(currentUrl, scope)) return;

  const missionPane = getPaneAuthzInfoOwnedByPane(owner, missionPaneId);
  const detected = missionPane?.sessionId
    ? getDevServerForPane(missionPane.sessionId)
    : null;
  const currentOrigin = loopbackOrigin(currentUrl);
  const announcedOrigins = new Set(
    (detected?.urls ?? [])
      .map(loopbackOrigin)
      .filter((origin): origin is string => origin !== null),
  );
  if (!currentOrigin || !announcedOrigins.has(currentOrigin)) {
    throw new Error(
      'direct write-back is available only for a local preview announced by this mission pane',
    );
  }
}

function browserPartition(scope: ProjectExecutionScope, paneId: string): string {
  const digest = createHash('sha256')
    .update(scope.projectId)
    .update('\0')
    .update(scope.checkoutId)
    .update('\0')
    .update(paneId)
    .digest('hex');
  return `persist:nexus-browser-${digest}`;
}

function requireBrowserRuntimeManager(): ProjectRuntimeManager {
  if (!browserRuntimeManager) {
    throw new Error('project-scoped browser runtime is not configured');
  }
  return browserRuntimeManager;
}

function assertEntryScope(
  entry: BrowserEntry,
  scope: ProjectExecutionScope,
): void {
  if (!sameProjectScope(entry.scope, scope)) {
    throw new Error('browser pane belongs to another project checkout');
  }
}

class BrowserNavigationBlockedError extends Error {
  constructor(
    readonly kind: BrowserUrlBlockKind,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserNavigationBlockedError';
  }
}

function createChromiumResolver(session: Session): BrowserAddressResolver {
  const inFlight = new Map<string, Promise<string[]>>();
  return (hostname) => {
    const existing = inFlight.get(hostname);
    if (existing) return existing;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const resolution = Promise.race([
      session
        .resolveHost(hostname, { cacheUsage: 'disallowed', source: 'any' })
        .then((result) => [...new Set(result.endpoints.map((endpoint) => endpoint.address))]),
      new Promise<string[]>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS policy timeout')), DNS_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
      inFlight.delete(hostname);
    });
    inFlight.set(hostname, resolution);
    return resolution;
  };
}

function safeTargetLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid target';
  }
}

function allowedTargetMatchesPins(
  decision: BrowserUrlAllowed,
  approvedPrivateAddresses?: ReadonlySet<string>,
): boolean {
  return (
    isRunningPreviewUrl(decision.normalizedUrl) ||
    browserAddressesMatchPrivatePins(
      decision.addresses,
      decision.addressClasses,
      approvedPrivateAddresses,
    )
  );
}

function privateAddressesOf(decision: BrowserUrlAllowed): Set<string> {
  return new Set(
    decision.addresses.filter(
      (_address, index) => decision.addressClasses[index] !== 'public',
    ),
  );
}

function configureSessionSecurity(entry: BrowserEntry): void {
  const session = entry.view.webContents.session;
  if (!securedSessions.has(session)) {
    securedSessions.add(session);
    session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.on('will-download', (event) => {
      // Browser automation has no download primitive. Prevent a click from
      // writing an attacker-selected file without a dedicated confirmation.
      event.preventDefault();
    });
  }

  session.webRequest.onBeforeRequest(
    {
      urls: [
        'http://*/*',
        'https://*/*',
        'ws://*/*',
        'wss://*/*',
      ],
    },
    (details, callback) => {
      let targetKey = '';
      try {
        targetKey = browserNetworkTargetKey(details.url);
      } catch {
        callback({ cancel: true });
        return;
      }
      const approvedPrivateAddresses = entry.allowedPrivateTargets.get(targetKey);
      void assessBrowserUrl(details.url, {
        requestProtocols: true,
        resolver: entry.resolveHostname,
        allowPrivateNetwork: Boolean(approvedPrivateAddresses?.size),
        isTrustedPrivateUrl: (url) => isRunningPreviewUrl(url),
      })
        .then((decision) => {
          if (
            decision.allowed &&
            allowedTargetMatchesPins(decision, approvedPrivateAddresses)
          ) {
            callback({});
            return;
          }
          const blockKind = decision.allowed ? 'private-network' : decision.kind;
          if (details.resourceType === 'mainFrame') {
            entry.loading = false;
            entry.error = `navigation blocked (${blockKind}): ${safeTargetLabel(details.url)}`;
            emitState(entry);
          }
          callback({ cancel: true });
        })
        .catch(() => callback({ cancel: true }));
    },
  );
}

async function prepareNavigation(
  entry: BrowserEntry,
  rawUrl: string,
  privateAccessConfirmed: boolean,
): Promise<string> {
  let normalized: string;
  try {
    normalized = normalizeBrowserUrl(rawUrl, { allowAboutBlank: true });
  } catch (err) {
    throw new BrowserNavigationBlockedError(
      'invalid-url',
      err instanceof Error ? err.message : 'invalid browser URL',
    );
  }
  if (normalized === 'about:blank') return normalized;

  const targetKey = browserNetworkTargetKey(normalized);
  const assess = (allowPrivateNetwork: boolean) =>
    assessBrowserUrl(normalized, {
      resolver: entry.resolveHostname,
      allowPrivateNetwork,
      isTrustedPrivateUrl: (url) => isRunningPreviewUrl(url),
    });
  const existingPins = entry.allowedPrivateTargets.get(targetKey);
  let decision = await assess(Boolean(existingPins?.size));
  const needsPrivateConfirmation = decision.allowed
    ? !allowedTargetMatchesPins(decision, existingPins)
    : decision.kind === 'private-network';
  if (needsPrivateConfirmation && privateAccessConfirmed) {
    decision = await assess(true);
    if (decision.allowed && !isRunningPreviewUrl(decision.normalizedUrl)) {
      const privateAddresses = privateAddressesOf(decision);
      if (privateAddresses.size > 0) {
        entry.allowedPrivateTargets.set(targetKey, privateAddresses);
      } else {
        entry.allowedPrivateTargets.delete(targetKey);
      }
    }
  }
  if (!decision.allowed) {
    throw new BrowserNavigationBlockedError(decision.kind, decision.reason);
  }
  if (
    !allowedTargetMatchesPins(
      decision,
      entry.allowedPrivateTargets.get(targetKey),
    )
  ) {
    throw new BrowserNavigationBlockedError(
      'private-network',
      'private target address changed; confirmation required',
    );
  }
  return decision.normalizedUrl;
}

function isSyntacticallySafeNavigation(rawUrl: string): boolean {
  try {
    normalizeBrowserUrl(rawUrl, { allowAboutBlank: true });
    return true;
  } catch {
    return false;
  }
}

function stateOf(paneId: string, entry: BrowserEntry): BrowserPaneState {
  const fallback: BrowserPaneState = {
    paneId,
    url: entry.url,
    title: entry.title,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    error: entry.error,
  };
  try {
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return fallback;
    return {
      paneId,
      url: wc.getURL() || entry.url,
      title: wc.getTitle() || entry.title,
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      loading: entry.loading || wc.isLoading(),
      error: entry.error,
    };
  } catch {
    // WebContentsView.webContents can disappear between an async event and
    // teardown. Cached state is sufficient while the pane is closing.
    return fallback;
  }
}

function redactBrowserLabel(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
    .replace(
      /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      '[REDACTED_JWT]',
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(
      /(\b(?:api[_ -]?key|password|secret|token|authorization|credential)\b\s*[:=]\s*)([^\s,;]{4,})/gi,
      '$1[REDACTED]',
    )
    .slice(0, 512);
}

const canSend = (wc: WebContents): boolean => !wc.isDestroyed() && !wc.isCrashed();

function liveOwnerWindow(owner: WebContents): BrowserWindow | null {
  if (!canSend(owner)) return null;
  try {
    const window = BrowserWindow.fromWebContents(owner);
    return window && !window.isDestroyed() ? window : null;
  } catch {
    // Electron may destroy WebContents between the liveness check and lookup.
    return null;
  }
}

function emitState(entry: BrowserEntry): BrowserPaneState {
  const state = stateOf(entry.paneId, entry);
  try {
    if (canSend(entry.owner)) {
      entry.owner.send(BROWSER_CHANNELS.state, state);
    }
  } catch {
    // The owner may be destroyed after the liveness check during shutdown.
  }
  return state;
}

function assertOwner(entry: BrowserEntry, owner: WebContents): void {
  if (entry.owner !== owner) {
    throw new Error('browser pane belongs to another window');
  }
}

async function createEntry(
  owner: WebContents,
  scope: ProjectExecutionScope,
  paneId: string,
): Promise<BrowserEntry> {
  const ownerScopeAtStart = getRendererWorkspaceScope(owner);
  if (ownerScopeAtStart && !sameProjectScope(ownerScopeAtStart, scope)) {
    throw new Error('browser owner project scope changed');
  }
  const win = liveOwnerWindow(owner);
  if (!win) throw new Error('browser owner window is gone');

  const partition = browserPartition(scope, paneId);
  const browserSession = electronSession.fromPartition(partition);
  const allowedPrivateTargets = new Map<string, Set<string>>();
  const resolveHostname = createChromiumResolver(browserSession);
  // Configure the session before creating WebContents. The proxy performs the
  // final socket connection to the exact IP that passed policy, eliminating
  // Chromium's independent post-check DNS lookup.
  const networkProxy = await installPinnedBrowserProxy(browserSession, {
    resolver: resolveHostname,
    privateTargetAddresses: (targetKey) => allowedPrivateTargets.get(targetKey),
    isTrustedPrivateUrl: (url) => isRunningPreviewUrl(url),
  });
  if (win.isDestroyed()) {
    await networkProxy.close();
    throw new Error('browser owner window is gone');
  }
  if (ownerScopeAtStart) {
    const currentScope = getRendererWorkspaceScope(owner);
    if (!currentScope || !sameProjectScope(currentScope, scope)) {
      await networkProxy.close();
      throw new Error('browser owner project scope changed during creation');
    }
  }
  let view: WebContentsView;
  try {
    view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        preload: path.join(__dirname, 'browser-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    });
  } catch (error) {
    await networkProxy.close();
    throw error;
  }
  // O WebContentsView nasce com o fundo BRANCO padrão do Chromium; num shell
  // escuro, todo load lento vira um retângulo branco gigante até o primeiro
  // paint do site. Mesma cor do --bg do renderer (base.css).
  view.setBackgroundColor('#0a0e15');
  const entry: BrowserEntry = {
    paneId,
    scope: Object.freeze({ ...scope }),
    owner,
    view,
    url: 'about:blank',
    title: 'browser',
    loading: false,
    allowedPrivateTargets,
    resolveHostname,
    networkProxy,
  };
  const key = browserKey(scope, paneId);
  browsers.set(key, entry);
  win.contentView.addChildView(view);
  configureSessionSecurity(entry);

  const wc = view.webContents;
  // Keep WebRTC from opening direct UDP sockets around the session proxy.
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setWindowOpenHandler(({ url }) => {
    void loadBrowserForEntry(paneId, entry, url).catch((err) => {
      entry.error = err instanceof Error ? err.message : String(err);
      emitState(entry);
    });
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isSyntacticallySafeNavigation(url)) event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    if (!isSyntacticallySafeNavigation(url)) event.preventDefault();
  });
  wc.on('did-start-loading', () => {
    entry.loading = true;
    entry.error = undefined;
    emitState(entry);
  });
  wc.on('did-stop-loading', () => {
    entry.loading = false;
    emitState(entry);
  });
  wc.on('page-title-updated', (_event, title) => {
    entry.title = title;
    emitState(entry);
  });
  wc.on('did-navigate', (_event, url) => {
    entry.url = url;
    entry.error = undefined;
    // Annotations and the picker session both point at the OLD document —
    // rects and selectors stop meaning anything after a real navigation.
    resetDesignPaneState(entry, key, { sameDocument: false });
    emitState(entry);
  });
  wc.on('did-navigate-in-page', (_event, url) => {
    // SPA routing (pushState) never fires did-navigate, but the annotated UI
    // is just as gone. Hash-only hops keep the design state.
    const previousUrl = entry.url;
    entry.url = url;
    if (shouldResetDesignForUrlChange(previousUrl, url)) {
      resetDesignPaneState(entry, key, { sameDocument: true });
    }
    emitState(entry);
  });
  wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    entry.loading = false;
    entry.url = url || entry.url;
    entry.error = `${code} ${desc}`;
    emitState(entry);
  });
  wc.on('render-process-gone', (_event, details) => {
    rejectPendingBrowserAutomation(
      wc.id,
      `browser renderer exited: ${details.reason}`,
    );
    entry.loading = false;
    entry.error = `browser renderer exited: ${details.reason}`;
    // The document died with the renderer: a live design session here would
    // keep isDesignModeActive() true for a page that no longer exists (and
    // with it the write-back gate). Same reset as a navigation.
    resetDesignPaneState(entry, key, { sameDocument: false });
    emitState(entry);
  });
  wc.once('destroyed', () => {
    rejectPendingBrowserAutomation(wc.id, 'browser pane was destroyed');
  });
  owner.once('destroyed', () => {
    if (browsers.get(key) === entry) destroyBrowser(paneId, scope);
  });
  // Hide until the first real geometry arrives — avoids a 0×0 flash.
  view.setVisible(false);
  applyPendingBounds(entry);
  return entry;
}

export async function ensureBrowser(
  owner: WebContents,
  scope: ProjectExecutionScope,
  paneId: string,
  url?: string,
): Promise<BrowserPaneState> {
  const key = browserKey(scope, paneId);
  let entry = browsers.get(key);
  if (!entry) {
    let creation = browserCreations.get(key);
    if (!creation) {
      creation = createEntry(owner, scope, paneId).finally(() => {
        browserCreations.delete(key);
      });
      browserCreations.set(key, creation);
    }
    entry = await creation;
    assertOwner(entry, owner);
    applyPendingBounds(entry);
  } else {
    assertOwner(entry, owner);
    assertEntryScope(entry, scope);
    applyPendingBounds(entry);
  }
  if (url && url.trim() && url.trim() !== (entry.view.webContents.getURL() || entry.url)) {
    void loadBrowserForEntry(paneId, entry, url).catch((err) => {
      entry.error = err instanceof Error ? err.message : String(err);
      entry.loading = false;
      emitState(entry);
    });
  }
  return stateOf(paneId, entry);
}

async function loadBrowserForEntry(
  paneId: string,
  entry: BrowserEntry,
  rawUrl: string,
  options: { privateAccessConfirmed?: boolean } = {},
): Promise<BrowserPaneState> {
  const url = await prepareNavigation(
    entry,
    rawUrl,
    options.privateAccessConfirmed === true,
  );
  entry.url = url;
  entry.error = undefined;
  if (url === 'about:blank') {
    entry.view.webContents.loadURL(url).catch(() => {});
  } else {
    await entry.view.webContents.loadURL(url);
  }
  return stateOf(paneId, entry);
}

export async function loadBrowser(
  paneId: string,
  rawUrl: string,
  options: {
    scope: ProjectExecutionScope;
    privateAccessConfirmed?: boolean;
  },
): Promise<BrowserPaneState> {
  const state = await loadBrowserForEntry(
    paneId,
    withEntry(paneId, options.scope),
    rawUrl,
    options,
  );
  return {
    ...state,
    url: redactBrowserUrl(state.url),
    title: redactBrowserLabel(state.title),
    ...(state.error ? { error: redactBrowserLabel(state.error) } : {}),
  };
}

async function loadBrowserWithUserConfirmation(
  paneId: string,
  entry: BrowserEntry,
  rawUrl: string,
): Promise<BrowserPaneState> {
  try {
    return await loadBrowserForEntry(paneId, entry, rawUrl);
  } catch (err) {
    if (!(err instanceof BrowserNavigationBlockedError) || err.kind !== 'private-network') {
      throw err;
    }
    const win = liveOwnerWindow(entry.owner);
    if (!win) throw new Error('browser owner window is gone');
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Permitir acesso à rede privada?',
      message: `O navegador quer abrir ${safeTargetLabel(rawUrl)}`,
      detail:
        'Esse endereço alcança localhost ou a rede local. Permita apenas se você reconhece o serviço.',
      buttons: ['Cancelar', 'Permitir este endereço'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) throw new Error('private-network navigation denied by user');
    return loadBrowserForEntry(paneId, entry, rawUrl, {
      privateAccessConfirmed: true,
    });
  }
}

export async function captureBrowserScreenshot(
  paneId: string,
  scope: ProjectExecutionScope,
  missionId?: string,
  options: { clip?: BrowserDesignRect } = {},
): Promise<BrowserScreenshotResult> {
  const entry = withEntry(paneId, scope);
  const artifactStore = createScopedBrowserArtifactStore(
    requireBrowserRuntimeManager(),
    scope,
  );
  artifactStore.assertWritable();
  const wc = entry.view.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) {
    throw new Error(`browser pane is not capturable: ${paneId}`);
  }

  const capturedAt = Date.now();
  const clip = options.clip
    ? clampScreenshotClip(options.clip, entry.view.getBounds(), {
        padding: ELEMENT_SHOT_PADDING,
      })
    : null;
  const image = await (clip ? wc.capturePage(clip) : wc.capturePage());
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    throw new Error('browser screenshot is empty; the pane may not be visible yet');
  }

  const artifact = artifactStore.recordScreenshot({
    paneId,
    missionId,
    png: image.toPNG(),
    width: size.width,
    height: size.height,
    url: redactBrowserUrl(wc.getURL() || entry.url),
    title: redactBrowserLabel(wc.getTitle() || entry.title),
    capturedAt,
  });

  return {
    artifactId: artifact.id,
    projectId: artifact.projectId,
    checkoutId: artifact.checkoutId,
    paneId,
    path: artifact.path,
    storageKey: artifact.storageKey,
    sha256: artifact.sha256,
    width: size.width,
    height: size.height,
    url: redactBrowserUrl(wc.getURL() || entry.url),
    title: redactBrowserLabel(wc.getTitle() || entry.title),
    capturedAt,
  };
}

function runBrowserAutomationForPane(
  paneId: string,
  scope: ProjectExecutionScope,
  command: BrowserAutomationCommand,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const entry = withEntry(paneId, scope);
  return runBrowserAutomation(
    paneId,
    entry.view.webContents,
    command,
    args,
    timeoutMs,
  );
}

export async function readBrowserPage(
  paneId: string,
  scope: ProjectExecutionScope,
  options: { maxChars?: number; maxElements?: number } = {},
): Promise<BrowserPageReadResult & { paneId: string }> {
  const result = browserPageReadResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'read', {
      ...(options.maxChars ? { maxChars: Math.min(options.maxChars, 20_000) } : {}),
      ...(options.maxElements
        ? { maxElements: Math.min(options.maxElements, 200) }
        : {}),
    }),
  );
  return { paneId, ...result };
}

export async function inspectBrowserElement(
  paneId: string,
  scope: ProjectExecutionScope,
  ref: string,
): Promise<BrowserElementDescriptor & { paneId: string }> {
  const result = browserElementDescriptorSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'inspect', { ref }),
  );
  return { paneId, ...result };
}

export async function clickBrowserElement(
  paneId: string,
  scope: ProjectExecutionScope,
  ref: string,
): Promise<{ paneId: string; clicked: true; element: BrowserElementDescriptor }> {
  const result = browserClickResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'click', { ref }),
  );
  return { paneId, ...result };
}

export async function fillBrowserElement(
  paneId: string,
  scope: ProjectExecutionScope,
  ref: string,
  text: string,
): Promise<{ paneId: string; filled: true; ref: string; length: number }> {
  const result = browserFillResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'fill', { ref, text }),
  );
  return { paneId, ...result };
}

export async function waitForBrowser(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    condition: BrowserWaitCondition;
    value?: string;
    ref?: string;
    timeoutMs?: number;
  },
): Promise<{
  paneId: string;
  matched: true;
  condition: BrowserWaitCondition;
  elapsedMs: number;
}> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5_000, 1), 15_000);
  const result = browserWaitResultSchema.parse(
    await runBrowserAutomationForPane(
      paneId,
      scope,
      'wait',
      {
        condition: options.condition,
        ...(options.value ? { value: options.value.slice(0, 256) } : {}),
        ...(options.ref ? { ref: options.ref } : {}),
        timeoutMs,
      },
      timeoutMs + 2_000,
    ),
  );
  return { paneId, ...result };
}

export async function scrollBrowserPane(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    ref?: string;
    dx?: number;
    dy?: number;
    x?: number;
    y?: number;
    behavior?: 'auto' | 'smooth';
  },
): Promise<{
  paneId: string;
  scrolled: true;
  scrollX: number;
  scrollY: number;
  target: 'page' | 'element';
}> {
  const result = browserScrollResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'scroll', {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.dx !== undefined ? { dx: options.dx } : {}),
      ...(options.dy !== undefined ? { dy: options.dy } : {}),
      ...(options.x !== undefined ? { x: options.x } : {}),
      ...(options.y !== undefined ? { y: options.y } : {}),
      ...(options.behavior ? { behavior: options.behavior } : {}),
    }),
  );
  return { paneId, ...result };
}

export async function pressBrowserKey(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    key: string;
    ref?: string;
    modifiers?: readonly string[];
  },
): Promise<{ paneId: string; pressed: true; key: string; ref?: string }> {
  const result = browserPressResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'press', {
      key: options.key,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.modifiers && options.modifiers.length > 0
        ? { modifiers: options.modifiers }
        : {}),
    }),
  );
  return { paneId, ...result };
}

export async function hoverBrowserElement(
  paneId: string,
  scope: ProjectExecutionScope,
  ref: string,
): Promise<{ paneId: string; hovered: true; element: BrowserElementDescriptor }> {
  const result = browserHoverResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'hover', { ref }),
  );
  return { paneId, ...result };
}

export async function setBrowserDesignMode(
  paneId: string,
  scope: ProjectExecutionScope,
  active: boolean,
): Promise<{ paneId: string; active: boolean }> {
  const sessionKey = browserKey(scope, paneId);
  const generation = active
    ? randomUUID()
    : (getDesignGeneration(sessionKey) ?? randomUUID());
  prepareDesignModeTransition(sessionKey, generation, active);
  try {
    const result = browserDesignModeResultSchema.parse(
      await runBrowserAutomationForPane(
        paneId,
        scope,
        active ? 'design_enable' : 'design_disable',
        { generation },
      ),
    );
    if (result.active !== active) {
      throw new Error('browser design mode transition was not applied');
    }
    if (active && !isDesignModeActive(sessionKey)) {
      throw new Error('browser design mode generation was not confirmed');
    }
    if (!active) clearDesignSession(sessionKey);
    return { paneId, ...result };
  } catch (error) {
    abortDesignModeTransition(sessionKey, generation);
    if (!active) {
      // Desligar NUNCA pode falhar para o usuário: uma SPA ocupada/mid-route
      // que não confirma o design_disable deixava a barra presa em "ON +
      // erro". O overlay da página morre sozinho na próxima navegação; o
      // estado local é a autoridade do desligamento.
      clearDesignSession(sessionKey);
      return { paneId, active: false };
    }
    throw error;
  }
}

export async function setBrowserStylePreview(
  paneId: string,
  scope: ProjectExecutionScope,
  selector: string,
  styles: Record<string, string>,
): Promise<{ paneId: string; applied: true; selector: string; properties: number }> {
  const result = browserStylePreviewResultSchema.parse(
    await runBrowserAutomationForPane(
      paneId,
      scope,
      'design_set_style_preview',
      { selector, styles },
    ),
  );
  return { paneId, ...result };
}

export async function clearBrowserStylePreview(
  paneId: string,
  scope: ProjectExecutionScope,
  selector?: string,
): Promise<{ paneId: string; cleared: number }> {
  const result = browserStylePreviewClearResultSchema.parse(
    await runBrowserAutomationForPane(
      paneId,
      scope,
      'design_clear_style_preview',
      selector ? { selector } : {},
    ),
  );
  return { paneId, ...result };
}

/**
 * Mirrors the pane's annotation set as numbered badges in the page (geometry
 * + advisory selector only — comments never reach the page side). Best-effort
 * by design: a pane mid-load or hidden keeps the annotations in the main
 * store; the badges simply catch up on the next mutation.
 */
async function syncDesignAnnotationMarkers(
  paneId: string,
  scope: ProjectExecutionScope,
): Promise<void> {
  const key = browserKey(scope, paneId);
  const markers: BrowserDesignAnnotationMarker[] = [];
  for (const [index, annotation] of getDesignAnnotations(key).entries()) {
    const { selection } = annotation;
    // Pre-rectPage payloads cannot follow scroll — skip their badge, the
    // annotation itself still lives in the tray and in the batch prompt.
    if (!selection.rectPage) continue;
    markers.push({
      id: annotation.id,
      index,
      rectPage: selection.rectPage,
      rectViewport: selection.rect,
      isFixed: selection.isFixed === true,
      // Lets the page layer track the LIVE element box (reflow/breakpoint/
      // sticky safe); the frozen rects above are its fallback.
      selector: selection.selector,
    });
  }
  try {
    browserDesignAnnotationMarkersResultSchema.parse(
      await runBrowserAutomationForPane(
        paneId,
        scope,
        'design_set_annotation_markers',
        { markers },
      ),
    );
  } catch {
    // Badges are cosmetic; the main store stays the source of truth.
  }
}

const designMarkerSyncChains = new Map<string, Promise<void>>();

/**
 * Fire-and-forget badge sync, serialized per pane so out-of-order pushes
 * cannot leave stale badges. NEVER awaited by IPC handlers: the automation
 * round-trip can stall up to its 7s timeout on a busy/reloading page, and the
 * badge repaint is cosmetic while the main store already committed.
 */
function queueDesignAnnotationMarkerSync(
  paneId: string,
  scope: ProjectExecutionScope,
): void {
  const key = browserKey(scope, paneId);
  const chain = designMarkerSyncChains.get(key) ?? Promise.resolve();
  const next = chain
    .then(() => syncDesignAnnotationMarkers(paneId, scope))
    .catch(() => {
      // syncDesignAnnotationMarkers already swallows; keep the chain alive.
    })
    .finally(() => {
      if (designMarkerSyncChains.get(key) === next) {
        designMarkerSyncChains.delete(key);
      }
    });
  designMarkerSyncChains.set(key, next);
}

/**
 * True when an in-page navigation actually changed the page the annotations
 * were pinned on: origin/path/query moved (SPA pushState routing). Hash-only
 * hops stay within the same rendered document — annotations survive them.
 */
export function shouldResetDesignForUrlChange(
  previousUrl: string,
  nextUrl: string,
): boolean {
  try {
    const previous = new URL(previousUrl);
    const next = new URL(nextUrl);
    return (
      previous.origin !== next.origin ||
      previous.pathname !== next.pathname ||
      previous.search !== next.search
    );
  } catch {
    // Unparseable URLs (about:blank boot states): reset only on inequality.
    return previousUrl !== nextUrl;
  }
}

/**
 * SINGLE document-death path for the design subsystem: clears the picker
 * session AND the annotations, disarms page-side state when the document is
 * still alive (SPA route change), and tells the renderer — so the design bar
 * and the annotation tray never survive a page their data no longer matches.
 * Used by did-navigate, in-page SPA navigation, renderer crash and destroy.
 */
function resetDesignPaneState(
  entry: BrowserEntry,
  key: string,
  options: { sameDocument: boolean },
): void {
  const generation = getDesignGeneration(key);
  const hadState =
    generation !== null || getDesignAnnotations(key).length > 0;
  clearDesignSession(key);
  clearDesignAnnotations(key);
  if (!hadState) return;
  if (options.sameDocument) {
    // The document survived (pushState routing): the picker overlay and the
    // badge layer are still alive in the page — disarm them best-effort.
    if (generation) {
      void runBrowserAutomationForPane(
        entry.paneId,
        entry.scope,
        'design_disable',
        { generation },
      ).catch(() => {});
    }
    void runBrowserAutomationForPane(
      entry.paneId,
      entry.scope,
      'design_set_annotation_markers',
      { markers: [] },
    ).catch(() => {});
  }
  if (!canSend(entry.owner)) return;
  // The dying page cannot emit its own disable event, so the main
  // synthesizes the 'navigation' mode transition the renderer store already
  // understands — design bar and annotation tray reset together.
  const navigationEvent: BrowserDesignEvent = {
    eventId: randomUUID(),
    generation: generation ?? randomUUID(),
    type: 'mode',
    at: Date.now(),
    mode: { active: false, reason: 'navigation' },
  };
  entry.owner.send(BROWSER_CHANNELS.designEvent, {
    paneId: entry.paneId,
    event: navigationEvent,
  });
}

function withEntry(
  paneId: string,
  scope: ProjectExecutionScope,
): BrowserEntry {
  const entry = browsers.get(browserKey(scope, paneId));
  if (!entry) throw new Error(`unknown browser pane: ${paneId}`);
  assertEntryScope(entry, scope);
  return entry;
}

function withOwnedEntry(
  owner: WebContents,
  scope: ProjectExecutionScope,
  paneId: string,
): BrowserEntry {
  const entry = withEntry(paneId, scope);
  assertOwner(entry, owner);
  return entry;
}

function setBrowserBounds(entry: BrowserEntry, bounds: BrowserPaneBounds): void {
  const visible =
    bounds.visible !== false && bounds.width >= 16 && bounds.height >= 16;
  entry.view.setVisible(visible);
  if (!visible) return;
  entry.view.setBounds({
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  });
}

function applyPendingBounds(entry: BrowserEntry): void {
  const key = browserKey(entry.scope, entry.paneId);
  const pending = pendingBoundsByKey.get(key);
  if (!pending) return;
  // Keep stashed bounds for the real owner if a stranger overwrote the slot.
  if (pending.owner !== entry.owner) return;
  pendingBoundsByKey.delete(key);
  setBrowserBounds(entry, pending.bounds);
}

export function destroyBrowser(
  paneId: string,
  scope: ProjectExecutionScope,
): void {
  const key = browserKey(scope, paneId);
  const entry = browsers.get(key);
  if (!entry) {
    pendingBoundsByKey.delete(key);
    return;
  }
  assertEntryScope(entry, scope);
  browsers.delete(key);
  pendingBoundsByKey.delete(key);
  // Notifies the renderer too (when the owner window survives the pane, e.g.
  // a workspace-scope change) so the design bar/tray don't go ghost.
  resetDesignPaneState(entry, key, { sameDocument: false });
  const win = liveOwnerWindow(entry.owner);
  try {
    win?.contentView.removeChildView(entry.view);
  } catch {
    // Already detached.
  }
  try {
    entry.view.webContents.close();
  } catch {
    // Already destroyed.
  }
  void entry.networkProxy.close();
}

export function destroyBrowsersFor(wc: WebContents): void {
  for (const entry of [...browsers.values()]) {
    if (entry.owner === wc) destroyBrowser(entry.paneId, entry.scope);
  }
}

export function getBrowserViewCount(): number {
  return browsers.size;
}

function browserEntryForWebContents(
  sender: WebContents,
): { key: string; entry: BrowserEntry } | null {
  const matches = [...browsers.entries()].filter(
    ([, entry]) => entry.view.webContents.id === sender.id,
  );
  if (matches.length !== 1) return null;
  const [key, entry] = matches[0];
  return { key, entry };
}

function requireDesignTarget(
  owner: WebContents,
  scope: ProjectExecutionScope,
  paneRef: string,
): {
  paneId: string;
  sessionId: string;
  missionId: string;
  contextRevision: string;
} {
  const info = getPaneAuthzInfoOwnedBy(owner, paneRef);
  if (
    !info?.sessionId ||
    !info.missionId ||
    !info.scope ||
    !sameProjectScope(scope, info.scope)
  ) {
    throw new Error(
      'design context can be sent only to a live mission agent in the same project checkout',
    );
  }
  const workflowService = getContextWorkflowService(scope);
  const stored = workflowService.getMissionWorkflow(info.missionId).contract;
  const contextRevision = stored?.contract.contextRevision;
  if (!contextRevision || info.contextRevision !== contextRevision) {
    throw new Error(
      'design target is not bound to the current frozen context revision',
    );
  }
  workflowService.assertMutationAllowed(
    info.missionId,
    'nexus_design_context_send',
    { paneId: info.paneId },
  );
  return {
    paneId: info.paneId,
    sessionId: info.sessionId,
    missionId: info.missionId,
    contextRevision,
  };
}

type DesignTarget = ReturnType<typeof requireDesignTarget>;

/** Best-effort DESIGN.md: never fail a design send because the workspace has
 * no (or an unreadable) design system — shared by both send paths. */
function readDesignSystemBestEffort(
  scope: ProjectExecutionScope,
  dir?: string,
): string | undefined {
  try {
    return readWorkspaceDesignSystem(resolveCwdForScope(scope, dir)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Authority-re-checking PTY injector shared by the selection and annotation
 * send paths. This is a security guard — the target's session/mission/context
 * revision is re-validated at inject time so a mid-send authority swap aborts
 * instead of delivering the prompt to the wrong agent. ONE implementation:
 * a hardening fix here reaches both paths.
 */
function designTargetInjector(
  sender: WebContents,
  scope: ProjectExecutionScope,
  target: DesignTarget,
): (sessionId: string, prompt: string) => Promise<void> {
  return async (sessionId, prompt) => {
    requireLiveRendererWorkspaceScope(sender, scope);
    const liveTarget = requireDesignTarget(sender, scope, target.paneId);
    if (
      liveTarget.sessionId !== sessionId ||
      liveTarget.missionId !== target.missionId ||
      liveTarget.contextRevision !== target.contextRevision
    ) {
      throw new Error('design target authority changed');
    }
    await injectPastedPrompt(sessionId, prompt);
  };
}

export function registerBrowserIpc(runtimeManager: ProjectRuntimeManager): void {
  browserRuntimeManager = runtimeManager;
  unsubscribeBrowserScopeChanges?.();
  unsubscribeBrowserScopeChanges = onRendererWorkspaceScopeChange(
    (owner, _previous, next) => {
      for (const entry of [...browsers.values()]) {
        if (entry.owner.id !== owner.id) continue;
        if (!next || !sameProjectScope(entry.scope, next)) {
          destroyBrowser(entry.paneId, entry.scope);
        }
      }
    },
  );
  registerBrowserAutomationResponseHandler();

  ipcMain.on(BROWSER_DESIGN_CHANNELS.event, (event, raw) => {
    const resolved = browserEntryForWebContents(event.sender);
    if (!resolved) return;
    ingestDesignEvent(resolved.key, raw, {
      owner: resolved.entry.owner,
      scope: resolved.entry.scope,
    });
  });

  onDesignEvent((key, designEvent) => {
    const entry = browsers.get(key);
    if (!entry || !canSend(entry.owner)) return;
    entry.owner.send(BROWSER_CHANNELS.designEvent, {
      paneId: entry.paneId,
      event: designEvent,
    });
  });

  ipcMain.handle(BROWSER_CHANNELS.deviceEmulation, async (event, raw) => {
    const parsed = z
      .object({
        paneId: z.string().min(1).max(128),
        width: z.number().int().min(240).max(4096).nullable(),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw new Error('invalid device emulation payload');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const entry = withOwnedEntry(event.sender, scope, parsed.data.paneId);
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) throw new Error('browser pane is unavailable');
    const key = browserKey(scope, parsed.data.paneId);
    const width = parsed.data.width;
    const emulate = width !== null && width <= MOBILE_EMULATION_MAX_WIDTH;
    if (emulate) {
      // Guarda o UA original UMA vez por pane para restaurar no desligamento.
      if (!originalUserAgents.has(key)) {
        originalUserAgents.set(key, wc.getUserAgent());
      }
      wc.setUserAgent(MOBILE_EMULATION_USER_AGENT);
      wc.enableDeviceEmulation({
        screenPosition: 'mobile',
        screenSize: { width, height: MOBILE_EMULATION_HEIGHT },
        viewPosition: { x: 0, y: 0 },
        viewSize: { width, height: MOBILE_EMULATION_HEIGHT },
        deviceScaleFactor: 0,
        scale: 1,
      });
    } else {
      wc.disableDeviceEmulation();
      const original = originalUserAgents.get(key);
      if (original) {
        wc.setUserAgent(original);
        originalUserAgents.delete(key);
      }
    }
    // UA só vale a partir da próxima navegação — o reload faz o site servir o
    // layout certo (menu hambúrguer, media queries, etc.) imediatamente.
    wc.reload();
    return { paneId: parsed.data.paneId, emulating: emulate };
  });

  ipcMain.handle(BROWSER_CHANNELS.designMode, async (event, raw) => {
    const parsed = designModeSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid design mode payload');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    return setBrowserDesignMode(
      parsed.data.paneId,
      scope,
      parsed.data.active,
    );
  });

  ipcMain.handle(BROWSER_CHANNELS.designSend, async (event, raw) => {
    const parsed = designSendSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid design send payload');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const source = withOwnedEntry(event.sender, scope, parsed.data.paneId);
    const sourceKey = browserKey(scope, parsed.data.paneId);
    const target = requireDesignTarget(
      event.sender,
      scope,
      parsed.data.targetPaneId,
    );

    return sendDesignSelectionToAgent(
      {
        paneId: sourceKey,
        targetPaneRef: target.paneId,
        instruction: parsed.data.instruction,
        dir: parsed.data.dir,
        styleDiff: parsed.data.styleDiff,
        intent: parsed.data.intent,
        dryRun: parsed.data.dryRun,
        designSystem: readDesignSystemBestEffort(scope, parsed.data.dir),
      },
      {
        getSelection: getLastSelection,
        getSelections,
        findPane: () => ({
          paneId: target.paneId,
          sessionId: target.sessionId,
        }),
        workspaceRoot: (dir) => resolveCwdForScope(scope, dir),
        search: searchWorkspaceForSelection,
        capture: async (_key, clip) =>
          captureBrowserScreenshot(
            source.paneId,
            scope,
            target.missionId,
            { clip },
          ),
        inject: designTargetInjector(event.sender, scope, target),
      },
    );
  });

  ipcMain.handle(BROWSER_CHANNELS.designPreview, async (event, raw) => {
    const parsed = designPreviewSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid design preview payload');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    return setBrowserStylePreview(
      parsed.data.paneId,
      scope,
      parsed.data.selector,
      parsed.data.styles,
    );
  });

  ipcMain.handle(BROWSER_CHANNELS.designPreviewClear, async (event, raw) => {
    const parsed = designPreviewClearSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid design preview clear payload');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    return clearBrowserStylePreview(
      parsed.data.paneId,
      scope,
      parsed.data.selector,
    );
  });

  ipcMain.handle(BROWSER_CHANNELS.designAnnotate, async (event, raw) => {
    const parsed = designAnnotateSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid design annotate payload');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    const key = browserKey(scope, parsed.data.paneId);
    addDesignAnnotation(key, {
      comment: parsed.data.comment,
      intent: parsed.data.intent,
      ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
    });
    queueDesignAnnotationMarkerSync(parsed.data.paneId, scope);
    return {
      paneId: parsed.data.paneId,
      annotations: getDesignAnnotationSummaries(key),
    };
  });

  ipcMain.handle(BROWSER_CHANNELS.designAnnotations, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid design annotations payload');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    return {
      paneId: parsed.data.paneId,
      annotations: getDesignAnnotationSummaries(
        browserKey(scope, parsed.data.paneId),
      ),
    };
  });

  ipcMain.handle(BROWSER_CHANNELS.designAnnotationDelete, async (event, raw) => {
    const parsed = designAnnotationDeleteSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('invalid design annotation delete payload');
    }
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    const key = browserKey(scope, parsed.data.paneId);
    if (!deleteDesignAnnotation(key, parsed.data.annotationId)) {
      throw new Error('unknown design annotation');
    }
    queueDesignAnnotationMarkerSync(parsed.data.paneId, scope);
    return {
      paneId: parsed.data.paneId,
      annotations: getDesignAnnotationSummaries(key),
    };
  });

  ipcMain.handle(BROWSER_CHANNELS.designAnnotationsClear, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('invalid design annotations clear payload');
    }
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    const key = browserKey(scope, parsed.data.paneId);
    clearDesignAnnotations(key);
    queueDesignAnnotationMarkerSync(parsed.data.paneId, scope);
    return {
      paneId: parsed.data.paneId,
      annotations: getDesignAnnotationSummaries(key),
    };
  });

  ipcMain.handle(BROWSER_CHANNELS.designAnnotationsSend, async (event, raw) => {
    const parsed = designAnnotationsSendSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('invalid design annotations send payload');
    }
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    withOwnedEntry(event.sender, scope, parsed.data.paneId);
    const sourceKey = browserKey(scope, parsed.data.paneId);
    // A dry run (clipboard copy) injects nothing: it must work without any
    // live mission agent — skip the target authorization entirely.
    if (parsed.data.dryRun) {
      return sendDesignAnnotationsToAgent(
        {
          paneId: sourceKey,
          dryRun: true,
          designSystem: readDesignSystemBestEffort(scope, parsed.data.dir),
        },
        {
          getAnnotations: getDesignAnnotations,
          findPane: () => null,
          inject: async () => {
            throw new Error('dry run never injects');
          },
        },
      );
    }
    if (!parsed.data.targetPaneId) {
      throw new Error('design annotations send requires a target pane');
    }
    const target = requireDesignTarget(
      event.sender,
      scope,
      parsed.data.targetPaneId,
    );
    return sendDesignAnnotationsToAgent(
      {
        paneId: sourceKey,
        targetPaneRef: target.paneId,
        designSystem: readDesignSystemBestEffort(scope, parsed.data.dir),
      },
      {
        getAnnotations: getDesignAnnotations,
        findPane: () => ({
          paneId: target.paneId,
          sessionId: target.sessionId,
        }),
        inject: designTargetInjector(event.sender, scope, target),
      },
    );
  });

  ipcMain.handle(BROWSER_CHANNELS.create, async (event: IpcMainInvokeEvent, raw) => {
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser create payload');
    return ensureBrowser(
      event.sender,
      requireRendererWorkspaceScope(event.sender),
      parsed.data.paneId,
      parsed.data.url,
    );
  });

  ipcMain.on(BROWSER_CHANNELS.bounds, (event, raw) => {
    const parsed = boundsSchema.safeParse(raw);
    if (!parsed.success) return;
    try {
      const scope = requireRendererWorkspaceScope(event.sender);
      const key = browserKey(scope, parsed.data.paneId);
      const entry = browsers.get(key);
      if (!entry) {
        // Only stash while create is in flight for this key (avoids unbounded map).
        if (!browserCreations.has(key)) return;
        const existingPending = pendingBoundsByKey.get(key);
        if (existingPending && existingPending.owner !== event.sender) return;
        pendingBoundsByKey.set(key, {
          bounds: parsed.data.bounds,
          owner: event.sender,
        });
        return;
      }
      assertOwner(entry, event.sender);
      assertEntryScope(entry, scope);
      pendingBoundsByKey.delete(key);
      setBrowserBounds(entry, parsed.data.bounds);
    } catch {
      // Ignore stale or cross-window geometry updates.
    }
  });

  ipcMain.on(BROWSER_CHANNELS.destroy, (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) return;
    try {
      const scope = requireRendererWorkspaceScope(event.sender);
      withOwnedEntry(event.sender, scope, parsed.data.paneId);
      destroyBrowser(parsed.data.paneId, scope);
    } catch {
      // Ignore stale or cross-window destroy requests.
    }
  });

  ipcMain.handle(BROWSER_CHANNELS.load, async (event, raw) => {
    const parsed = loadSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser load payload');
    const scope = requireRendererWorkspaceScope(event.sender);
    return loadBrowserWithUserConfirmation(
      parsed.data.paneId,
      withOwnedEntry(event.sender, scope, parsed.data.paneId),
      parsed.data.url,
    );
  });

  ipcMain.handle(BROWSER_CHANNELS.back, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser back payload');
    const entry = withOwnedEntry(
      event.sender,
      requireRendererWorkspaceScope(event.sender),
      parsed.data.paneId,
    );
    if (entry.view.webContents.canGoBack()) entry.view.webContents.goBack();
    return stateOf(parsed.data.paneId, entry);
  });

  ipcMain.handle(BROWSER_CHANNELS.forward, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser forward payload');
    const entry = withOwnedEntry(
      event.sender,
      requireRendererWorkspaceScope(event.sender),
      parsed.data.paneId,
    );
    if (entry.view.webContents.canGoForward()) entry.view.webContents.goForward();
    return stateOf(parsed.data.paneId, entry);
  });

  ipcMain.handle(BROWSER_CHANNELS.reload, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser reload payload');
    const entry = withOwnedEntry(
      event.sender,
      requireRendererWorkspaceScope(event.sender),
      parsed.data.paneId,
    );
    entry.view.webContents.reload();
    return stateOf(parsed.data.paneId, entry);
  });

  ipcMain.handle(BROWSER_CHANNELS.stop, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser stop payload');
    const entry = withOwnedEntry(
      event.sender,
      requireRendererWorkspaceScope(event.sender),
      parsed.data.paneId,
    );
    entry.view.webContents.stop();
    return stateOf(parsed.data.paneId, entry);
  });
}
