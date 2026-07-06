import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BROWSER_CHANNELS } from '../../shared/channels';
import type {
  BrowserPaneBounds,
  BrowserPaneState,
  BrowserScreenshotResult,
} from '../../shared/types';
import { z } from 'zod';

interface BrowserEntry {
  owner: WebContents;
  view: WebContentsView;
  url: string;
  title: string;
  loading: boolean;
  error?: string;
}

const browsers = new Map<string, BrowserEntry>();
const SCREENSHOT_DIR = path.join(os.homedir(), '.nexus', 'browser-shots');

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

function normalizeUrl(raw: string | undefined): string {
  const input = (raw ?? '').trim();
  if (!input) return 'about:blank';
  if (input === 'about:blank') return input;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('browser panes only allow http:// and https:// URLs');
  }
  return url.toString();
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

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'browser';
}

function canSend(wc: WebContents): boolean {
  return !wc.isDestroyed() && !wc.isCrashed();
}

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

function createEntry(owner: WebContents, paneId: string): BrowserEntry {
  const win = BrowserWindow.fromWebContents(owner);
  if (!win || win.isDestroyed()) throw new Error('browser owner window is gone');

  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:nexus-browser-${paneId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const entry: BrowserEntry = {
    owner,
    view,
    url: 'about:blank',
    title: 'browser',
    loading: false,
  };
  browsers.set(paneId, entry);
  win.contentView.addChildView(view);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    void loadBrowser(paneId, url).catch((err) => {
      entry.error = err instanceof Error ? err.message : String(err);
      emitState(paneId);
    });
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    try {
      normalizeUrl(url);
    } catch {
      event.preventDefault();
    }
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
  const normalizedUrl = url ? normalizeUrl(url) : undefined;
  let entry = browsers.get(paneId);
  if (!entry) {
    entry = createEntry(owner, paneId);
  } else {
    assertOwner(entry, owner);
  }
  if (normalizedUrl && normalizedUrl !== (entry.view.webContents.getURL() || entry.url)) {
    void loadBrowserForEntry(paneId, entry, normalizedUrl).catch((err) => {
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
): Promise<BrowserPaneState> {
  const url = normalizeUrl(rawUrl);
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
): Promise<BrowserPaneState> {
  return loadBrowserForEntry(paneId, withEntry(paneId), rawUrl);
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
    url: wc.getURL() || entry.url,
    title: wc.getTitle() || entry.title,
    capturedAt,
  };
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
    return loadBrowserForEntry(
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
