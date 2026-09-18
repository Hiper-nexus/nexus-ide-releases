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
  BrowserAfterState,
  BrowserAutomationCommand,
  BrowserChanged,
  BrowserCompactPageResult,
  BrowserElementDescriptor,
  BrowserErrorItem,
  BrowserErrorReport,
  BrowserExtractCandidates,
  BrowserExtractField,
  BrowserExtractResult,
  BrowserFindMatch,
  BrowserFindResult,
  BrowserJudgmentSkipped,
  BrowserPageJudgment,
  BrowserPageReadResult,
  BrowserViewport,
  BrowserWaitCondition,
} from '../../shared/browser-automation';
import { redactBrowserText, redactPageUrl } from '../../shared/browser-redaction';
import type { JevQuestion, JevResult } from '../jev/jev-client';
import { judge } from '../jev/jev-client';
import { hasJevCredential } from '../jev/jev-secrets';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import { USD_PER_INPUT_TOKEN } from '../jev/jev-pricing';
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
  browserExtractCandidatesSchema,
  browserFillResultSchema,
  browserFindResultSchema,
  browserHoverResultSchema,
  browserPageReadResultSchema,
  browserPressResultSchema,
  browserScrollResultSchema,
  browserWaitResultSchema,
} from './browser-automation-schema';
import { renderBrowserOutline } from './browser-outline';
import {
  resolveBrowserExtract,
  type BrowserExtractDeps,
} from './browser-extract';
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
  /** Exact main-owned URL fence for an automated read-only design review. */
  exactNavigationLock?: string;
  restoringExactNavigation: boolean;
  allowedPrivateTargets: Map<string, Set<string>>;
  resolveHostname: BrowserAddressResolver;
  networkProxy: PinnedBrowserProxy;
  // Main-frame navigation sequence counters. navSeq increments on every
  // did-start-navigation for the main frame; the last*Seq fields remember
  // which seq the corresponding completion event belonged to so actions can
  // report whether they triggered a real or in-page navigation.
  navSeq: number;
  lastNewDocNavSeq: number;
  lastInPageNavSeq: number;
  /** Bounded ring of console/HTTP/load failures (≤ 20), newest last. */
  errors: TrackedBrowserError[];
  /** Monotonic counter stamped on each pushed error. */
  errorSeq: number;
  /** seq of the last action start — `read` reports errors after this point. */
  errorWindowStart: number;
}

