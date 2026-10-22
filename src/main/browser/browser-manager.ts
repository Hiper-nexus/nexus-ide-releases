/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/desktop/src/preview/CdpRelay.ts.
 * Nexus changes: Only the scoped internal CDP factory references upstream preview access; exact
 * frozen scope/entry/window/WC session/document/profile and abort/current-authority guard revoke
 * internal leases. Personal and locked review profiles refuse. Production anonymous preview
 * bridge/transport removed; remaining browser manager is Nexus-authored.
 */
import { decisionResultUsage } from '../decision-models/decision-usage';
import {
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  nativeImage,
  session as electronSession,
} from 'electron';
import type { BrowserProfileStatus } from '../../shared/browser-profile';
import { browserProfileMode, changeBrowserProfile, connectPersonalProfile, getBrowserProfilePreferences, personalCookieProfile, rememberAgentBrowser } from './browser-personal-profile';
import { listImportProfiles, listImportSites, readBrowserImport } from './browser-import/browser-import';
import { isAgentRequestedBrowser } from '../orch/pane-registry';
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
  BrowserLayoutAudit,
  BrowserPageJudgment,
  BrowserPageReadResult,
  BrowserViewport,
  BrowserWaitCondition,
} from '../../shared/browser-automation';
import { redactBrowserText, redactPageUrl } from '../../shared/browser-redaction';
import type { JevQuestion, JevResult } from '../jev/jev-client';
import { judge } from '../jev/jev-client';
import { hasDecisionCredential, decisionConfigurationKey } from '../decision-models/decision-availability';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { JevResponseCache } from '../jev/jev-response-cache';
import { prepareBrowserFocus, resolveBrowserFocus, type BrowserContextSelection } from './browser-focused-context';
import type { judgeBrowserVisual } from './browser-visual-judgment';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
  recordJevOptimization,
} from '../jev/jev-decision-log';
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
  browserBlockedTargetHint,
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
  browserElementRectSchema,
  browserExtractCandidatesSchema,
  browserFillResultSchema,
  browserFindResultSchema,
  browserHoverResultSchema,
  browserInputConfirmSchema,
  browserInputPrepareSchema,
  browserLayoutAuditSchema,
  browserPageReadResultSchema,
  browserPressResultSchema,
  browserScrollResultSchema,
  browserSelectResultSchema,
  browserWaitResultSchema,
} from './browser-automation-schema';
import { renderBrowserOutline } from './browser-outline';
import {
  resolveBrowserExtract,
  type BrowserExtractDeps,
} from './browser-extract';
import {
  pickBrowserFindElement,
  type BrowserFindJevDeps,
} from './browser-find-jev';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceForgotten,
  onRendererWorkspaceScopeChange,
  requireLiveRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import { createScopedBrowserArtifactStore } from './browser-artifact-store';
import { browserVisualMasksSchema, maskBrowserBitmap } from './browser-capture-redaction';
import { assertInspectableBrowserDom } from './browser-visual-inspection';
import { attachCdpRelay } from './cdp-relay-attach';
import type { CdpRelayConnection } from './cdp-relay';
import { BrowserVisualRefusal } from './browser-visual-refusal';
import { validateDecisionImages } from '../decision-models/decision-images';
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
import { captureWithWakeRetry, clampScreenshotClip } from './screenshot-clip';
import {
  sendDesignAnnotationsToAgent,
  sendDesignSelectionToAgent,
} from '../orch/design-send';
import { readWorkspaceDesignSystem } from '../orch/design-system-reader';
import { searchWorkspaceForSelection } from '../orch/design-code-search';
import {
  forgetParkedBrowserPane,
  getDevServerForPane,
  getPaneAuthzInfoOwnedBy,
  getPaneAuthzInfoOwnedByPane,
  registerParkedBrowserCloser,
  wasParkedBrowserClosed,
} from '../orch/pane-registry';
import { injectPastedPrompt } from '../orch/tool-util';
import { resolveCwdForScope } from '../orch/workspace-path';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { z } from 'zod';
import { onIpcGuarded } from '../runtime/git-ipc-guard';
import { KeyedCoalescingWorker } from '../util/keyed-coalescing-worker';

export interface BrowserEntry {
  paneId: string;
  scope: ProjectExecutionScope;
  owner: WebContents;
  view: WebContentsView;
  url: string;
  title: string;
  loading: boolean;
  error?: string;
  /** Opened via nexus_browser_open/an agent pane, not the operator's own tab. */
  agentOwned: boolean;
  /** Active device emulation (CSS px); absent when the pane renders natively. */
  emulatedViewport?: { width: number; height: number };
  profileMode: 'personal' | 'isolated';
  disconnectProfile?: () => Promise<void>;
  lastBounds?: BrowserPaneBounds;
  /**
   * A janela foi para outro projeto: a vista está escondida, mas a página, o
   * login e as ferramentas do agente seguem vivos. Some quando o renderer
   * do projeto volta e readota a vista.
   */
  parkedAt?: number;
  /** Exact main-owned URL fence for an automated read-only design review. */
  exactNavigationLock?: string;
  restoringExactNavigation: boolean;
  /** Isolated internal relay leases; no production CDP transport is registered. */
  cdpReleases?: Set<() => void>;
  allowedPrivateTargets: Map<string, Set<string>>;
  resolveHostname: BrowserAddressResolver;
  networkProxy: PinnedBrowserProxy;
  // Main-frame navigation sequence counters. navSeq increments on every
  // did-start-navigation for the main frame; the last*Seq fields remember
  // which seq the corresponding completion event belonged to so actions can
  // report whether they triggered a real or in-page navigation.
  navSeq: number;
  /** Bumped at the start of every Main-driven load (operator or agent). */
  loadGeneration: number;
  /** Main-driven loads still awaiting their navigation (loadBrowserForEntry). */
  loadsInFlight: number;
  lastNewDocNavSeq: number;
  lastInPageNavSeq: number;
  /** Bounded ring of console/HTTP/load failures (≤ 20), newest last. */
  errors: TrackedBrowserError[];
  /** Monotonic counter stamped on each pushed error. */
  errorSeq: number;
  /** seq of the last action start — `read` reports errors after this point. */
  errorWindowStart: number;
  /** Bumped for every request of this pane's page that the policy let through. */
  requestSeq: number;
  /** Requests still open: Chromium request id → the requestSeq it started at. */
  inFlightRequests: Map<number, number>;
  /** Bumped when a tracked request ends: its response usually re-renders. */
  requestEndSeq: number;
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

export type BrowserDeviceKind = 'mobile' | 'tablet' | 'desktop';
/** Representative CSS width per breakpoint; null disables emulation. */
const DEVICE_EMULATION_WIDTH: Record<BrowserDeviceKind, number | null> = {
  mobile: 390,
  tablet: 800,
  desktop: null,
};

/** Shared by the renderer's device-emulation IPC and `nexus_browser_navigate`'s `device` param. */
function applyBrowserDeviceEmulation(
  entry: BrowserEntry,
  key: string,
  width: number | null,
): boolean {
  const wc = entry.view.webContents;
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
    wc.setUserAgent(tablet ? TABLET_EMULATION_USER_AGENT : MOBILE_EMULATION_USER_AGENT);
    const emulatedHeight = tablet ? TABLET_EMULATION_HEIGHT : MOBILE_EMULATION_HEIGHT;
    wc.enableDeviceEmulation({
      screenPosition: 'mobile',
      screenSize: { width: width as number, height: emulatedHeight },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: width as number, height: emulatedHeight },
      deviceScaleFactor: 0,
      scale: 1,
    });
    entry.emulatedViewport = { width: width as number, height: emulatedHeight };
  } else {
    wc.disableDeviceEmulation();
    entry.emulatedViewport = undefined;
    const original = originalUserAgents.get(key);
    if (original) {
      wc.setUserAgent(original);
      originalUserAgents.delete(key);
    }
  }
  return emulate;
}
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

/**
 * Partições Chromium (`nexus-browser-…`) carregadas neste processo. Uma
 * sessão aberta segura arquivos da pasta: a higiene de disco nunca a apaga,
 * mesmo com o pane já fechado (o Electron não descarrega a sessão).
 */
const loadedBrowserPartitions = new Set<string>();

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

