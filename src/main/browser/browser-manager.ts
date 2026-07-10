import {
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  session as electronSession,
} from 'electron';
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BROWSER_CHANNELS } from '../../shared/channels';
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
import { isRunningPreviewUrl } from '../orch/preview-server';
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
  browserPageReadResultSchema,
  browserWaitResultSchema,
} from './browser-automation-schema';
import {
  registerBrowserAutomationResponseHandler,
  rejectPendingBrowserAutomation,
  runBrowserAutomation,
} from './browser-automation-runtime';
import {
  installPinnedBrowserProxy,
  type PinnedBrowserProxy,
} from './browser-network-proxy';
import { z } from 'zod';

interface BrowserEntry {
  paneId: string;
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
const SCREENSHOT_DIR = path.join(os.homedir(), '.nexus', 'browser-shots');
const DNS_TIMEOUT_MS = 3_000;
const securedSessions = new WeakSet<Session>();

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
            emitState(entry.paneId);
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
  const wc = entry.view.webContents;
  return {
    paneId,
    url: wc.getURL() || entry.url,
    title: wc.getTitle() || entry.title,
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    loading: entry.loading || wc.isLoading(),
    error: entry.error,
  };
}

const safeFilePart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'browser';

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

function emitState(paneId: string): BrowserPaneState | null {
  const entry = browsers.get(paneId);
  if (!entry) return null;
  const state = stateOf(paneId, entry);
  if (canSend(entry.owner)) {
    entry.owner.send(BROWSER_CHANNELS.state, state);
  }
  return state;
}

function assertOwner(entry: BrowserEntry, owner: WebContents): void {
  if (entry.owner !== owner) {
    throw new Error('browser pane belongs to another window');
  }
}