interface TrackedBrowserError extends BrowserErrorItem {
  seq: number;
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
// Emulação de device do preview responsivo (paridade 1.3.3: mobile E tablet):
// breakpoint ≤480 = iPhone; 481–1024 = iPad. UA + métricas trocam para o site
// servir o layout REAL do dispositivo (não só a largura estreitada).
const MOBILE_EMULATION_MAX_WIDTH = 480;
const MOBILE_EMULATION_HEIGHT = 844;
const MOBILE_EMULATION_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const TABLET_EMULATION_MAX_WIDTH = 1024;
const TABLET_EMULATION_HEIGHT = 1366;
const TABLET_EMULATION_USER_AGENT =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const originalUserAgents = new Map<string, string>();
const BROWSER_DESTROY_PROOF_TIMEOUT_MS = 2_000;
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
  authority: {
    readonly signal?: AbortSignal;
    readonly assertCurrentAuthority?: () => void;
  } = {},
): Promise<string> {
  const assertCurrentAuthority = (): void => {
    authority.assertCurrentAuthority?.();
    if (authority.signal?.aborted) {
      throw new Error('session_authority_revoked');
    }
  };
  assertCurrentAuthority();
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
  assertCurrentAuthority();
  const needsPrivateConfirmation = decision.allowed
    ? !allowedTargetMatchesPins(decision, existingPins)
    : decision.kind === 'private-network';
  if (needsPrivateConfirmation && privateAccessConfirmed) {
    decision = await assess(true);
    assertCurrentAuthority();
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

function exactNavigationAllowed(entry: BrowserEntry, rawUrl: string): boolean {
  if (!entry.exactNavigationLock) return true;
  try {
    return (
      normalizeBrowserUrl(rawUrl, { allowAboutBlank: true }) ===
      entry.exactNavigationLock
    );
  } catch {
    return false;
  }
}

function reportBlockedExactNavigation(
  paneId: string,
  entry: BrowserEntry,
  rawUrl: string,
  restore: boolean,
): void {
  entry.error =
    `automated design-review navigation blocked: ${safeTargetLabel(rawUrl)}`;
  emitState(entry);
  if (
    !restore ||
    !entry.exactNavigationLock ||
    entry.restoringExactNavigation
  ) {
    return;
  }
  entry.restoringExactNavigation = true;
  void loadBrowserForEntry(paneId, entry, entry.exactNavigationLock)
    .catch((error) => {
      entry.error =
        `automated design-review preview restore failed: ` +
        `${error instanceof Error ? error.message : String(error)}`;
      emitState(entry);
    })
    .finally(() => {
      entry.restoringExactNavigation = false;
    });
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
    restoringExactNavigation: false,
    navSeq: 0,
    lastNewDocNavSeq: 0,
    lastInPageNavSeq: 0,
    errors: [],
    errorSeq: 0,
    errorWindowStart: 0,
  };
  const key = browserKey(scope, paneId);
  browsers.set(key, entry);
  win.contentView.addChildView(view);
  configureSessionSecurity(entry);

  const wc = view.webContents;
  // Keep WebRTC from opening direct UDP sockets around the session proxy.
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setWindowOpenHandler(({ url }) => {
    if (entry.exactNavigationLock) {
      if (!exactNavigationAllowed(entry, url)) {
        reportBlockedExactNavigation(paneId, entry, url, false);
      }
      return { action: 'deny' };
    }
    void loadBrowserForEntry(paneId, entry, url).catch((err) => {
      entry.error = err instanceof Error ? err.message : String(err);
      emitState(entry);
    });
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (
      !isSyntacticallySafeNavigation(url) ||
      !exactNavigationAllowed(entry, url)
    ) {
      event.preventDefault();
      if (!exactNavigationAllowed(entry, url)) {
        reportBlockedExactNavigation(paneId, entry, url, false);
      }
    }
  });
  wc.on('will-redirect', (event, url) => {
    if (
      !isSyntacticallySafeNavigation(url) ||
      !exactNavigationAllowed(entry, url)
    ) {
      event.preventDefault();
      if (!exactNavigationAllowed(entry, url)) {
        reportBlockedExactNavigation(paneId, entry, url, false);
      }
    }
  });
  wc.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      entry.navSeq += 1;
    }
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
    entry.lastNewDocNavSeq = entry.navSeq;
    if (!exactNavigationAllowed(entry, url)) {
      reportBlockedExactNavigation(paneId, entry, url, true);
      return;
    }
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
    entry.lastInPageNavSeq = entry.navSeq;
    if (!exactNavigationAllowed(entry, url)) {
      reportBlockedExactNavigation(paneId, entry, url, true);
      return;
    }
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
    pushBrowserError(entry, {
      kind: 'load',
      message: `${code} ${desc}`,
      urlPath: url ? redactPageUrl(url) : undefined,
    });
    emitState(entry);
  });
  // Page error telemetry for the per-action `errors` report. The ring is
  // bounded and redacted; it feeds only MCP results, never the page itself.
  // Electron ≥36 emits console-message as (event, messageDetails); the
  // legacy positional (level, message, line, sourceId) is still tolerated.
  wc.on('console-message', (...args: unknown[]) => {
    let level: unknown;
    let message: unknown;
    const details =
      args[1] && typeof args[1] === 'object' && 'message' in args[1]
        ? (args[1] as { level?: unknown; message?: unknown })
        : args[0] && typeof args[0] === 'object' && 'message' in args[0]
          ? (args[0] as { level?: unknown; message?: unknown })
          : null;
    if (details) {
      level = details.level;
      message = details.message;
    } else {
      // Legacy positional signature: (event, level, message, line, sourceId).
      level = args[1];
      message = args[2];
    }
    const isError =
      level === 'error' || (typeof level === 'number' && level >= 3);
    if (!isError || typeof message !== 'string' || !message) return;
    pushBrowserError(entry, { kind: 'console', message });
  });
  wc.session.webRequest.onCompleted((details) => {
    if (details.webContentsId !== wc.id || details.statusCode < 400) return;
    pushBrowserError(entry, {
      kind: 'http',
      message: `HTTP ${details.statusCode}`,
      status: details.statusCode,
      method: typeof details.method === 'string' ? details.method : undefined,
      urlPath: details.url ? redactPageUrl(details.url) : undefined,
    });
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
  options: {
    privateAccessConfirmed?: boolean;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
  } = {},
): Promise<BrowserPaneState> {
  const assertCurrentAuthority = (): void => {
    options.assertCurrentAuthority?.();
    if (options.signal?.aborted) {
      throw new Error('session_authority_revoked');
    }
  };
  assertCurrentAuthority();
  const url = await prepareNavigation(
    entry,
    rawUrl,
    options.privateAccessConfirmed === true,
    options,
  );
  if (!exactNavigationAllowed(entry, url)) {
    throw new Error(
      'automated design-review browser is locked to another local preview URL',
    );
  }
  assertCurrentAuthority();
  entry.url = url;
  entry.error = undefined;
  assertCurrentAuthority();
  if (url === 'about:blank') {
    entry.view.webContents.loadURL(url).catch(() => {});
  } else {
    await entry.view.webContents.loadURL(url);
    assertCurrentAuthority();
  }
  return stateOf(paneId, entry);
}

export async function loadBrowser(
  paneId: string,
  rawUrl: string,
  options: {
    scope: ProjectExecutionScope;
    privateAccessConfirmed?: boolean;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
    read?: BrowserInlineRead;
    judge?: boolean;
    sessionId?: string;
    missionId?: string;
    deps?: BrowserActionDeps;
  },
): Promise<
  BrowserPaneState & {
    after: BrowserAfterState;
    changed: BrowserChanged;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
    page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
  }
> {
  const entry = withEntry(paneId, options.scope);
  const before = snapshotBrowserBefore(entry);
  const state = await loadBrowserForEntry(
    paneId,
    entry,
    rawUrl,
    options,
  );
  const settled = await settleAndDescribeAfter(entry, before);
  const errors = browserErrorsSince(entry, before.errorStartSeq);
  const out = {
    ...state,
    url: redactBrowserUrl(state.url),
    title: redactBrowserLabel(state.title),
    ...(state.error ? { error: redactBrowserLabel(state.error) } : {}),
    ...settled,
    errors,
  } as BrowserPaneState & {
    after: BrowserAfterState;
    changed: BrowserChanged;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
    page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
  };
  if (options.read !== undefined && options.read !== false) {
    out.page = await inlinePageRead(paneId, options.scope, options.read);
  }
  if (options.judge === true) {
    const readForJudge: BrowserPageReadResult =
      out.page && 'bodyText' in out.page
        ? out.page
        : await readBrowserPage(paneId, options.scope, {
            maxChars: 4_000,
            maxElements: 60,
          });
    const verdict = await judgeBrowserPage(readForJudge, errors, {
      sessionId: options.sessionId,
      missionId: options.missionId,
      ...(options.deps ? { deps: options.deps } : {}),
    });
    out.judgment = verdict.judgment;
    if (verdict.judgmentSkipped) out.judgmentSkipped = verdict.judgmentSkipped;
  }
  return out;
}

export function lockBrowserToExactUrl(
  paneId: string,
  scope: ProjectExecutionScope,
  rawUrl: string,
): void {
  const entry = withEntry(paneId, scope);
  const exactUrl = normalizeBrowserUrl(rawUrl);
  const currentUrl = entry.view.webContents.getURL() || entry.url;
  if (currentUrl !== exactUrl) {
    throw new Error(
      'automated design-review browser is not at its approved local preview URL',
    );
  }
  entry.exactNavigationLock = exactUrl;
}

export function assertBrowserAtExactUrl(
  paneId: string,
  scope: ProjectExecutionScope,
  rawUrl: string,
): void {
  const entry = withEntry(paneId, scope);
  const expected = normalizeBrowserUrl(rawUrl);
  const current = entry.view.webContents.getURL() || entry.url;
  if (
    entry.exactNavigationLock !== expected ||
    current !== expected ||
    entry.error
  ) {
    throw new Error(
      'automated design-review browser left its approved local preview URL',
    );
  }
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
  options: {
    clip?: BrowserDesignRect;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
  } = {},
): Promise<BrowserScreenshotResult> {
  const assertCurrentAuthority = (): void => {
    options.assertCurrentAuthority?.();
    if (options.signal?.aborted) {
      throw new Error('session_authority_revoked');
    }
  };
  assertCurrentAuthority();
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
  assertCurrentAuthority();
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    throw new Error('browser screenshot is empty; the pane may not be visible yet');
  }

  assertCurrentAuthority();
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

const NAV_SETTLE_MS = 3_000;
const AFTER_GRACE_MS = 150;

interface BrowserBeforeState {
  url: string;
  title: string;
  navSeq: number;
  errorStartSeq: number;
}

const BROWSER_ERROR_RING_MAX = 20;
const BROWSER_ERROR_MESSAGE_CHARS = 200;

function pushBrowserError(
  entry: BrowserEntry,
  item: Omit<BrowserErrorItem, 'at'>,
): void {
  entry.errorSeq += 1;
  entry.errors.push({
    ...item,
    at: Date.now(),
    seq: entry.errorSeq,
    message: redactBrowserText(item.message).slice(
      0,
      BROWSER_ERROR_MESSAGE_CHARS,
    ),
  });
  while (entry.errors.length > BROWSER_ERROR_RING_MAX) {
    entry.errors.shift();
  }
}

function browserErrorsSince(
  entry: BrowserEntry,
  startSeq: number,
): BrowserErrorReport {
  const since = entry.errors.filter((item) => item.seq > startSeq);
  return {
    consoleErrors: since.filter((item) => item.kind === 'console').length,
    httpErrors: since.filter((item) => item.kind === 'http').length,
    loadErrors: since.filter((item) => item.kind === 'load').length,
    items: since.slice(-5).map(({ seq: _seq, ...rest }) => rest),
  };
}

function snapshotBrowserBefore(entry: BrowserEntry): BrowserBeforeState {
  const wc = entry.view.webContents;
  // Each action starts a fresh error window; `read` reports the window that
  // the last action left behind without resetting it.
  entry.errorWindowStart = entry.errorSeq;
  return {
    url: redactPageUrl(wc.getURL() || entry.url),
    title: redactBrowserText(wc.getTitle() || entry.title).slice(0, 512),
    navSeq: entry.navSeq,
    errorStartSeq: entry.errorSeq,
  };
}

/**
 * Post-action settle + snapshot. If a main-frame navigation started at/after
 * the action (navSeq advanced), waits for did-stop-loading with a cap;
 * otherwise waits a short grace for same-document DOM updates. Everything
 * returned is redacted exactly like a page-side read.
 */
async function settleAndDescribeAfter(
  entry: BrowserEntry,
  before: BrowserBeforeState,
  opts: { settleMs?: number } = {},
): Promise<{ after: BrowserAfterState; changed: BrowserChanged }> {
  const wc = entry.view.webContents;
  if (entry.navSeq > before.navSeq) {
    if (entry.loading) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, opts.settleMs ?? NAV_SETTLE_MS);
        function done(): void {
          clearTimeout(timer);
          wc.removeListener('did-stop-loading', onStop);
          wc.removeListener('did-fail-load', onStop);
          resolve();
        }
        function onStop(): void {
          done();
        }
        wc.once('did-stop-loading', onStop);
        wc.once('did-fail-load', onStop);
      });
    }
  } else {
    await new Promise((resolve) => setTimeout(resolve, opts.settleMs ?? AFTER_GRACE_MS));
  }
  const after: BrowserAfterState = {
    url: redactPageUrl(wc.getURL() || entry.url),
    title: redactBrowserText(wc.getTitle() || entry.title).slice(0, 512),
    loading: entry.loading,
  };
  const changed: BrowserChanged = {
    url: after.url !== before.url,
    title: after.title !== before.title,
    navigated:
      entry.lastNewDocNavSeq > before.navSeq
        ? 'new-document'
        : entry.lastInPageNavSeq > before.navSeq
          ? 'same-document'
          : 'none',
  };
  return { after, changed };
}