/** The refusal keeps its reason and adds the route that works (P0-6). */
function withBlockedTargetHint(kind: BrowserUrlBlockKind, reason: string, rawUrl: string): string {
  const hint = browserBlockedTargetHint(kind, rawUrl);
  return hint ? `${reason} — ${hint}` : reason;
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

/** Long-lived sockets never "finish": they must not hold an action's settle. */
const UNSETTLED_RESOURCE_TYPES = new Set(['webSocket', 'media', 'ping', 'cspReport']);
const MAX_TRACKED_REQUESTS = 512;

function trackRequestStart(
  entry: BrowserEntry,
  details: { id?: number; webContentsId?: number; resourceType?: string },
): void {
  if (typeof details.id !== 'number') return;
  if (details.webContentsId !== undefined && details.webContentsId !== entry.view.webContents?.id) return;
  if (details.resourceType && UNSETTLED_RESOURCE_TYPES.has(details.resourceType)) return;
  entry.requestSeq += 1;
  entry.inFlightRequests.set(details.id, entry.requestSeq);
  while (entry.inFlightRequests.size > MAX_TRACKED_REQUESTS) {
    const oldest = entry.inFlightRequests.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    entry.inFlightRequests.delete(oldest);
  }
}

function trackRequestEnd(entry: BrowserEntry, id: number): void {
  if (entry.inFlightRequests.delete(id)) entry.requestEndSeq += 1;
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
    session.on('will-download', (event, item, webContents) => {
      // Browser automation has no download primitive. Prevent a click from
      // writing an attacker-selected file without a dedicated confirmation —
      // but say so: a silent cancel read as "the button does nothing".
      event.preventDefault();
      const owner = webContents ? browserEntryForWebContents(webContents) : null;
      if (!owner) return;
      const name = typeof item?.getFilename === 'function' ? item.getFilename() : '';
      const mime = typeof item?.getMimeType === 'function' ? item.getMimeType() : '';
      pushBrowserError(owner.entry, {
        kind: 'load',
        message: `download blocked (no download in automation): ${name || 'file'}${mime ? ` (${mime})` : ''}`,
      });
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
            trackRequestStart(entry, details);
            callback({});
            return;
          }
          const blockKind = decision.allowed ? 'private-network' : decision.kind;
          if (details.resourceType === 'mainFrame') {
            entry.loading = false;
            entry.error = `navigation blocked (${blockKind}): ${safeTargetLabel(details.url)}`;
            emitState(entry);
          } else {
            // A page calling its API on another local port used to fail with
            // no trace: the agent saw an empty list and never learned why.
            pushBrowserError(entry, {
              kind: 'load',
              message: `request blocked (${blockKind}): ${safeTargetLabel(details.url)}`,
            });
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
    const message = err instanceof Error ? err.message : 'invalid browser URL';
    const kind: BrowserUrlBlockKind = message.includes('only allow') ? 'unsafe-scheme' : 'invalid-url';
    throw new BrowserNavigationBlockedError(kind, withBlockedTargetHint(kind, message, rawUrl));
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
    throw new BrowserNavigationBlockedError(
      decision.kind,
      withBlockedTargetHint(decision.kind, decision.reason, rawUrl),
    );
  }
  if (
    !allowedTargetMatchesPins(
      decision,
      entry.allowedPrivateTargets.get(targetKey),
    )
  ) {
    throw new BrowserNavigationBlockedError(
      'private-network',
      withBlockedTargetHint(
        'private-network',
        'private target address changed; confirmation required',
        rawUrl,
      ),
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

  const key = browserKey(scope, paneId);
  const agentOwned = isAgentRequestedBrowser(owner, paneId);
  if (agentOwned) rememberAgentBrowser(key);
  const profileMode = browserProfileMode(key, agentOwned);
  const partition = browserPartition(scope, paneId) + (profileMode === 'personal' ? '-personal' : '');
  loadedBrowserPartitions.add(partition.slice('persist:'.length));
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
        // A page alert/confirm/prompt blocks the renderer until someone
        // answers; in an agent pane nobody is there, so automation hung until
        // its timeout. Disabled dialogs answer at once: alert closes, confirm
        // says Cancel (never an automatic "yes" to "delete?"), prompt is empty.
        // The operator's own pane keeps native dialogs — a person answers.
        disableDialogs: agentOwned,
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
    agentOwned,
    profileMode,
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
    loadGeneration: 0,
    loadsInFlight: 0,
    lastNewDocNavSeq: 0,
    lastInPageNavSeq: 0,
    errors: [],
    errorSeq: 0,
    errorWindowStart: 0,
    requestSeq: 0,
    inFlightRequests: new Map(),
    requestEndSeq: 0,
  };
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
    // A emulação de dispositivo é do widget do documento: o Chromium troca o
    // RenderFrameHost a cada navegação de documento e a página nova nascia no
    // layout desktop (smoke 28/09: "mobile" de 390 media viewport 989 e o
    // responsive auditava a mesma largura nos três dispositivos). Reaplica
    // no commit, antes de did-finish-load — a auditoria e o print já veem o
    // layout emulado.
    if (entry.emulatedViewport) {
      applyBrowserDeviceEmulation(entry, key, entry.emulatedViewport.width);
    }
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
  // Settle tracking: a request the page opened is in flight until it
  // completes or fails (cancelled by policy requests never start).
  wc.session.webRequest.onErrorOccurred?.((details) => {
    trackRequestEnd(entry, details.id);
  });
  wc.session.webRequest.onCompleted((details) => {
    trackRequestEnd(entry, details.id);
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
  if (profileMode === 'personal') {
    try {
      entry.disconnectProfile = await connectPersonalProfile(wc, () => {
        // Cookie teardown belongs to this immutable view/session, even after
        // the owner switches workspace. Imports still require the live scope.
        if (wc.isDestroyed() || wc.session !== browserSession) throw new Error('Browser profile authority changed');
      }, (message) => { if (browsers.get(key) === entry) { entry.error = message; emitState(entry); } });
      requireLiveRendererWorkspaceScope(owner, scope);
      if (browsers.get(key) !== entry) throw new Error('Browser profile authority changed');
    } catch (error) {
      await entry.disconnectProfile?.();
      destroyBrowser(paneId, scope);
      throw error;
    }
  }
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
    // Fechado pelo agente enquanto o projeto estava fora da tela: o layout
    // salvo ainda o traz, e o pedido de fechamento chega junto do espelho.
    if (wasParkedBrowserClosed(owner, paneId)) {
      throw new Error('browser pane was closed while its project was in the background');
    }
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
  // Volta do projeto: o layout salvo traz a URL de quando a janela saiu, mas
  // a página viva (talvez navegada pelo agente enquanto isso) é a verdade.
  const readopted = entry.parkedAt !== undefined;
  entry.parkedAt = undefined;
  if (readopted) {
    emitState(entry);
    return stateOf(paneId, entry);
  }
  // A URL do renderer é só a navegação INICIAL do pane. Se o Main já navegou
  // esta vista (nexus_browser_open cria o pane em about:blank e carrega o
  // alvo logo depois do ack), o pane chega atrasado com a URL do nascimento:
  // durante o primeiro carregamento o getURL() ainda é '' e a comparação
  // abaixo via a URL-alvo como "diferente", disparando um about:blank que
  // abortava o carregamento do agente. A página viva é a verdade: com uma
  // navegação do Main em voo, ou com a vista já navegada e o pane pedindo só
  // o about:blank de nascimento, o pedido do renderer não navega.
  const initialUrl = url?.trim();
  if (
    entry.loadsInFlight > 0 ||
    (initialUrl === 'about:blank' && entry.loadGeneration > 0)
  ) {
    return stateOf(paneId, entry);
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

class BrowserLoadTimeoutError extends Error {}
/** A load discarded before touching the page: a newer navigation won the race. */
class BrowserLoadSupersededError extends Error {}

/**
 * Deadline for one page load (responsive runs only). A load that never
 * settles is stopped, so the pane does not keep a half-loaded navigation.
 */
async function loadURLWithDeadline(entry: BrowserEntry, url: string, timeoutMs: number): Promise<void> {
  const wc = entry.view.webContents;
  const load = wc.loadURL(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([load, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserLoadTimeoutError(
        `page load timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    })]);
  } catch (error) {
    if (error instanceof BrowserLoadTimeoutError) {
      load.catch(() => {});
      if (!wc.isDestroyed()) wc.stop();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Teto de ESPERA de uma navegação comum (agente ou operador). Não é deadline
 * de carregamento: passado o teto, a ferramenta devolve o estado atual com
 * `loading: true` e a página segue carregando — nada é parado. Sem ele, um
 * loadURL que não assenta prendia a chamada MCP até o app fechar.
 */
export const BROWSER_LOAD_WAIT_MS = 15_000;

async function loadURLWithBoundedWait(entry: BrowserEntry, url: string, waitMs: number): Promise<void> {
  const load = entry.view.webContents.loadURL(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    load.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (timedOut) {
    // O carregamento continua; uma falha tardia chega pelos eventos da vista
    // e o `loading` do estado vem do próprio webContents.
    load.catch(() => {});
  }
}

/** `nexus_browser_responsive`: the operator's (or the page's) navigation wins over ours. */
const NAVIGATED_ELSEWHERE = 'the pane navigated elsewhere during the run';

type LoadBrowserForEntryOptions = Parameters<typeof navigateBrowserEntry>[3];

/**
 * Toda navegação do Main passa por aqui: enquanto ela não assenta, o pedido
 * inicial do renderer (ensureBrowser) não pode navegar por cima dela.
 */
async function loadBrowserForEntry(
  paneId: string,
  entry: BrowserEntry,
  rawUrl: string,
  options: LoadBrowserForEntryOptions = {},
): Promise<BrowserPaneState> {
  entry.loadsInFlight += 1;
  try {
    return await navigateBrowserEntry(paneId, entry, rawUrl, options);
  } finally {
    entry.loadsInFlight -= 1;
  }
}

async function navigateBrowserEntry(
  paneId: string,
  entry: BrowserEntry,
  rawUrl: string,
  options: {
    privateAccessConfirmed?: boolean;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
    device?: BrowserDeviceKind;
    /**
     * Only `nexus_browser_responsive`: a real deadline that stops the load.
     * Ordinary navigation only bounds its WAIT (BROWSER_LOAD_WAIT_MS).
     */
    loadTimeoutMs?: number;
    /**
     * Only `nexus_browser_responsive`: the pane's navigation counter the
     * caller saw before calling. The URL/DNS checks above await; if the
     * operator (or the page) navigated meanwhile, this load is stale and must
     * not be emulated nor loaded over the newer navigation.
     */
    expectedNavSeq?: number;
  } = {},
): Promise<BrowserPaneState> {
  entry.loadGeneration += 1;
  const ownLoadGeneration = entry.loadGeneration;
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
  if (
    options.expectedNavSeq !== undefined &&
    (entry.navSeq !== options.expectedNavSeq || entry.loadGeneration !== ownLoadGeneration)
  ) {
    throw new BrowserLoadSupersededError(`${NAVIGATED_ELSEWHERE}; stale load discarded`);
  }
  entry.url = url;
  entry.error = undefined;
  assertCurrentAuthority();
  // Only after URL/DNS/authority checks: a refused navigation must not
  // leave the current page emulating another device.
  if (options.device) {
    applyBrowserDeviceEmulation(
      entry,
      browserKey(entry.scope, paneId),
      DEVICE_EMULATION_WIDTH[options.device],
    );
  }
  if (url === 'about:blank') {
    entry.view.webContents.loadURL(url).catch(() => {});
  } else {
    if (options.loadTimeoutMs === undefined) await loadURLWithBoundedWait(entry, url, BROWSER_LOAD_WAIT_MS);
    else await loadURLWithDeadline(entry, url, options.loadTimeoutMs);
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
    /** Emulate a device breakpoint before this navigation loads. */
    device?: BrowserDeviceKind;
  },
): Promise<
  BrowserPaneState & {
    after: BrowserAfterState;
    changed: BrowserChanged;
    errors: BrowserErrorReport;
    judgment?: BrowserPageJudgment | null;
    judgmentSkipped?: BrowserJudgmentSkipped;
    visualJudgment?: BrowserVisualAutoJudgment;
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
    visualJudgment?: BrowserVisualAutoJudgment;
    page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
  };
  if (options.read !== undefined && options.read !== false) {
    out.page = await inlinePageRead(paneId, options.scope, options.read);
  }
  const skipped = options.judge === true ? browserJudgeUnavailable(options.deps) : null;
  if (skipped) {
    out.judgment = null;
    out.judgmentSkipped = skipped;
  } else if (options.judge === true) {
    const readForJudge: BrowserPageReadResult =
      out.page && 'bodyText' in out.page
        ? out.page
        : await readBrowserPage(paneId, options.scope, {
            maxChars: 4_000,
            maxElements: 60,
          });
    const visual = autoBrowserVisualJudgment(paneId, entry, options);
    const verdict = await judgeBrowserPage(readForJudge, errors, {
      sessionId: options.sessionId,
      missionId: options.missionId,
      ...(options.deps ? { deps: options.deps } : {}),
    }, entry);
    out.judgment = verdict.judgment;
    if (verdict.judgmentSkipped) out.judgmentSkipped = verdict.judgmentSkipped;
    const visualVerdict = await visual;
    if (visualVerdict) out.visualJudgment = visualVerdict;
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
  for (const release of [...(entry.cdpReleases ?? [])]) release();
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

/** An emulated device paints only its viewSize: clamp it like a normal screenshot, never trust it blindly. */
function visualCaptureClip(entry: BrowserEntry): { x: number; y: number; width: number; height: number } | null {
  if (!entry.emulatedViewport) return null;
  const clip = clampScreenshotClip({ x: 0, y: 0, ...entry.emulatedViewport }, entry.view.getBounds());
  if (!clip) throw new BrowserVisualRefusal('unverifiable_geometry');
  return clip;
}

/** Capture remains in memory; ordinary local screenshots are never overwritten. */
export async function captureRedactedBrowserVisual(
  paneId: string,
  scope: ProjectExecutionScope,
  options: { signal?: AbortSignal; assertCurrentAuthority?: () => void } = {},
) {
  const entry = withEntry(paneId, scope);
  // O perfil pessoal carrega os logins reais do operador: pixels dele nunca saem.
  if (entry.profileMode === 'personal') throw new BrowserVisualRefusal('personal_profile');
  const navSeq = entry.navSeq; const generation = entry.loadGeneration;
  const bounds = JSON.stringify(entry.view.getBounds());
  const assertCurrent = (): void => {
    options.assertCurrentAuthority?.();
    if (options.signal?.aborted || withEntry(paneId, scope) !== entry || entry.view.webContents.isDestroyed() ||
      entry.view.webContents.isCrashed() || entry.navSeq !== navSeq || entry.loadGeneration !== generation ||
      JSON.stringify(entry.view.getBounds()) !== bounds) throw new Error('visual snapshot changed');
  };
  assertCurrent();
  // Cheap, bounded walk first: a hostile page fails here before the deep CDP inspection.
  const before = browserVisualMasksSchema.parse(await runBrowserAutomation(paneId, entry.view.webContents, 'visual_masks', {}));
  assertCurrent();
  await assertInspectableBrowserDom(entry.view.webContents.debugger);
  assertCurrent();
  const clip = visualCaptureClip(entry);
  const image = await captureWithWakeRetry(() => entry.view.webContents.capturePage(clip ?? undefined), assertCurrent);
  assertCurrent();
  const after = browserVisualMasksSchema.parse(await runBrowserAutomation(paneId, entry.view.webContents, 'visual_masks', {}));
  await assertInspectableBrowserDom(entry.view.webContents.debugger);
  assertCurrent();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('visual masks changed during capture');
  const size = image.getSize();
  const bitmap = maskBrowserBitmap(image.toBitmap(), size, before, clip ? { width: clip.width, height: clip.height } : undefined);
  const png = nativeImage.createFromBitmap(bitmap, { ...size, scaleFactor: 1 }).toPNG();
  const decisionImage = { content_type: 'image/png' as const, base64: png.toString('base64') };
  if (!validateDecisionImages([decisionImage])) throw new Error('visual image exceeds provider limits');
  assertCurrent();
  return { image: decisionImage, assertCurrent };
}

/** Longest side of the image handed to the model (it downsizes past this). */
const INLINE_IMAGE_MAX_SIDE = 1_568;
/** Above this the inline copy is re-encoded as JPEG. */
const INLINE_IMAGE_MAX_PNG_BYTES = 1_000_000;
/** Chromium texture limit: a taller full page is cut and marked truncated. */
const FULL_PAGE_MAX_CSS_PX = 16_384;
/** One frame for prefers-color-scheme to restyle before the capture. */
const THEME_SETTLE_MS = 150;

export type BrowserScreenshotTheme = 'light' | 'dark';

export interface BrowserScreenshotInlineImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export type BrowserScreenshotCapture = BrowserScreenshotResult & {
  fullPage?: true;
  theme?: BrowserScreenshotTheme;
  /** Ref of the element the capture was cropped to. */
  element?: string;
  /** Bounded copy for the model; only when asked and never for the personal profile. */
  image?: BrowserScreenshotInlineImage;
  imageOmitted?: 'personal_profile';
};

type CaptureImage = {
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  toJPEG?(quality: number): Buffer;
  resize?(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): CaptureImage;
};

/**
 * Borrows the pane's CDP session for one capture step. A debugger someone
 * else attached (relay lease, personal profile) is used as is and left
 * attached; one we attached is detached on every path.
 */
async function withBrowserDebugger<T>(
  wc: WebContents,
  run: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const inspector = wc.debugger;
  const owned = !inspector.isAttached();
  if (owned) inspector.attach('1.3');
  try {
    return await run((method, params) => inspector.sendCommand(method, params));
  } finally {
    if (owned) {
      try {
        inspector.detach();
      } catch {
        // Already detached (renderer gone).
      }
    }
  }
}

function inlineImageOf(image: CaptureImage): BrowserScreenshotInlineImage {
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  let bounded = image;
  if (longest > INLINE_IMAGE_MAX_SIDE && typeof image.resize === 'function') {
    // One side given: NativeImage keeps the aspect ratio.
    bounded = image.resize(
      size.width >= size.height
        ? { width: INLINE_IMAGE_MAX_SIDE, quality: 'good' }
        : { height: INLINE_IMAGE_MAX_SIDE, quality: 'good' },
    );
  }
  const boundedSize = bounded.getSize();
  const png = bounded.toPNG();
  if (png.length > INLINE_IMAGE_MAX_PNG_BYTES && typeof bounded.toJPEG === 'function') {
    return {
      data: bounded.toJPEG(80).toString('base64'),
      mimeType: 'image/jpeg',
      width: boundedSize.width,
      height: boundedSize.height,
    };
  }
  return { data: png.toString('base64'), mimeType: 'image/png', ...boundedSize };
}

export async function captureBrowserScreenshot(
  paneId: string,
  scope: ProjectExecutionScope,
  missionId?: string,
  options: {
    clip?: BrowserDesignRect;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
    /** Whole scrollable page, not just the viewport (CDP captureBeyondViewport). */
    fullPage?: boolean;
    /** Render with prefers-color-scheme for this capture only. */
    theme?: BrowserScreenshotTheme;
    /** Crop to this element (scrolled into view first). */
    ref?: string;
    /** Also return a bounded copy of the pixels for the model. */
    includeImage?: boolean;
  } = {},
): Promise<BrowserScreenshotCapture> {
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
  let elementClip: BrowserDesignRect | undefined;
  if (options.ref) {
    elementClip = browserElementRectSchema.parse(
      await runBrowserAutomationForPane(paneId, scope, 'element_rect', { ref: options.ref }),
    );
    assertCurrentAuthority();
  }
  const requestedClip = options.clip ?? elementClip;
  // An emulated device paints only its viewSize at the view's top-left; the
  // rest of the slot is blank, so a full capture would be letterboxed.
  const viewport = requestedClip || options.fullPage ? undefined : entry.emulatedViewport;
  const clip = requestedClip
    ? clampScreenshotClip(requestedClip, entry.view.getBounds(), {
        padding: ELEMENT_SHOT_PADDING,
      })
    : viewport
      ? clampScreenshotClip({ x: 0, y: 0, ...viewport }, entry.view.getBounds())
      : null;
  if (options.ref && !clip) {
    throw new Error('browser element is not visible in the pane; scroll it into view first');
  }
  // F-1326: the view only paints its own bounds, so a pane smaller than the
  // emulated device yields a cut capture. ponytail: flagged, not re-rendered
  // (growing a visible view would overlap the workspace); upgrade path is an
  // offscreen capture at the emulated size.
  let cut: Pick<BrowserScreenshotResult, 'truncated' | 'capturedCss' | 'viewport'> =
    viewport && clip && (clip.width < viewport.width || clip.height < viewport.height)
      ? { truncated: true as const, capturedCss: { width: clip.width, height: clip.height }, viewport: { ...viewport } }
      : {};
  const captureViewport = (): Promise<CaptureImage> =>
    captureWithWakeRetry(
      () => (clip ? wc.capturePage(clip) : wc.capturePage()),
      assertCurrentAuthority,
    ) as Promise<CaptureImage>;
  const captureFullPage = async (
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<CaptureImage> => {
    const metrics = (await send('Page.getLayoutMetrics')) as {
      cssContentSize?: { width?: number; height?: number };
      contentSize?: { width?: number; height?: number };
    };
    const content = metrics.cssContentSize ?? metrics.contentSize ?? {};
    const width = Math.max(1, Math.min(FULL_PAGE_MAX_CSS_PX, Math.ceil(content.width ?? 0)));
    const fullHeight = Math.max(1, Math.ceil(content.height ?? 0));
    const height = Math.min(FULL_PAGE_MAX_CSS_PX, fullHeight);
    if (fullHeight > height) {
      cut = { truncated: true as const, capturedCss: { width, height }, viewport: { width, height: fullHeight } };
    }
    assertCurrentAuthority();
    const shot = (await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    })) as { data?: unknown };
    if (typeof shot.data !== 'string' || !shot.data) throw new Error('full-page capture returned no image');
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')) as unknown as CaptureImage;
  };

  let image: CaptureImage;
  if (options.fullPage || options.theme) {
    image = await withBrowserDebugger(wc, async (send) => {
      if (options.theme) {
        await send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: options.theme }],
        });
      }
      try {
        if (options.theme) await new Promise((resolve) => setTimeout(resolve, THEME_SETTLE_MS));
        assertCurrentAuthority();
        return options.fullPage ? await captureFullPage(send) : await captureViewport();
      } finally {
        if (options.theme) await send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
      }
    });
  } else {
    image = await captureViewport();
  }
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

  // The personal profile carries the operator's real logins: its pixels stay
  // on disk for the human, never inline to a model provider.
  const inline = options.includeImage
    ? entry.profileMode === 'personal'
      ? { imageOmitted: 'personal_profile' as const }
      : { image: inlineImageOf(image) }
    : {};

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
    ...cut,
    ...(options.fullPage ? { fullPage: true as const } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.ref ? { element: options.ref } : {}),
    ...inline,
  };
}

const RESPONSIVE_DEVICES: readonly BrowserDeviceKind[] = ['mobile', 'tablet', 'desktop'];
/** Per-load deadline of a responsive run (each breakpoint and the restore). */
export const RESPONSIVE_LOAD_TIMEOUT_MS = 30_000;

export type BrowserResponsiveBreakpoint =
  | {
    device: BrowserDeviceKind;
    audit: BrowserLayoutAudit;
    screenshot: BrowserScreenshotResult;
  }
  | { device: BrowserDeviceKind; loadTimedOut: true; error: string };

/**
 * `nexus_browser_responsive`: the page already open in the pane, reloaded
 * once per breakpoint through the same guarded navigation as navigate
 * (origin, DNS pins, exact-URL lock) with the same device emulation as the
 * operator's preview toggle, then audited (`layout_audit`) and captured.
 * Each load has a deadline: a breakpoint whose page never loads is reported
 * as `loadTimedOut` and the run moves on.
 * The original emulation and page are restored at the end — also on error.
 */
export async function analyzeBrowserResponsive(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    devices?: BrowserDeviceKind[];
    missionId?: string;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
  } = {},
): Promise<{
  paneId: string;
  url: string;
  breakpoints: BrowserResponsiveBreakpoint[];
  restored: boolean;
  restoreError?: string;
}> {
  const entry = withEntry(paneId, scope);
  const url = entry.view.webContents.getURL() || entry.url;
  if (!url || url === 'about:blank') {
    throw new Error('browser pane has no page open; navigate first');
  }
  const originalWidth = entry.emulatedViewport?.width ?? null;
  const devices = options.devices?.length
    ? [...new Set(options.devices)]
    : RESPONSIVE_DEVICES;
  const authority = {
    signal: options.signal,
    assertCurrentAuthority: options.assertCurrentAuthority,
    loadTimeoutMs: RESPONSIVE_LOAD_TIMEOUT_MS,
  };
  const breakpoints: BrowserResponsiveBreakpoint[] = [];
  let restoreError: string | undefined;
  // Which load/navigation is ours: anything newer (operator address bar,
  // another tool, a click inside the page) supersedes the restore.
  let ownLoadGeneration = entry.loadGeneration;
  let ownNavSeq = entry.navSeq;
  let ownWidth = entry.emulatedViewport?.width ?? null;
  const superseded = () =>
    entry.loadGeneration !== ownLoadGeneration || entry.navSeq !== ownNavSeq;
  const SUPERSEDED = NAVIGATED_ELSEWHERE;
  try {
    for (const device of devices) {
      if (superseded()) throw new Error(`${SUPERSEDED}; responsive analysis stopped`);
      // `expectedNavSeq`: the check above is not enough — the load awaits
      // DNS/pins before emulating, and a navigation in that gap must win.
      const load = loadBrowserForEntry(paneId, entry, url, { ...authority, device, expectedNavSeq: ownNavSeq });
      ownLoadGeneration = entry.loadGeneration;
      // The navigation baseline only moves for a load that ran to its end
      // (settled or timed out). A rejected load — discarded before touching
      // the page, refused by DNS, or aborted because the operator navigated
      // while it was in flight (ERR_ABORTED) — cannot tell its own
      // did-start-navigation from the operator's, so the baseline stays and
      // the restore below treats the pane as "navigated elsewhere". The
      // device width is always re-read: emulation is ours whenever applied.
      let settled = false;
      try {
        await load;
        settled = true;
      } catch (error) {
        if (!(error instanceof BrowserLoadTimeoutError)) throw error;
        settled = true;
        breakpoints.push({ device, loadTimedOut: true, error: error.message });
        continue;
      } finally {
        if (settled) ownNavSeq = entry.navSeq;
        ownWidth = entry.emulatedViewport?.width ?? null;
      }
      const audit = browserLayoutAuditSchema.parse(
        await runBrowserAutomationForPane(paneId, scope, 'layout_audit', {}),
      );
      const screenshot = await captureBrowserScreenshot(
        paneId,
        scope,
        options.missionId,
        authority,
      );
      breakpoints.push({ device, audit, screenshot });
    }
  } finally {
    // The device emulation always goes back (unless someone else changed it
    // meanwhile). The page reload is a navigation: only under the caller's
    // current authority and only if nothing navigated the pane after our
    // last load — never over the operator's own navigation.
    try {
      if (!entry.view.webContents.isDestroyed()) {
        if ((entry.emulatedViewport?.width ?? null) === ownWidth) {
          applyBrowserDeviceEmulation(entry, browserKey(scope, paneId), originalWidth);
        }
        if (superseded()) {
          restoreError = `page not reloaded: ${SUPERSEDED}`;
        } else {
          await loadBrowserForEntry(paneId, entry, url, { ...authority, expectedNavSeq: ownNavSeq });
        }
      }
    } catch (error) {
      restoreError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    paneId,
    url: redactBrowserUrl(url),
    breakpoints,
    restored: restoreError === undefined,
    ...(restoreError ? { restoreError: redactBrowserLabel(restoreError) } : {}),
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
/** Nothing happened after the action: same-document DOM updates only. */
const AFTER_GRACE_MS = 150;
/** Something happened (request, navigation): it must stay quiet this long. */
const SETTLE_QUIET_MS = 300;
/** Ceiling for a same-document action whose requests never end (long poll). */
const SAME_DOCUMENT_SETTLE_CAP_MS = 1_500;
const SETTLE_TICK_MS = 25;

interface BrowserBeforeState {
  url: string;
  title: string;
  navSeq: number;
  errorStartSeq: number;
  requestSeq: number;
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
    requestSeq: entry.requestSeq,
  };
}

/** Requests opened since the action started that are still running. */
function requestsOpenSince(entry: BrowserEntry, sinceSeq: number): number {
  let open = 0;
  for (const seq of entry.inFlightRequests.values()) if (seq > sinceSeq) open += 1;
  return open;
}

/**
 * Quiescence instead of a fixed 150 ms: an action is settled when the
 * navigation it triggered stopped loading, the requests it opened finished,
 * and neither moved for SETTLE_QUIET_MS. With no activity at all the short
 * grace still applies, so a plain click stays fast. Bounded either way —
 * reading the page while the next document is half-swapped in reported the
 * old page as the result of the click.
 */
async function waitForBrowserQuiescence(entry: BrowserEntry, before: BrowserBeforeState): Promise<void> {
  const started = Date.now();
  let lastActivityAt = started;
  let navSeq = entry.navSeq;
  let requestSeq = entry.requestSeq;
  let requestEndSeq = entry.requestEndSeq;
  let loading = entry.loading;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_TICK_MS));
    const now = Date.now();
    if (entry.view.webContents?.isDestroyed?.()) return;
    if (
      entry.navSeq !== navSeq ||
      entry.requestSeq !== requestSeq ||
      entry.requestEndSeq !== requestEndSeq ||
      entry.loading !== loading
    ) {
      navSeq = entry.navSeq;
      requestSeq = entry.requestSeq;
      requestEndSeq = entry.requestEndSeq;
      loading = entry.loading;
      lastActivityAt = now;
    }
    const navigated = entry.navSeq > before.navSeq;
    const active = navigated || entry.requestSeq > before.requestSeq;
    // A page that was already loading before the action is not waited for.
    const busy = (navigated && entry.loading) || requestsOpenSince(entry, before.requestSeq) > 0;
    const quietNeeded = active ? SETTLE_QUIET_MS : AFTER_GRACE_MS;
    if (!busy && now - lastActivityAt >= quietNeeded) return;
    const cap = navigated ? NAV_SETTLE_MS : SAME_DOCUMENT_SETTLE_CAP_MS;
    if (now - started >= cap) return;
  }
}

/**
 * Post-action settle + snapshot: waits for quiescence (see
 * waitForBrowserQuiescence), then describes the page. Everything returned is
 * redacted exactly like a page-side read.
 */
async function settleAndDescribeAfter(
  entry: BrowserEntry,
  before: BrowserBeforeState,
): Promise<{ after: BrowserAfterState; changed: BrowserChanged }> {
  const wc = entry.view.webContents;
  await waitForBrowserQuiescence(entry, before);
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
  recordOptimization?: typeof recordJevOptimization;
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

// Single attempt (retryOnTimeout:false): judge()'s retry after a timeout
// made this "never blocks" read judgment fail open only after ~8.4s.
const BROWSER_JUDGE_TIMEOUT_MS = 4_000;
/** Teto de espera do julgamento automático: a resposta da ferramenta nunca atrasa mais que isto. */
const BROWSER_JUDGE_BUDGET_MS = 1_500;

type BrowserVisualAutoJudgment =
  | Awaited<ReturnType<typeof judgeBrowserVisual>>
  | { status: 'pending' };

type PageVerdict =
  | { judgment: BrowserPageJudgment; judgmentSkipped?: never; focusedText?: string; contextSelection?: BrowserContextSelection; reused?: boolean }
  | { judgment: null; judgmentSkipped: BrowserJudgmentSkipped; reused?: boolean };
const pageJudgmentCache = new JevResponseCache<PageVerdict>();
const pageCacheOwners = new WeakMap<object, WeakMap<object, object>>();

function pageCacheOwner(entry: object, judgeFn: object): object {
  let judges = pageCacheOwners.get(entry);
  if (!judges) pageCacheOwners.set(entry, judges = new WeakMap());
  let owner = judges.get(judgeFn);
  if (!owner) judges.set(judgeFn, owner = {});
  return owner;
}

/** Why the page judgment cannot run right now, or null when it can. */
function browserJudgeUnavailable(deps?: BrowserActionDeps): BrowserJudgmentSkipped | null {
  const jevEnabled = deps?.jevEnabled ?? (() => isJevSurfaceEnabled('browserTool'));
  const jevReady = deps?.jevReady ?? (() => hasDecisionCredential('browserTool'));
  if (!jevEnabled()) return 'surface-disabled';
  if (!jevReady()) return 'no-credential';
  return null;
}

/**
 * §8 Jev page judgment (opt-in): three nouls + a page-kind choice over
 * already-redacted read data. Fail-open: off, missing credential, timeout or
 * error → `judgment: null` + `judgmentSkipped`; the action result is never
 * blocked on Jev.
 */
async function judgeBrowserPage(
  read: BrowserPageReadResult,
  errors: BrowserErrorReport,
  options?: BrowserActionOptions & { focus?: string },
  cacheEntry?: BrowserEntry,
): Promise<PageVerdict> {
  const deps = options?.deps;
  const unavailable = browserJudgeUnavailable(deps);
  if (unavailable) return { judgment: null, judgmentSkipped: unavailable };
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
    const focus = prepareBrowserFocus(read.bodyText, options?.focus);
    if (focus) Object.assign(questions, focus.questions);
    const state = {
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
        ...(focus ? { focus: focus.state } : {}),
      };
    const compute = async (): Promise<PageVerdict> => {
      const result: JevResult | null = await judgeFn({
        state, questions,
        timeoutMs: BROWSER_JUDGE_TIMEOUT_MS,
        retryOnTimeout: false,
        surface: 'browserTool',
        sessionId: options?.sessionId,
        missionId: options?.missionId,
      });
      if (!result) {
        return { judgment: null, judgmentSkipped: 'judge-unavailable' };
      }
      const focused = focus ? resolveBrowserFocus(focus, result.answers) : null;
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
        ...decisionResultUsage(result),
        ...(focused?.selection.applied ? { optimization: {
          contextBytesBefore: focused.selection.beforeBytes,
          contextBytesAfter: focused.selection.afterBytes,
        } } : {}),
      });
      return {
        ...(focused ? { focusedText: focused.text, contextSelection: focused.selection } : {}),
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
    };
    const work = async (): Promise<PageVerdict> => {
      if (!cacheEntry) return compute();
      const key = createHash('sha256').update(JSON.stringify({
        state, questions,
        navSeq: cacheEntry.navSeq,
        loadGeneration: cacheEntry.loadGeneration,
        sessionId: options?.sessionId ?? null,
        missionId: options?.missionId ?? null,
        model: process.env.NEXUS_JEV_MODEL ?? 'jev-latest',
        decisionConfiguration: decisionConfigurationKey(),
      })).digest('hex');
      const cached = await pageJudgmentCache.get(pageCacheOwner(cacheEntry, judgeFn), key, compute, (value) => value.judgment !== null);
      if (cached.reused && cached.value.judgment) {
        (deps?.recordOptimization ?? recordJevOptimization)({
          surface: 'browserTool', model: cached.value.judgment.model,
          sessionId: options?.sessionId, missionId: options?.missionId,
          optimization: {
            jevRequestsAvoided: 1,
            ...(cached.value.contextSelection?.applied ? {
              contextBytesBefore: cached.value.contextSelection.beforeBytes,
              contextBytesAfter: cached.value.contextSelection.afterBytes,
            } : {}),
          },
        });
      }
      return { ...structuredClone(cached.value), ...(cached.reused ? { reused: true } : {}) };
    };
    // ponytail: a resposta da ferramenta nunca espera o Jev mais que o orçamento;
    // a promessa perdedora continua e ainda povoa o cache para a próxima ação.
    return await Promise.race([
      work(),
      new Promise<PageVerdict>((resolve) => {
        const timer = setTimeout(
          () => resolve({ judgment: null, judgmentSkipped: 'budget-exceeded' }),
          BROWSER_JUDGE_BUDGET_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch {
    return { judgment: null, judgmentSkipped: 'judge-unavailable' };
  }
}

/**
 * §8 auto visual pós-navigate: roda só quando a superfície Jev está ligada,
 * há credencial e o operador já deu consentimento de visão
 * (`canJudgeBrowserVisual` é fail-closed). Também obedece ao orçamento —
 * estourado, a resposta sai com `status: 'pending'`.
 */
async function autoBrowserVisualJudgment(
  paneId: string,
  entry: BrowserEntry,
  options: BrowserActionOptions & {
    scope: ProjectExecutionScope;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
  },
): Promise<BrowserVisualAutoJudgment | undefined> {
  const deps = options.deps;
  if (!(deps?.jevEnabled ?? (() => isJevSurfaceEnabled('browserTool')))()) {
    return undefined;
  }
  if (!(deps?.jevReady ?? (() => hasDecisionCredential('browserTool')))()) {
    return undefined;
  }
  const inFlight = lateVisualJudgments.get(entry);
  if (inFlight && sameBrowserDocument(inFlight, entry) && !inFlight.result) {
    // One paid capture per document: a second judged call waits for the first.
    return { status: 'pending' };
  }
  const work = (async (): Promise<BrowserVisualAutoJudgment | null> => {
    try {
      const mod = await import('./browser-visual-judgment');
      if (!mod.canJudgeBrowserVisual()) return null;
      return await mod.judgeBrowserVisual({
        paneId,
        goal: 'a navegação pedida carregou a página esperada, sem erro visível',
        scope: options.scope,
        signal: options.signal,
        sessionId: options.sessionId,
        missionId: options.missionId,
        assertCurrentAuthority: options.assertCurrentAuthority,
      });
    } catch {
      return null;
    }
  })();
  const late: LateVisualJudgment = { navSeq: entry.navSeq, loadGeneration: entry.loadGeneration };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const winner = await Promise.race([
    work.then((value) => ({ landed: true as const, value })),
    new Promise<{ landed: false }>((resolve) => {
      timer = setTimeout(() => resolve({ landed: false }), BROWSER_JUDGE_BUDGET_MS);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (winner.landed) return winner.value ?? undefined;
  // The capture and the vision call were already paid for: keep the answer for
  // the next judged read of this same document instead of dropping it.
  lateVisualJudgments.set(entry, late);
  void work.then((value) => {
    if (lateVisualJudgments.get(entry) !== late) return;
    if (value) late.result = value;
    else lateVisualJudgments.delete(entry);
  });
  return { status: 'pending' };
}

interface LateVisualJudgment {
  readonly navSeq: number;
  readonly loadGeneration: number;
  result?: BrowserVisualAutoJudgment;
}
const lateVisualJudgments = new WeakMap<BrowserEntry, LateVisualJudgment>();

function sameBrowserDocument(
  mark: { readonly navSeq: number; readonly loadGeneration: number },
  entry: BrowserEntry,
): boolean {
  return mark.navSeq === entry.navSeq && mark.loadGeneration === entry.loadGeneration;
}

/** A late visual answer for the document still on screen, handed out once. */
function takeLateVisualJudgment(entry: BrowserEntry): BrowserVisualAutoJudgment | undefined {
  const late = lateVisualJudgments.get(entry);
  if (!late) return undefined;
  if (!sameBrowserDocument(late, entry)) {
    lateVisualJudgments.delete(entry);
    return undefined;
  }
  if (!late.result) return undefined;
  lateVisualJudgments.delete(entry);
  return late.result;
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
    visualJudgment?: BrowserVisualAutoJudgment;
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
    visualJudgment?: BrowserVisualAutoJudgment;
    page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
  };
  if (options?.read !== undefined && options.read !== false) {
    out.page = await inlinePageRead(
      entry.paneId,
      entry.scope,
      options.read === true ? true : options.read,
    );
  }
  const skipped = options?.judge === true ? browserJudgeUnavailable(options.deps) : null;
  if (skipped) {
    // No second page read for a judgment that cannot run (Jev off/no key).
    out.judgment = null;
    out.judgmentSkipped = skipped;
  } else if (options?.judge === true) {
    const readForJudge: BrowserPageReadResult =
      out.page && 'bodyText' in out.page
        ? out.page
        : await readBrowserPage(entry.paneId, entry.scope, {
            maxChars: 4_000,
            maxElements: 60,
          });
    const verdict = await judgeBrowserPage(readForJudge, errors, options, entry);
    out.judgment = verdict.judgment;
    if (verdict.judgmentSkipped) out.judgmentSkipped = verdict.judgmentSkipped;
    const visualJudgment = takeLateVisualJudgment(entry);
    if (visualJudgment) out.visualJudgment = visualJudgment;
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
    focus?: string;
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
    judgmentReused?: boolean;
    contextSelection?: BrowserContextSelection;
    visualJudgment?: BrowserVisualAutoJudgment;
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
    judgmentReused?: boolean;
    contextSelection?: BrowserContextSelection;
    visualJudgment?: BrowserVisualAutoJudgment;
  };
  if (options.judge === true || (options.focus?.trim() && options.judge !== false)) {
    const verdict = await judgeBrowserPage(result, errors, {
      sessionId: options.sessionId,
      missionId: options.missionId,
      focus: options.focus,
      ...(options.deps ? { deps: options.deps } : {}),
    }, entry);
    out.judgment = verdict.judgment;
    if (verdict.judgmentSkipped) out.judgmentSkipped = verdict.judgmentSkipped;
    if (verdict.reused) out.judgmentReused = true;
    if (verdict.judgment && verdict.contextSelection) {
      out.bodyText = verdict.focusedText ?? result.bodyText;
      out.contextSelection = verdict.contextSelection;
      if (verdict.contextSelection.applied) out.truncated = true;
    }
    const visualJudgment = takeLateVisualJudgment(entry);
    if (visualJudgment) out.visualJudgment = visualJudgment;
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
    focus?: string;
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
    judgmentReused?: boolean;
    contextSelection?: BrowserContextSelection;
    visualJudgment?: BrowserVisualAutoJudgment;
  }
> {
  const result = await readBrowserPage(paneId, scope, options);
  return {
    paneId,
    url: result.url,
    title: result.title,
    outline: renderBrowserOutline(result, { preserveSelectedText: result.contextSelection?.applied }),
    truncated: result.truncated,
    viewport: result.viewport,
    errors: result.errors,
    ...(result.judgment !== undefined ? { judgment: result.judgment } : {}),
    ...(result.judgmentReused ? { judgmentReused: true } : {}),
    ...(result.contextSelection ? { contextSelection: result.contextSelection } : {}),
    ...(result.judgmentSkipped
      ? { judgmentSkipped: result.judgmentSkipped }
      : {}),
    ...(result.visualJudgment ? { visualJudgment: result.visualJudgment } : {}),
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

/** The action waits on the tie-break before acting; no answer → candidates. */
const BROWSER_ACTION_TIE_BREAK_TIMEOUT_MS = 1_500;
const BROWSER_ACTION_MAX_CANDIDATES = 10;

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
  // One tie-break rule for find and for click/fill: Jev is asked only with
  // 2–5 score-tied candidates and through the first-option check (F-1626).
  // A crowded page (6+ matches) is never cut to the first five in DOM order —
  // the agent gets the candidates and picks a ref itself.
  const wc = entry.view.webContents;
  const picked = await pickBrowserFindElement(
    matches,
    {
      query: text,
      pageTitle: wc.getTitle() || entry.title,
      url: wc.getURL() || entry.url,
      timeoutMs: BROWSER_ACTION_TIE_BREAK_TIMEOUT_MS,
      ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options?.missionId !== undefined ? { missionId: options.missionId } : {}),
    },
    {
      ...(deps?.jev ? { jev: deps.jev } : {}),
      ...(deps?.jevEnabled ? { jevEnabled: deps.jevEnabled } : {}),
      ...(deps?.jevReady ? { jevReady: deps.jevReady } : {}),
      ...(deps?.recordDecision ? { recordDecision: deps.recordDecision } : {}),
    },
  );
  const chosen = picked ? matches.find((match) => match.ref === picked.ref) : undefined;
  if (picked && chosen) {
    return { ok: true, match: chosen, resolvedBy: 'jev', confidence: picked.confidence };
  }
  const candidates = matches.slice(0, BROWSER_ACTION_MAX_CANDIDATES);
  return { ok: false, candidates };
}

export async function findBrowserElements(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    text?: string;
    role?: string;
    limit?: number;
    /** Auto-on at the tool layer: Jev tie-break among 2–5 score-tied matches. */
    judge?: boolean;
    sessionId?: string;
    missionId?: string;
    deps?: BrowserFindJevDeps;
  } = {},
): Promise<BrowserFindResult & { paneId: string }> {
  const result = browserFindResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'find', {
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(options.role !== undefined ? { role: options.role } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }),
  );
  const base = { paneId, ...result };
  // `judge` is opt-out (`judge: false`) at the tool; programmatic callers
  // that omit it (e.g. click/fill text resolution) keep the pure lexical path.
  if (options.judge !== true) return base;
  const entry = withEntry(paneId, scope);
  const wc = entry.view.webContents;
  const picked = await pickBrowserFindElement(
    result.matches,
    {
      query: options.text ?? '',
      pageTitle: redactBrowserText(wc.getTitle() || entry.title),
      url: redactPageUrl(wc.getURL() || entry.url),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.missionId !== undefined ? { missionId: options.missionId } : {}),
    },
    options.deps ?? {},
  );
  return picked ? { ...base, picked } : base;
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

/** How an action reached the page: real input events or the DOM fallback. */
export type BrowserInputMode = 'native' | 'synthetic';

type NativeSkipReason = 'no-geometry' | 'offscreen' | 'occluded' | 'no-target' | 'not-delivered';

type NativeInputOutcome =
  | { delivered: true; element?: BrowserElementDescriptor }
  | { delivered: false; reason?: NativeSkipReason };

function canSendNativeInput(wc: WebContents): boolean {
  return typeof (wc as { sendInputEvent?: unknown }).sendInputEvent === 'function' && !wc.isDestroyed();
}

/**
 * Real input (F: eventos sintéticos). The preload resolves the ref, scrolls it
 * into view and arms a probe; Main sends the events through the same input
 * pipeline as a person (isTrusted, :hover, focus, Enter submits, Tab moves);
 * the preload then says whether a trusted event arrived. Only when it did not
 * — hidden pane, covered element, no geometry — does the caller fall back to
 * the synthetic DOM sequence, so an action is never delivered twice.
 */
async function deliverNativeInput(
  paneId: string,
  scope: ProjectExecutionScope,
  entry: BrowserEntry,
  prepareArgs: Record<string, unknown>,
  send: (point: { x: number; y: number } | null) => void,
): Promise<NativeInputOutcome> {
  const wc = entry.view.webContents;
  const prepared = browserInputPrepareSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'input_prepare', prepareArgs),
  );
  if (prepared.token === null) return { delivered: false, reason: prepared.reason };
  const zoom = typeof wc.getZoomFactor === 'function' ? wc.getZoomFactor() || 1 : 1;
  const point = 'x' in prepared
    ? { x: Math.round(prepared.x * zoom), y: Math.round(prepared.y * zoom) }
    : null;
  const navSeq = entry.navSeq;
  send(point);
  let delivered: boolean;
  try {
    delivered = browserInputConfirmSchema.parse(
      await runBrowserAutomationForPane(paneId, scope, 'input_confirm', { token: prepared.token }),
    ).delivered;
  } catch {
    // The input navigated the page: the old document cannot answer, and the
    // navigation itself is the proof that it was delivered.
    delivered = entry.navSeq !== navSeq;
  }
  if (!delivered) return { delivered: false, reason: 'not-delivered' };
  return { delivered: true, ...('element' in prepared ? { element: prepared.element } : {}) };
}

async function nativePointer(
  paneId: string,
  scope: ProjectExecutionScope,
  entry: BrowserEntry,
  ref: string,
  kind: 'click' | 'hover',
): Promise<NativeInputOutcome> {
  const wc = entry.view.webContents;
  if (!canSendNativeInput(wc)) return { delivered: false };
  return deliverNativeInput(paneId, scope, entry, { ref, kind }, (point) => {
    if (!point) return;
    wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    if (kind !== 'click') return;
    wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  });
}

/** Electron accelerator key codes for the named keys `press` accepts. */
const NATIVE_KEY_CODES: Readonly<Record<string, string>> = {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  ' ': 'Space', Space: 'Space', CapsLock: 'Capslock', NumLock: 'Numlock', ScrollLock: 'Scrolllock',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`])),
};
const NATIVE_MODIFIERS: Readonly<Record<string, 'shift' | 'control' | 'alt' | 'meta'>> = {
  Shift: 'shift', Control: 'control', Alt: 'alt', Meta: 'meta',
};

/** keyDown (+ the char that types or submits) + keyUp, or null → synthetic. */
function nativeKeyPlan(key: string, modifiers: readonly string[]): {
  keyCode: string;
  char?: string;
  modifiers: Array<'shift' | 'control' | 'alt' | 'meta'>;
} | null {
  const mapped = modifiers.map((modifier) => NATIVE_MODIFIERS[modifier]);
  if (mapped.some((modifier) => modifier === undefined)) return null;
  const native = mapped as Array<'shift' | 'control' | 'alt' | 'meta'>;
  const printable = key.length === 1 && /[\x20-\x7e]/.test(key);
  const keyCode = NATIVE_KEY_CODES[key] ?? (printable ? key : undefined);
  if (!keyCode) return null;
  // A shortcut (Ctrl/Alt/Meta + key) never types its character.
  const shortcut = native.some((modifier) => modifier !== 'shift');
  const char = shortcut
    ? undefined
    : key === 'Enter'
      ? '\r'
      : key === 'Space' || key === ' '
        ? ' '
        : printable
          ? key
          : undefined;
  return { keyCode, ...(char !== undefined ? { char } : {}), modifiers: native };
}

export interface BrowserClickResult {
  paneId: string;
  clicked: boolean;
  element?: BrowserElementDescriptor;
  input?: BrowserInputMode;
  nativeSkipped?: NativeSkipReason;
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
  const native = await nativePointer(paneId, scope, entry, ref, 'click');
  const element = native.delivered && native.element
    ? native.element
    : native.delivered
      ? undefined
      : browserClickResultSchema.parse(
          await runBrowserAutomationForPane(paneId, scope, 'click', { ref }),
        ).element;
  return attachAfterAndMaybePage(
    entry,
    before,
    {
      paneId,
      clicked: true as const,
      ...(element ? { element } : {}),
      input: (native.delivered ? 'native' : 'synthetic') as BrowserInputMode,
      ...(!native.delivered && native.reason ? { nativeSkipped: native.reason } : {}),
      resolvedBy,
      ...(confidence !== undefined ? { confidence } : {}),
    },
    options,
  );
}

/** What to choose: a visible option label, an option value or its index. */
export interface BrowserSelectChoice {
  option?: string;
  value?: string;
  index?: number;
}

export interface BrowserSelectResult {
  paneId: string;
  selected: boolean;
  via?: 'native-select' | 'aria-listbox';
  option?: { label: string; index?: number };
  ambiguous?: boolean;
  candidates?: BrowserFindMatch[];
  resolvedBy?: 'ref' | 'text' | 'jev';
  after?: BrowserAfterState;
  changed?: BrowserChanged;
  errors?: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}

const ARIA_OPTION_ROLES = new Set([
  'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem',
]);

/**
 * `nexus_browser_select`: a native `<select>` is set by the page primitive
 * (label, value or index; input + change fire). A component-kit dropdown
 * (Radix/shadcn Select, combobox, listbox) has no `<select>`: it is opened
 * with a real click and the option with that accessible name is clicked —
 * one clear option only, otherwise the candidates come back and nothing else
 * is clicked.
 */
export async function selectBrowserOption(
  paneId: string,
  scope: ProjectExecutionScope,
  target: BrowserActionTarget,
  choice: BrowserSelectChoice,
  options?: BrowserActionOptions,
): Promise<BrowserSelectResult> {
  const entry = withEntry(paneId, scope);
  let ref: string;
  let resolvedBy: 'ref' | 'text' | 'jev' = 'ref';
  if (typeof target === 'string') {
    ref = target;
  } else {
    const resolution = await resolveBrowserElementByText(entry, scope, target.text, options);
    if (!resolution.ok) {
      return { paneId, selected: false, ambiguous: true, candidates: resolution.candidates };
    }
    ref = resolution.match.ref;
    resolvedBy = resolution.resolvedBy;
  }
  const before = snapshotBrowserBefore(entry);
  try {
    const result = browserSelectResultSchema.parse(
      await runBrowserAutomationForPane(paneId, scope, 'select', { ref, ...choice }),
    );
    return attachAfterAndMaybePage(
      entry,
      before,
      { paneId, selected: true, via: 'native-select' as const, option: result.option, resolvedBy },
      options,
    );
  } catch (error) {
    if (!(error instanceof Error) || !/not a native select/.test(error.message)) throw error;
  }
  if (typeof choice.option !== 'string' || !choice.option.trim()) {
    throw new Error('a component dropdown is chosen by its option label (option), not value/index');
  }
  // Open it like a person, then look for the option it rendered.
  await clickBrowserElement(paneId, scope, ref);
  const find = options?.deps?.find ?? findBrowserElements;
  const { matches } = await find(paneId, scope, { text: choice.option, limit: 25 });
  const pool = matches.filter((match) => ARIA_OPTION_ROLES.has(match.role));
  const exact = pool.filter((match) => match.score >= 1);
  const pick = exact.length === 1 ? exact[0] : pool.length === 1 && pool[0]!.score >= 0.75 ? pool[0] : undefined;
  if (!pick) {
    return {
      paneId,
      selected: false,
      ambiguous: pool.length > 1,
      candidates: pool.slice(0, BROWSER_ACTION_MAX_CANDIDATES),
      resolvedBy,
    };
  }
  await clickBrowserElement(paneId, scope, pick.ref);
  return attachAfterAndMaybePage(
    entry,
    before,
    { paneId, selected: true, via: 'aria-listbox' as const, option: { label: pick.name }, resolvedBy },
    options,
  );
}

export type BrowserHistoryAction = 'back' | 'forward' | 'reload';

/**
 * `back` / `forward` / `reload` for the agent, with the same after/changed/
 * errors contract as any action. History only revisits pages this pane already
 * loaded; network fetches still pass the session's request policy. A pane
 * locked to one exact review URL never walks away from it.
 */
export async function historyBrowserPane(
  paneId: string,
  scope: ProjectExecutionScope,
  action: BrowserHistoryAction,
  options?: BrowserActionOptions,
): Promise<Record<string, unknown> & { paneId: string; navigated: boolean }> {
  const entry = withEntry(paneId, scope);
  const wc = entry.view.webContents;
  if (entry.exactNavigationLock && action !== 'reload') {
    throw new Error('automated design-review browser is locked to its approved local preview URL');
  }
  const can = action === 'back' ? wc.canGoBack() : action === 'forward' ? wc.canGoForward() : true;
  if (!can) return { paneId, navigated: false, action, reason: 'no-history' };
  const before = snapshotBrowserBefore(entry);
  if (action === 'back') wc.goBack();
  else if (action === 'forward') wc.goForward();
  else wc.reload();
  return attachAfterAndMaybePage(entry, before, { paneId, navigated: true, action }, options);
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
    holdMs?: number;
    ref?: string;
    modifiers?: readonly string[];
    read?: BrowserInlineRead;
    judge?: boolean;
    sessionId?: string;
    missionId?: string;
    deps?: BrowserActionDeps;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
  },
): Promise<{
  paneId: string;
  pressed: true;
  key: string;
  ref?: string;
  input?: BrowserInputMode;
  after: BrowserAfterState;
  changed: BrowserChanged;
  errors: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}> {
  const entry = withEntry(paneId, scope);
  const before = snapshotBrowserBefore(entry);
  const generation = entry.loadGeneration;
  const assertCurrent = (): void => {
    options.assertCurrentAuthority?.();
    if (options.signal?.aborted || withEntry(paneId, scope) !== entry ||
        ((options.holdMs ?? 0) > 0 && (entry.loadGeneration !== generation || entry.navSeq !== before.navSeq))) {
      throw new Error('browser press authority or document changed');
    }
  };
  assertCurrent();
  const wc = entry.view.webContents;
  const plan = (options.holdMs ?? 0) === 0 && canSendNativeInput(wc)
    ? nativeKeyPlan(options.key, options.modifiers ?? [])
    : null;
  if (plan) {
    const native = await deliverNativeInput(
      paneId, scope, entry, { kind: 'key', ...(options.ref ? { ref: options.ref } : {}) },
      () => {
        assertCurrent();
        wc.sendInputEvent({ type: 'keyDown', keyCode: plan.keyCode, modifiers: plan.modifiers });
        if (plan.char !== undefined) {
          wc.sendInputEvent({ type: 'char', keyCode: plan.char, modifiers: plan.modifiers });
        }
        wc.sendInputEvent({ type: 'keyUp', keyCode: plan.keyCode, modifiers: plan.modifiers });
      },
    );
    if (native.delivered) {
      assertCurrent();
      const after = await attachAfterAndMaybePage(
        entry,
        before,
        {
          paneId,
          pressed: true as const,
          key: options.key,
          ...(options.ref ? { ref: options.ref } : {}),
          input: 'native' as BrowserInputMode,
        },
        options,
      );
      assertCurrent();
      return after;
    }
  }
  const result = browserPressResultSchema.parse(
    await runBrowserAutomation(paneId, entry.view.webContents, 'press', {
      key: options.key,
      ...(options.holdMs !== undefined ? { holdMs: options.holdMs } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.modifiers && options.modifiers.length > 0
        ? { modifiers: options.modifiers }
        : {}),
    }, undefined, { signal: options.signal, assertCurrentAuthority: assertCurrent }),
  );
  assertCurrent();
  const after = await attachAfterAndMaybePage(
    entry,
    before,
    { paneId, ...result, input: 'synthetic' as BrowserInputMode },
    options,
  );
  assertCurrent();
  return after;
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
  input?: BrowserInputMode;
  after: BrowserAfterState;
  changed: BrowserChanged;
  errors: BrowserErrorReport;
  judgment?: BrowserPageJudgment | null;
  judgmentSkipped?: BrowserJudgmentSkipped;
  page?: (BrowserPageReadResult | BrowserCompactPageResult) & { paneId: string };
}> {
  const entry = withEntry(paneId, scope);
  const before = snapshotBrowserBefore(entry);
  const native = await nativePointer(paneId, scope, entry, ref, 'hover');
  if (native.delivered && native.element) {
    return attachAfterAndMaybePage(
      entry,
      before,
      { paneId, hovered: true as const, element: native.element, input: 'native' as BrowserInputMode },
      options,
    );
  }
  const result = browserHoverResultSchema.parse(
    await runBrowserAutomationForPane(paneId, scope, 'hover', { ref }),
  );
  return attachAfterAndMaybePage(
    entry,
    before,
    { paneId, ...result, input: 'synthetic' as BrowserInputMode },
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

/**
 * Fire-and-forget badge sync, one at a time per pane so out-of-order pushes
 * cannot leave stale badges. NEVER awaited by IPC handlers: the automation
 * round-trip can stall up to its 7s timeout on a busy/reloading page, and the
 * badge repaint is cosmetic while the main store already committed.
 *
 * QLT-03: o sync relê o store inteiro, então pedidos que chegam durante um
 * sync viram UM sync extra no fim dele. A corrente antiga enfileirava um
 * round-trip (até 7 s) por mutação.
 */
const designMarkerSync = new KeyedCoalescingWorker<string, { paneId: string; scope: ProjectExecutionScope }>(
  (_key, { paneId, scope }) => syncDesignAnnotationMarkers(paneId, scope),
  () => {
    // syncDesignAnnotationMarkers já engole as falhas (badge é cosmético).
  },
);

function queueDesignAnnotationMarkerSync(
  paneId: string,
  scope: ProjectExecutionScope,
): void {
  designMarkerSync.enqueue(browserKey(scope, paneId), { paneId, scope });
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

// A pane opened via nexus_browser_open/an agent may sit hidden (another tab,
// collapsed/not-yet-laid-out slot): an invisible 0x0 view renders nothing
// useful for screenshots. Only while the operator can NOT see it, give it a
// decent viewport off-window. A visible agent pane keeps the operator's real
// geometry — including the 375px Mobile preset and a narrowed grid.
const AGENT_VIEWPORT_FLOOR_WIDTH = 1280;
const AGENT_VIEWPORT_FLOOR_HEIGHT = 800;
const AGENT_VIEWPORT_OFFSCREEN = 50_000;

function setBrowserBounds(entry: BrowserEntry, bounds: BrowserPaneBounds): void {
  entry.lastBounds = bounds;
  const visible =
    bounds.visible !== false && bounds.width >= 16 && bounds.height >= 16;
  if (entry.agentOwned && !visible && entry.parkedAt === undefined) {
    entry.view.setVisible(true);
    entry.view.setBounds({
      x: AGENT_VIEWPORT_OFFSCREEN,
      y: AGENT_VIEWPORT_OFFSCREEN,
      width: AGENT_VIEWPORT_FLOOR_WIDTH,
      height: AGENT_VIEWPORT_FLOOR_HEIGHT,
    });
    return;
  }
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
  for (const release of [...(entry.cdpReleases ?? [])]) release();
  browsers.delete(key);
  pendingBoundsByKey.delete(key);
  forgetParkedBrowserPane(entry.owner, paneId, scope);
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
  const close = () => {
    try { entry.view.webContents.close(); } catch { /* Already destroyed. */ }
    void entry.networkProxy.close();
  };
  if (entry.disconnectProfile) void entry.disconnectProfile().finally(close);
  else close();
}

async function closeWebContentsWithProof(entry: BrowserEntry): Promise<void> {
  const webContents = entry.view.webContents;
  await entry.disconnectProfile?.();
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

/**
 * Trocar de projeto AFASTA o navegador, como os terminais: a vista some da
 * janela, mas a página e o login continuam, e o agente do projeto segue
 * usando-o (F-168). Antes a vista era destruída e o agente caía em "unknown
 * pane" até o operador voltar — e voltava sem a página.
 */
function parkBrowserEntry(entry: BrowserEntry): void {
  if (entry.parkedAt !== undefined) return;
  entry.parkedAt = Date.now();
  const key = browserKey(entry.scope, entry.paneId);
  pendingBoundsByKey.delete(key);
  // A barra de design e a bandeja são da tela que saiu; a página sobrevive,
  // então o seletor dentro dela é desarmado.
  resetDesignPaneState(entry, key, { sameDocument: true });
  setBrowserBounds(entry, {
    ...(entry.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 }),
    visible: false,
  });
}

function reconcileBrowsersForScopeChange(
  owner: { id: number },
  previous: ProjectExecutionScope | null,
  next: ProjectExecutionScope | null,
): void {
  for (const entry of [...browsers.values()]) {
    if (entry.owner.id !== owner.id) continue;
    if (next && sameProjectScope(entry.scope, next)) continue;
    if (next) {
      // A revisão automática trava a vista numa URL exata; ela encerra como
      // antes, sem ficar viva fora da tela.
      if (entry.exactNavigationLock) destroyBrowser(entry.paneId, entry.scope);
      else parkBrowserEntry(entry);
      continue;
    }
    // Fechar o projeto encerra só os navegadores dele; os afastados de outros
    // projetos seguem esperando a volta, como os terminais estacionados.
    if (previous && sameProjectScope(entry.scope, previous)) {
      destroyBrowser(entry.paneId, entry.scope);
    }
  }
}

/** O operador tirou o projeto da lista: o que ficou afastado dele encerra. */
function destroyParkedBrowsersOfWorkspace(
  owner: { id: number },
  rootRealPath: string,
): void {
  for (const entry of [...browsers.values()]) {
    if (
      entry.owner.id === owner.id &&
      entry.parkedAt !== undefined &&
      entry.scope.rootRealPath === rootRealPath
    ) {
      destroyBrowser(entry.paneId, entry.scope);
    }
  }
}

export function getBrowserViewCount(): number {
  return browsers.size;
}

/** Ver `loadedBrowserPartitions`. */
export function loadedBrowserPartitionNames(): ReadonlySet<string> {
  return new Set(loadedBrowserPartitions);
}

/** Esvazia o cache HTTP da sessão padrão e das partições carregadas (disco apertado). */
export async function clearBrowserHttpCaches(): Promise<void> {
  const sessions = [electronSession.defaultSession,
    ...[...loadedBrowserPartitions].map((name) => electronSession.fromPartition(`persist:${name}`))];
  await Promise.allSettled(sessions.map((entry) => entry.clearCache()));
}

function browserShowsOrigin(entry: BrowserEntry, previewOrigin: string): boolean {
  try {
    return loopbackOrigin(entry.view.webContents.getURL()) === previewOrigin;
  } catch {
    return false;
  }
}

/** Isolated internal factory, without a registered endpoint/product caller.
 * A future raw connection requires a separate governed data/visual contract.
 * Each handle is bound to one document, full scope, owner, session and profile;
 * navigation invalidates it (including reload), requiring a fresh factory call.
 */
export function openCdpRelayForPane(
  paneId: string,
  scope: ProjectExecutionScope,
  options: {
    readonly write: (message: string) => void;
    readonly onDownloadDirectory?: (directory: string | null) => void;
    readonly signal?: AbortSignal;
    readonly assertCurrentAuthority?: () => void;
  },
  previewOrigin?: string,
): { readonly connection: CdpRelayConnection; readonly detach: () => void } | null {
  const frozenScope = Object.freeze({ ...scope });
  let entry: BrowserEntry;
  try { entry = withEntry(paneId, frozenScope); } catch { return null; }
  const owner = entry.owner;
  const window = liveOwnerWindow(owner);
  const wc = entry.view.webContents;
  if (!window || !canSend(wc) || entry.profileMode !== 'isolated' || entry.exactNavigationLock) return null;
  if (previewOrigin !== undefined && !browserShowsOrigin(entry, previewOrigin)) return null;
  const navSeq = entry.navSeq;
  const generation = entry.loadGeneration;
  const session = wc.session;
  const url = wc.getURL();
  let attach: ReturnType<typeof attachCdpRelay> | undefined;
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    entry.cdpReleases?.delete(revoke);
    options.signal?.removeEventListener('abort', revoke);
    try {
      wc.removeListener('did-start-navigation', onNavigation);
      wc.removeListener('destroyed', revoke);
      owner.removeListener('destroyed', revoke);
    } catch { /* Destroyed/mock emitter. */ }
    attach?.detach();
  };
  const assertCurrent = (): void => {
    try {
      options.assertCurrentAuthority?.();
      if (revoked || options.signal?.aborted || withEntry(paneId, frozenScope) !== entry ||
          entry.owner !== owner || liveOwnerWindow(owner) !== window || !canSend(wc) ||
          entry.profileMode !== 'isolated' || entry.exactNavigationLock || wc.session !== session ||
          entry.navSeq !== navSeq || entry.loadGeneration !== generation || wc.getURL() !== url) {
        throw new Error('browser relay authority revoked');
      }
    } catch (error) { revoke(); throw error; }
  };
  const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) revoke();
  };
  try {
    assertCurrent();
    attach = attachCdpRelay(wc, { ...options, assertCurrentAuthority: assertCurrent });
    if (!attach.attached) { revoke(); return null; }
    assertCurrent();
    (entry.cdpReleases ??= new Set()).add(revoke);
    wc.on('did-start-navigation', onNavigation);
    wc.once('destroyed', revoke);
    owner.once('destroyed', revoke);
    options.signal?.addEventListener('abort', revoke, { once: true });
    assertCurrent();
    return { connection: attach.connection, detach: revoke };
  } catch { revoke(); return null; }
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
  const offScopeChange = onRendererWorkspaceScopeChange(
    reconcileBrowsersForScopeChange,
  );
  const offWorkspaceForgotten = onRendererWorkspaceForgotten(
    destroyParkedBrowsersOfWorkspace,
  );
  unsubscribeBrowserScopeChanges = () => {
    offScopeChange();
    offWorkspaceForgotten();
  };
  registerParkedBrowserCloser((_owner, paneId, scope) => {
    destroyBrowser(paneId, scope);
  });
  registerBrowserAutomationResponseHandler();

  const profileChangeSchema = z.object({
    paneId: paneIdSchema,
    mode: z.enum(['personal', 'isolated']).optional(),
    shareWithAgents: z.boolean().optional(),
  }).strict();
  const importProfileSchema = z.object({ paneId: paneIdSchema, profileId: z.string().regex(/^[a-f0-9]{24}$/) }).strict();
  const importCookiesSchema = importProfileSchema.extend({ domains: z.array(z.string().min(1).max(253)).min(1).max(200) });
  const profileStatus = (entry: BrowserEntry): BrowserProfileStatus => {
    const settings = getBrowserProfilePreferences();
    let storedCookies: number | null = null;
    let notice: string | undefined;
    try { storedCookies = personalCookieProfile().size; }
    catch { notice = 'O cofre do perfil está indisponível. Seus dados continuam guardados.'; }
    return { mode: entry.profileMode, enabled: settings.enabled, shareWithAgents: settings.shareWithAgents,
      storedCookies, ...(notice ? { notice } : {}) };
  };
  const switchProfile = async (entry: BrowserEntry, mode: 'personal' | 'isolated'): Promise<BrowserEntry> => {
    const { owner, scope, paneId } = entry;
    const key = browserKey(scope, paneId);
    requireLiveRendererWorkspaceScope(owner, scope);
    if (browsers.get(key) !== entry) throw new Error('A aba do navegador mudou. Tente novamente.');
    if (entry.profileMode === mode) {
      changeBrowserProfile(key, { mode });
      return entry;
    }
    if (mode === 'personal') personalCookieProfile();
    const bounds = entry.lastBounds;
    const url = entry.view.webContents.getURL() || entry.url;
    await destroyBrowserWithProof(paneId, scope);
    requireLiveRendererWorkspaceScope(owner, scope);
    changeBrowserProfile(key, { mode });
    let replacement: BrowserEntry | undefined;
    const restorePage = async () => {
      await ensureBrowser(owner, scope, paneId);
      requireLiveRendererWorkspaceScope(owner, scope);
      const current = withOwnedEntry(owner, scope, paneId);
      replacement = current;
      // Same owner, scope and pane: carry only its exact existing network
      // grants. Navigation still resolves DNS and verifies those IP pins.
      for (const [target, addresses] of entry.allowedPrivateTargets) {
        current.allowedPrivateTargets.set(target, new Set(addresses));
      }
      current.exactNavigationLock = entry.exactNavigationLock;
      if (bounds) setBrowserBounds(current, bounds);
      const assertCurrentAuthority = () => {
        requireLiveRendererWorkspaceScope(owner, scope);
        if (browsers.get(key) !== current) throw new Error('A aba mudou durante a troca de perfil.');
      };
      await loadBrowserForEntry(paneId, current, url, { assertCurrentAuthority });
      assertCurrentAuthority();
      emitState(current);
      return current;
    };
    try {
      return await restorePage();
    } catch (error) {
      if (browsers.has(key) && browsers.get(key) !== replacement) throw error;
      if (replacement && browsers.get(key) === replacement) await destroyBrowserWithProof(paneId, scope);
      requireLiveRendererWorkspaceScope(owner, scope);
      changeBrowserProfile(key, { mode: entry.profileMode });
      await restorePage();
      throw error;
    }
  };
  ipcMain.handle(BROWSER_CHANNELS.profileStatus, (event, raw) => {
    const { paneId } = paneSchema.strict().parse(raw);
    return profileStatus(withOwnedEntry(event.sender, requireLiveRendererWorkspaceScope(event.sender), paneId));
  });
  ipcMain.handle(BROWSER_CHANNELS.profileChange, async (event, raw) => {
    const { paneId, mode, shareWithAgents } = profileChangeSchema.parse(raw);
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    let entry = withOwnedEntry(event.sender, scope, paneId);
    if (mode) entry = await switchProfile(entry, mode);
    requireLiveRendererWorkspaceScope(event.sender, scope);
    if (shareWithAgents !== undefined) changeBrowserProfile(browserKey(scope, paneId), { shareWithAgents });
    return profileStatus(entry);
  });
  ipcMain.handle(BROWSER_CHANNELS.importProfiles, (event, raw) => {
    const { paneId } = paneSchema.strict().parse(raw);
    withOwnedEntry(event.sender, requireLiveRendererWorkspaceScope(event.sender), paneId);
    return listImportProfiles();
  });
  ipcMain.handle(BROWSER_CHANNELS.importSites, (event, raw) => {
    const { paneId, profileId } = importProfileSchema.parse(raw);
    withOwnedEntry(event.sender, requireLiveRendererWorkspaceScope(event.sender), paneId);
    return listImportSites(profileId);
  });
  ipcMain.handle(BROWSER_CHANNELS.importCookies, async (event, raw) => {
    const { paneId, profileId, domains } = importCookiesSchema.parse(raw);
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const entry = withOwnedEntry(event.sender, scope, paneId);
    const assertCurrent = () => {
      requireLiveRendererWorkspaceScope(event.sender, scope);
      if (withOwnedEntry(event.sender, scope, paneId) !== entry) throw new Error('A aba mudou durante a importação.');
    };
    const imported = await readBrowserImport(profileId, domains, assertCurrent);
    await personalCookieProfile().importCookies(imported.cookies, assertCurrent);
    assertCurrent();
    if (imported.result.importedCookies > 0) {
      try { await switchProfile(entry, 'personal'); }
      catch { throw new Error('Os dados de sessão foram importados, mas não foi possível recarregar esta aba. Abra Perfil e logins para reconectar o Perfil Nexus.'); }
    }
    requireLiveRendererWorkspaceScope(event.sender, scope);
    return imported.result;
  });

  onIpcGuarded(BROWSER_DESIGN_CHANNELS.event, (event, raw) => {
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
    const emulating = applyBrowserDeviceEmulation(entry, key, parsed.data.width);
    // UA só vale a partir da próxima navegação — o reload faz o site servir o
    // layout certo (menu hambúrguer, media queries, etc.) imediatamente.
    wc.reload();
    return { paneId: parsed.data.paneId, emulating };
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

  onIpcGuarded(BROWSER_CHANNELS.bounds, (event, raw) => {
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

  onIpcGuarded(BROWSER_CHANNELS.destroy, (event, raw) => {
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