async function createEntry(owner: WebContents, paneId: string): Promise<BrowserEntry> {
  const win = BrowserWindow.fromWebContents(owner);
  if (!win || win.isDestroyed()) throw new Error('browser owner window is gone');

  const partition = `persist:nexus-browser-${paneId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
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
  const entry: BrowserEntry = {
    paneId,
    owner,
    view,
    url: 'about:blank',
    title: 'browser',
    loading: false,
    allowedPrivateTargets,
    resolveHostname,
    networkProxy,
  };
  browsers.set(paneId, entry);
  win.contentView.addChildView(view);
  configureSessionSecurity(entry);

  const wc = view.webContents;
  // Keep WebRTC from opening direct UDP sockets around the session proxy.
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setWindowOpenHandler(({ url }) => {
    void loadBrowserForEntry(paneId, entry, url).catch((err) => {
      entry.error = err instanceof Error ? err.message : String(err);
      emitState(paneId);
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
    emitState(paneId);
  });
  wc.on('did-stop-loading', () => {
    entry.loading = false;
    emitState(paneId);
  });
  wc.on('page-title-updated', (_event, title) => {
    entry.title = title;
    emitState(paneId);
  });
  wc.on('did-navigate', (_event, url) => {
    entry.url = url;
    entry.error = undefined;
    emitState(paneId);
  });
  wc.on('did-navigate-in-page', (_event, url) => {
    entry.url = url;
    emitState(paneId);
  });
  wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    entry.loading = false;
    entry.url = url || entry.url;
    entry.error = `${code} ${desc}`;
    emitState(paneId);
  });
  wc.on('render-process-gone', (_event, details) => {
    rejectPendingBrowserAutomation(
      wc.id,
      `browser renderer exited: ${details.reason}`,
    );
    entry.loading = false;
    entry.error = `browser renderer exited: ${details.reason}`;
    emitState(paneId);
  });
  wc.once('destroyed', () => {
    rejectPendingBrowserAutomation(wc.id, 'browser pane was destroyed');
  });
  owner.once('destroyed', () => {
    if (browsers.get(paneId) === entry) destroyBrowser(paneId);
  });
  return entry;
}

export async function ensureBrowser(
  owner: WebContents,
  paneId: string,
  url?: string,
): Promise<BrowserPaneState> {
  let entry = browsers.get(paneId);
  if (!entry) {
    let creation = browserCreations.get(paneId);
    if (!creation) {
      creation = createEntry(owner, paneId).finally(() => {
        browserCreations.delete(paneId);
      });
      browserCreations.set(paneId, creation);
    }
    entry = await creation;
    assertOwner(entry, owner);
  } else {
    assertOwner(entry, owner);
  }
  if (url && url.trim() && url.trim() !== (entry.view.webContents.getURL() || entry.url)) {
    void loadBrowserForEntry(paneId, entry, url).catch((err) => {
      entry.error = err instanceof Error ? err.message : String(err);
      entry.loading = false;
      emitState(paneId);
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
  options: { privateAccessConfirmed?: boolean } = {},
): Promise<BrowserPaneState> {
  const state = await loadBrowserForEntry(paneId, withEntry(paneId), rawUrl, options);
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
    const win = BrowserWindow.fromWebContents(entry.owner);
    if (!win || win.isDestroyed()) throw new Error('browser owner window is gone');
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
): Promise<BrowserScreenshotResult> {
  const entry = withEntry(paneId);
  const wc = entry.view.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) {
    throw new Error(`browser pane is not capturable: ${paneId}`);
  }

  const capturedAt = Date.now();
  const image = await wc.capturePage();
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    throw new Error('browser screenshot is empty; the pane may not be visible yet');
  }

  await fs.promises.mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(
    SCREENSHOT_DIR,
    `${capturedAt}-${safeFilePart(paneId)}.png`,
  );
  await fs.promises.writeFile(filePath, image.toPNG(), { mode: 0o600 });

  return {
    paneId,
    path: filePath,
    width: size.width,
    height: size.height,
    url: redactBrowserUrl(wc.getURL() || entry.url),
    title: redactBrowserLabel(wc.getTitle() || entry.title),
    capturedAt,
  };
}

function runBrowserAutomationForPane(
  paneId: string,
  command: BrowserAutomationCommand,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const entry = withEntry(paneId);
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
  options: { maxChars?: number; maxElements?: number } = {},
): Promise<BrowserPageReadResult & { paneId: string }> {
  const result = browserPageReadResultSchema.parse(
    await runBrowserAutomationForPane(paneId, 'read', {
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
  ref: string,
): Promise<BrowserElementDescriptor & { paneId: string }> {
  const result = browserElementDescriptorSchema.parse(
    await runBrowserAutomationForPane(paneId, 'inspect', { ref }),
  );
  return { paneId, ...result };
}

export async function clickBrowserElement(
  paneId: string,
  ref: string,
): Promise<{ paneId: string; clicked: true; element: BrowserElementDescriptor }> {
  const result = browserClickResultSchema.parse(
    await runBrowserAutomationForPane(paneId, 'click', { ref }),
  );
  return { paneId, ...result };
}

export async function fillBrowserElement(
  paneId: string,
  ref: string,
  text: string,
): Promise<{ paneId: string; filled: true; ref: string; length: number }> {
  const result = browserFillResultSchema.parse(
    await runBrowserAutomationForPane(paneId, 'fill', { ref, text }),
  );
  return { paneId, ...result };
}

export async function waitForBrowser(
  paneId: string,
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

function withEntry(paneId: string): BrowserEntry {
  const entry = browsers.get(paneId);
  if (!entry) throw new Error(`unknown browser pane: ${paneId}`);
  return entry;
}

function withOwnedEntry(owner: WebContents, paneId: string): BrowserEntry {
  const entry = withEntry(paneId);
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

export function destroyBrowser(paneId: string): void {
  const entry = browsers.get(paneId);
  if (!entry) return;
  browsers.delete(paneId);
  const win = BrowserWindow.fromWebContents(entry.owner);
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
  for (const [paneId, entry] of [...browsers]) {
    if (entry.owner === wc) destroyBrowser(paneId);
  }
}

export function getBrowserViewCount(): number {
  return browsers.size;
}

export function registerBrowserIpc(): void {
  registerBrowserAutomationResponseHandler();

  ipcMain.handle(BROWSER_CHANNELS.create, async (event: IpcMainInvokeEvent, raw) => {
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser create payload');
    return ensureBrowser(event.sender, parsed.data.paneId, parsed.data.url);
  });

  ipcMain.on(BROWSER_CHANNELS.bounds, (event, raw) => {
    const parsed = boundsSchema.safeParse(raw);
    if (!parsed.success) return;
    try {
      setBrowserBounds(
        withOwnedEntry(event.sender, parsed.data.paneId),
        parsed.data.bounds,
      );
    } catch {
      // Ignore stale or cross-window geometry updates.
    }
  });

  ipcMain.on(BROWSER_CHANNELS.destroy, (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) return;
    try {
      withOwnedEntry(event.sender, parsed.data.paneId);
      destroyBrowser(parsed.data.paneId);
    } catch {
      // Ignore stale or cross-window destroy requests.
    }
  });

  ipcMain.handle(BROWSER_CHANNELS.load, async (event, raw) => {
    const parsed = loadSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser load payload');
    return loadBrowserWithUserConfirmation(
      parsed.data.paneId,
      withOwnedEntry(event.sender, parsed.data.paneId),
      parsed.data.url,
    );
  });

  ipcMain.handle(BROWSER_CHANNELS.back, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser back payload');
    const entry = withOwnedEntry(event.sender, parsed.data.paneId);
    if (entry.view.webContents.canGoBack()) entry.view.webContents.goBack();
    return stateOf(parsed.data.paneId, entry);
  });

  ipcMain.handle(BROWSER_CHANNELS.forward, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser forward payload');
    const entry = withOwnedEntry(event.sender, parsed.data.paneId);
    if (entry.view.webContents.canGoForward()) entry.view.webContents.goForward();
    return stateOf(parsed.data.paneId, entry);
  });

  ipcMain.handle(BROWSER_CHANNELS.reload, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser reload payload');
    const entry = withOwnedEntry(event.sender, parsed.data.paneId);
    entry.view.webContents.reload();
    return stateOf(parsed.data.paneId, entry);
  });

  ipcMain.handle(BROWSER_CHANNELS.stop, async (event, raw) => {
    const parsed = paneSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid browser stop payload');
    const entry = withOwnedEntry(event.sender, parsed.data.paneId);
    entry.view.webContents.stop();
    return stateOf(parsed.data.paneId, entry);
  });
}