/** `read` option accepted by every mutating browser tool. */
export type BrowserInlineRead =
  | boolean
  | { maxChars?: number; maxElements?: number; format?: 'json' | 'compact' };

export interface BrowserActionOptions {
  read?: BrowserInlineRead;
  /** `judge: true` attaches a Jev page judgment (fail-open, never blocks). */
  judge?: boolean;
  sessionId?: string;
  missionId?: string;
  /** Test seam for find/judge injection. */
  deps?: BrowserActionDeps;
}

export interface BrowserActionDeps {
  find?: typeof findBrowserElements;
  jev?: typeof judge;
  jevEnabled?: () => boolean;
  jevReady?: () => boolean;
  recordDecision?: typeof recordJevDecision;
}

async function inlinePageRead(
  paneId: string,
  scope: ProjectExecutionScope,
  read: BrowserInlineRead,
): Promise<
  (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string }
> {
  const opts = typeof read === 'object' ? read : {};
  if (opts.format === 'compact') {
    return readBrowserPageCompact(paneId, scope, {
      ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      ...(opts.maxElements !== undefined ? { maxElements: opts.maxElements } : {}),
    });
  }
  return readBrowserPage(paneId, scope, {
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
    ...(opts.maxElements !== undefined ? { maxElements: opts.maxElements } : {}),
  });
}

const BROWSER_JUDGE_TIMEOUT_MS = 4_000;

/**
 * §8 Jev page judgment (opt-in): three nouls + a page-kind choice over
 * already-redacted read data. Fail-open: off, missing credential, timeout or
 * error → `judgment: null` + `judgmentSkipped`; the action result is never
 * blocked on Jev.
 */
async function judgeBrowserPage(
  read: BrowserPageReadResult,
  errors: BrowserErrorReport,
  options?: BrowserActionOptions,
): Promise<
  | { judgment: BrowserPageJudgment; judgmentSkipped?: never }
  | { judgment: null; judgmentSkipped: BrowserJudgmentSkipped }
> {
  const deps = options?.deps;
  const jevEnabled =
    deps?.jevEnabled ?? (() => isJevSurfaceEnabled('browserTool'));
  const jevReady = deps?.jevReady ?? hasJevCredential;
  if (!jevEnabled()) return { judgment: null, judgmentSkipped: 'surface-disabled' };
  if (!jevReady()) return { judgment: null, judgmentSkipped: 'no-credential' };
  try {
    const judgeFn = deps?.jev ?? judge;
    const questions: Record<string, JevQuestion> = {
      errorVisible: {
        type: 'noul',
        instructions:
          'A página mostra erro, falha de validação ou estado quebrado ' +
          'para o usuário?',
      },
      blockedByHuman: {
        type: 'noul',
        instructions:
          'A página exige ação humana — login, captcha, consentimento, 2FA?',
      },
      stillLoading: {
        type: 'noul',
        instructions: 'O conteúdo principal ainda está carregando ou vazio?',
      },
      pageKind: {
        type: 'choice',
        instructions: 'Qual o tipo principal desta página?',
        criteria: {
          form: 'form',
          list: 'list',
          article: 'article',
          dashboard: 'dashboard',
          error: 'error',
          login: 'login',
          captcha: 'captcha',
          empty: 'empty',
          other: 'other',
        },
      },
    };
    const result: JevResult | null = await judgeFn({
      state: {
        url: read.url,
        title: read.title,
        headings: read.headings.slice(0, 10).map((h) => h.text),
        excerpt: read.bodyText.slice(0, 2_000),
        alerts: read.alerts.slice(0, 5),
        errors: {
          consoleErrors: errors.consoleErrors,
          httpErrors: errors.httpErrors,
          loadErrors: errors.loadErrors,
        },
      },
      questions,
      timeoutMs: BROWSER_JUDGE_TIMEOUT_MS,
      surface: 'browserTool',
      sessionId: options?.sessionId,
      missionId: options?.missionId,
    });
    if (!result) {
      return { judgment: null, judgmentSkipped: 'judge-unavailable' };
    }
    const noul = (key: string): number => {
      const answer = result.answers[key];
      return answer && answer.type === 'noul' ? answer.noul : 0;
    };
    const kind = result.answers['pageKind'];
    const record = deps?.recordDecision ?? recordJevDecision;
    record({
      surface: 'browserTool',
      sessionId: options?.sessionId,
      missionId: options?.missionId,
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: kind && kind.type === 'choice' ? kind.choice : 'other',
      inputTokens: result.usage.input_tokens,
      usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
    });
    return {
      judgment: {
        errorVisible: noul('errorVisible'),
        blockedByHuman: noul('blockedByHuman'),
        stillLoading: noul('stillLoading'),
        pageKind:
          kind && kind.type === 'choice'
            ? { choice: kind.choice, confidence: kind.confidence }
            : { choice: 'other', confidence: 0 },
        model: result.model,
      },
    };
  } catch {
    return { judgment: null, judgmentSkipped: 'judge-unavailable' };
  }
}

async function attachAfterAndMaybePage<R extends Record<string, unknown>>(
  entry: BrowserEntry,
  before: BrowserBeforeState,
  result: R,
  options?: BrowserActionOptions,
): Promise<
  R & {
    after: BrowserAfterState;
    changed: BrowserChanged;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
    page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
  }
> {
  const { after, changed } = await settleAndDescribeAfter(entry, before);
  const errors = browserErrorsSince(entry, before.errorStartSeq);
  const out = { ...result, after, changed, errors } as R & {
    after: BrowserAfterState;
    changed: BrowserChanged;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
    page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
  };
  if (options?.read !== undefined && options.read !== false) {
    out.page = await inlinePageRead(
      entry.paneId,
      entry.scope,
      options.read === true ? true : options.read,
    );
  }
  if (options?.judge === true) {
    const readForJudge: BrowserPageReadResult =
      out.page && 'bodyText' in out.page
        ? out.page
        : await readBrowserPage(entry.paneId, entry.scope, {
            maxChars: 4_000,
            maxElements: 60,
          });
    const verdict = await judgeBrowserPage(readForJudge, errors, options);
    out.judgment = verdict.judgment;
    if (verdict.judgmentSkipped) out.judgmentSkipped = verdict.judgmentSkipped;
  }
  return out;
}

export async function readBrowserPage(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    maxChars?: number;
    maxElements?: number;
    judge?: boolean;
    sessionId?: string;
    missionId?: string;
    deps?: BrowserActionDeps;
  } = {},
): Promise<
  BrowserPageReadResult & {
    paneId: string;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
  }
> {
  const result = browserPageReadResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'read', {
      ...(options.maxChars ? { maxChars: Math.min(options.maxChars, 20_000) } : {}),
      ...(options.maxElements
        ? { maxElements: Math.min(options.maxElements, 200) }
        : {}),
    }),
  );
  const entry = withEntry(paneId, scope);
  // `read` reports the error window left by the last action; it never resets.
  const errors = browserErrorsSince(entry, entry.errorWindowStart);
  const out = { paneId, ...result, errors } as BrowserPageReadResult & {
    paneId: string;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
  };
  if (options.judge === true) {
    const verdict = await judgeBrowserPage(result, errors, {
      sessionId: options.sessionId,
      missionId: options.missionId,
      ...(options.deps ? { deps: options.deps } : {}),
    });
    out.judgment = verdict.judgment;
    if (verdict.judgmentSkipped) out.judgmentSkipped = verdict.judgmentSkipped;
  }
  return out;
}

/** `nexus_browser_read` with `format: 'compact'` — an LLM-shaped outline. */
export async function readBrowserPageCompact(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    maxChars?: number;
    maxElements?: number;
    judge?: boolean;
    sessionId?: string;
    missionId?: string;
    deps?: BrowserActionDeps;
  } = {},
): Promise<
  BrowserCompactPageResult & {
    paneId: string;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
  }
> {
  const result = await readBrowserPage(paneId, scope, options);
  return {
    paneId,
    url: result.url,
    title: result.title,
    outline: renderBrowserOutline(result),
    truncated: result.truncated,
    viewport: result.viewport,
    errors: result.errors,
    ...(result.judgment !== undefined ? { judgment: result.judgment } : {}),
    ...(result.judgmentSkipped
      ? { judgmentSkipped: result.judgmentSkipped }
      : {}),
  };
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

function hrefPathOnly(href: string): string {
  try {
    return new URL(href).pathname.slice(0, 200);
  } catch {
    return '';
  }
}

type TextResolution =
  | {
      ok: true;
      match: BrowserFindMatch;
      resolvedBy: 'text' | 'jev';
      confidence?: number;
    }
  | { ok: false; candidates: BrowserFindMatch[] };

/**
 * Main-side `click/fill` por nome acessível: score dos candidatos no lado da
 * página (o texto nunca vira seletor), age num vencedor claro, deixa o Jev
 * desempatar só quando ambíguo (2–5 candidatos, confiança ≥ 0.7) e, no
 * resto, devolve os candidatos sem agir. Fail-open: erro → candidatos.
 */
async function resolveBrowserElementByText(
  entry: BrowserEntry,
  scope: ProjectExecutionScope,
  text: string,
  options?: BrowserActionOptions,
  role?: string,
): Promise<TextResolution> {
  const deps = options?.deps;
  const find = deps?.find ?? findBrowserElements;
  const { matches } = await find(entry.paneId, scope, {
    text,
    limit: 25,
    ...(role ? { role } : {}),
  });
  if (matches.length === 0) {
    throw new Error(`nenhum elemento visível combina com "${text}"`);
  }
  const top = matches[0];
  const second = matches[1];
  if (
    (matches.length === 1 && top.score >= 0.75) ||
    (top.score >= 0.9 && (second?.score ?? 0) < 0.6)
  ) {
    return { ok: true, match: top, resolvedBy: 'text' };
  }
  const candidates = matches.slice(0, 5);
  const jevEnabled = deps?.jevEnabled ?? (() => isJevSurfaceEnabled('browserTool'));
  const jevReady = deps?.jevReady ?? hasJevCredential;
  if (candidates.length >= 2 && jevEnabled() && jevReady()) {
    try {
      const judgeFn = deps?.jev ?? judge;
      const criteria: Record<string, string | null> = {};
      for (const c of candidates) {
        const path = c.href ? hrefPathOnly(c.href) : '';
        criteria[c.ref] =
          `${c.role} "${c.name}"${path ? ` → ${path}` : ''}`.slice(0, 256);
      }
      criteria['none'] = 'nenhum corresponde';
      const questions: Record<string, JevQuestion> = {
        element: {
          type: 'choice',
          instructions:
            'Which element best matches the user intent text on this page? ' +
            'Pick none if no candidate corresponds.',
          criteria,
        },
      };
      const wc = entry.view.webContents;
      const state = {
        intent: redactBrowserText(text).slice(0, 200),
        pageTitle: redactBrowserText(wc.getTitle() || entry.title).slice(0, 256),
        url: redactPageUrl(wc.getURL() || entry.url),
      };
      const result: JevResult | null = await judgeFn({
        state,
        questions,
        surface: 'browserTool',
        sessionId: options?.sessionId,
        missionId: options?.missionId,
      });
      const answer = result?.answers['element'];
      if (result && answer && answer.type === 'choice') {
        const record = deps?.recordDecision ?? recordJevDecision;
        record({
          surface: 'browserTool',
          sessionId: options?.sessionId,
          missionId: options?.missionId,
          model: result.model,
          questions: Object.keys(questions),
          probabilities: jevAnswerProbabilities(result.answers),
          confidence: jevAnswerConfidences(result.answers),
          decision: answer.choice,
          inputTokens: result.usage.input_tokens,
          usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
        });
        if (answer.confidence >= 0.7 && answer.choice !== 'none') {
          const chosen = candidates.find((c) => c.ref === answer.choice);
          if (chosen) {
            return {
              ok: true,
              match: chosen,
              resolvedBy: 'jev',
              confidence: answer.confidence,
            };
          }
        }
      }
    } catch {
      // fail-open
    }
  }
  return { ok: false, candidates };
}

export async function findBrowserElements(
  paneId: string,
  scope: ProjectExecutionScope,
  options: { text?: string; role?: string; limit?: number } = {},
): Promise<BrowserFindResult & { paneId: string }> {
  const result = browserFindResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'find', {
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(options.role !== undefined ? { role: options.role } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }),
  );
  return { paneId, ...result };
}

/**
 * `nexus_browser_extract` (§9): the page lists bounded candidates; the code
 * scores them and Jev only picks among real candidates (or answers
 * boolean/enum questions). Jev never invents a value.
 */
export async function extractBrowserFields(
  paneId: string,
  scope: ProjectExecutionScope,
  fields: BrowserExtractField[],
  options?: {
    sessionId?: string;
    missionId?: string;
    deps?: BrowserExtractDeps;
  },
): Promise<BrowserExtractResult & { paneId: string }> {
  const entry = withEntry(paneId, scope);
  const candidates: BrowserExtractCandidates =
    browserExtractCandidatesSchema.parse(
      await runBrowserAutomationForPane(
        paneId,
        scope,
        'extract_candidates',
        {},
      ),
    );
  const wc = entry.view.webContents;
  const context = {
    url: redactPageUrl(wc.getURL() || entry.url),
    title: redactBrowserText(wc.getTitle() || entry.title).slice(0, 512),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.missionId ? { missionId: options.missionId } : {}),
  };
  // Boolean/enum fields are judged over a text excerpt — read it lazily so
  // extraction of plain fields never pays for a second page read.
  if (fields.some((f) => f.type === 'boolean' || f.type === 'enum')) {
    const page = await readBrowserPage(paneId, scope, {
      maxChars: 2_000,
      maxElements: 1,
    });
    return finalizeExtract(paneId, candidates, fields, {
      ...context,
      url: page.url,
      title: page.title,
      excerpt: page.bodyText,
    }, options);
  }
  return finalizeExtract(paneId, candidates, fields, context, options);
}

async function finalizeExtract(
  paneId: string,
  candidates: BrowserExtractCandidates,
  fields: BrowserExtractField[],
  context: {
    url: string;
    title: string;
    excerpt?: string;
    sessionId?: string;
    missionId?: string;
  },
  options?: { deps?: BrowserExtractDeps },
): Promise<BrowserExtractResult & { paneId: string }> {
  const resolution = await resolveBrowserExtract(
    candidates,
    fields,
    context,
    options?.deps ?? {},
  );
  return {
    paneId,
    url: context.url,
    title: context.title,
    fields: resolution.fields,
    jev: resolution.jev,
  };
}

export type BrowserActionTarget = string | { text: string };

export interface BrowserClickResult {
  paneId: string;
  clicked: boolean;
  element?: BrowserElementDescriptor;
  resolvedBy?: 'ref' | 'text' | 'jev';
  confidence?: number;
  ambiguous?: boolean;
  candidates?: BrowserFindMatch[];
  after?: BrowserAfterState;
  changed?: BrowserChanged;
  errors?: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}

export async function clickBrowserElement(
  paneId: string,
  scope: ProjectExecutionScope,
  target: BrowserActionTarget,
  options?: BrowserActionOptions,
): Promise<BrowserClickResult> {
  const entry = withEntry(paneId, scope);
  let ref: string;
  let resolvedBy: 'ref' | 'text' | 'jev' = 'ref';
  let confidence: number | undefined;
  if (typeof target === 'string') {
    ref = target;
  } else {
    const resolution = await resolveBrowserElementByText(
      entry,
      scope,
      target.text,
      options,
    );
    if (!resolution.ok) {
      return {
        paneId,
        clicked: false,
        ambiguous: true,
        candidates: resolution.candidates,
      };
    }
    ref = resolution.match.ref;
    resolvedBy = resolution.resolvedBy;
    confidence = resolution.confidence;
  }
  const before = snapshotBrowserBefore(entry);
  const result = browserClickResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'click', { ref }),
  );
  return attachAfterAndMaybePage(
    entry,
    before,
    {
      paneId,
      clicked: true as const,
      element: result.element,
      resolvedBy,
      ...(confidence !== undefined ? { confidence } : {}),
    },
    options,
  );
}

export interface BrowserFillResult {
  paneId: string;
  filled: boolean;
  ref?: string;
  length?: number;
  element?: BrowserElementDescriptor;
  resolvedBy?: 'ref' | 'text' | 'jev';
  confidence?: number;
  ambiguous?: boolean;
  candidates?: BrowserFindMatch[];
  after?: BrowserAfterState;
  changed?: BrowserChanged;
  errors?: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}

export async function fillBrowserElement(
  paneId: string,
  scope: ProjectExecutionScope,
  target: BrowserActionTarget,
  text: string,
  options?: BrowserActionOptions,
): Promise<BrowserFillResult> {
  if (text.length > 2000) {
    throw new Error('fill text exceeds 2000 characters');
  }
  const entry = withEntry(paneId, scope);
  let ref: string;
  let resolvedBy: 'ref' | 'text' | 'jev' = 'ref';
  let confidence: number | undefined;
  let resolvedElement: BrowserElementDescriptor | undefined;
  if (typeof target === 'string') {
    ref = target;
  } else {
    const resolution = await resolveBrowserElementByText(
      entry,
      scope,
      target.text,
      options,
      'textbox',
    );
    if (!resolution.ok) {
      return {
        paneId,
        filled: false,
        ambiguous: true,
        candidates: resolution.candidates,
      };
    }
    ref = resolution.match.ref;
    resolvedBy = resolution.resolvedBy;
    confidence = resolution.confidence;
    resolvedElement = resolution.match;
  }
  const before = snapshotBrowserBefore(entry);
  const result = browserFillResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'fill', { ref, text }),
  );
  return attachAfterAndMaybePage(
    entry,
    before,
    {
      paneId,
      filled: true as const,
      ref: result.ref,
      length: result.length,
      ...(resolvedElement ? { element: resolvedElement } : {}),
      resolvedBy,
      ...(confidence !== undefined ? { confidence } : {}),
    },
    options,
  );
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
    read?: BrowserInlineRead;
    judge?: boolean;
    sessionId?: string;
    missionId?: string;
    deps?: BrowserActionDeps;
  },
): Promise<{
  paneId: string;
  scrolled: true;
  scrollX: number;
  scrollY: number;
  target: 'page' | 'element';
  atBottom: boolean;
  viewport: BrowserViewport;
  after: BrowserAfterState;
  changed: BrowserChanged;
  errors: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}> {
  const entry = withEntry(paneId, scope);
  const before = snapshotBrowserBefore(entry);
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
  return attachAfterAndMaybePage(
    entry,
    before,
    { paneId, ...result },
    options,
  );
}

export async function pressBrowserKey(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    key: string;
    ref?: string;
    modifiers?: readonly string[];
    read?: BrowserInlineRead;
    judge?: boolean;
    sessionId?: string;
    missionId?: string;
    deps?: BrowserActionDeps;
  },
): Promise<{
  paneId: string;
  pressed: true;
  key: string;
  ref?: string;
  after: BrowserAfterState;
  changed: BrowserChanged;
  errors: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}> {
  const entry = withEntry(paneId, scope);
  const before = snapshotBrowserBefore(entry);
  const result = browserPressResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'press', {
      key: options.key,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.modifiers && options.modifiers.length > 0
        ? { modifiers: options.modifiers }
        : {}),
    }),
  );
  return attachAfterAndMaybePage(
    entry,
    before,
    { paneId, ...result },
    options,
  );
}

export async function hoverBrowserElement(
  paneId: string,
  scope: ProjectExecutionScope,
  ref: string,
  options?: BrowserActionOptions,
): Promise<{
  paneId: string;
  hovered: true;
  element: BrowserElementDescriptor;
  after: BrowserAfterState;
  changed: BrowserChanged;
  errors: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}> {
  const entry = withEntry(paneId, scope);
  const before = snapshotBrowserBefore(entry);
  const result = browserHoverResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'hover', { ref }),
  );
  return attachAfterAndMaybePage(
    entry,
    before,
    { paneId, ...result },
    options,
  );
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

function detachBrowserEntry(
  paneId: string,
  scope: ProjectExecutionScope,
): BrowserEntry | null {
  const key = browserKey(scope, paneId);
  const entry = browsers.get(key);
  if (!entry) {
    pendingBoundsByKey.delete(key);
    return null;
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
  return entry;
}

export function destroyBrowser(
  paneId: string,
  scope: ProjectExecutionScope,
): void {
  const entry = detachBrowserEntry(paneId, scope);
  if (!entry) return;
  try {
    entry.view.webContents.close();
  } catch {
    // Already destroyed.
  }
  void entry.networkProxy.close();
}

function closeWebContentsWithProof(entry: BrowserEntry): Promise<void> {
  const webContents = entry.view.webContents;
  if (webContents.isDestroyed()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      webContents.removeListener('destroyed', onDestroyed);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDestroyed = () => settle();
    const timer = setTimeout(() => {
      if (webContents.isDestroyed()) {
        settle();
        return;
      }
      settle(
        new Error(
          `browser pane ${entry.paneId} WebContents did not terminate`,
        ),
      );
    }, BROWSER_DESTROY_PROOF_TIMEOUT_MS);
    timer.unref();
    webContents.once('destroyed', onDestroyed);
    try {
      webContents.close({ waitForBeforeUnload: false });
      if (webContents.isDestroyed()) settle();
    } catch (error) {
      settle(
        new Error(
          `browser pane ${entry.paneId} WebContents close failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

/**
 * Strong teardown used by privileged automated-review surfaces. Authority is
 * revoked from the runtime map first, then both the WebContents destruction
 * and pinned network-proxy shutdown are awaited and verified.
 */
export async function destroyBrowserWithProof(
  paneId: string,
  scope: ProjectExecutionScope,
): Promise<void> {
  const entry = detachBrowserEntry(paneId, scope);
  if (!entry) {
    throw new Error(
      `browser pane ${paneId} disappeared before physical exit proof`,
    );
  }
  const webContents = entry.view.webContents;
  const [webContentsResult, proxyResult] = await Promise.allSettled([
    closeWebContentsWithProof(entry),
    Promise.resolve().then(() => entry.networkProxy.close()),
  ]);
  const failures: string[] = [];
  if (webContentsResult.status === 'rejected') {
    failures.push(
      webContentsResult.reason instanceof Error
        ? webContentsResult.reason.message
        : String(webContentsResult.reason),
    );
  }
  if (!webContents.isDestroyed()) {
    failures.push(`browser pane ${paneId} WebContents remains alive`);
  }
  if (proxyResult.status === 'rejected') {
    failures.push(
      `browser pane ${paneId} network proxy close failed: ` +
        `${proxyResult.reason instanceof Error
          ? proxyResult.reason.message
          : String(proxyResult.reason)}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
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
    const tablet =
      width !== null &&
      width > MOBILE_EMULATION_MAX_WIDTH &&
      width <= TABLET_EMULATION_MAX_WIDTH;
    const emulate = width !== null && (width <= MOBILE_EMULATION_MAX_WIDTH || tablet);
    if (emulate) {
      // Guarda o UA original UMA vez por pane para restaurar no desligamento.
      if (!originalUserAgents.has(key)) {
        originalUserAgents.set(key, wc.getUserAgent());
      }
      wc.setUserAgent(
        tablet ? TABLET_EMULATION_USER_AGENT : MOBILE_EMULATION_USER_AGENT,
      );
      const emulatedHeight = tablet
        ? TABLET_EMULATION_HEIGHT
        : MOBILE_EMULATION_HEIGHT;
      wc.enableDeviceEmulation({
        screenPosition: 'mobile',
        screenSize: { width, height: emulatedHeight },
        viewPosition: { x: 0, y: 0 },
        viewSize: { width, height: emulatedHeight },
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
