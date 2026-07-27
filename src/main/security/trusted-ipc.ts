import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

interface TrustedMainWindowRecord {
  window: BrowserWindow;
  rendererUrl: string;
}

const trustedMainWindows = new WeakMap<WebContents, TrustedMainWindowRecord>();

function isExpectedRendererLocation(
  currentRaw: string,
  expectedRaw: string,
): boolean {
  try {
    const current = new URL(currentRaw);
    const expected = new URL(expectedRaw);
    return (
      current.username === '' &&
      current.password === '' &&
      expected.username === '' &&
      expected.password === '' &&
      current.protocol === expected.protocol &&
      current.host === expected.host
    );
  } catch {
    return false;
  }
}

function safeSenderOrigin(sender: WebContents): string {
  try {
    const url = new URL(sender.getURL());
    return url.username === '' && url.password === ''
      ? `${url.protocol}//${url.host}`
      : '[credentialed-origin]';
  } catch {
    return '[invalid-origin]';
  }
}

function safeSenderFrameKind(event: SenderEvent): 'main' | 'sub' | 'unknown' {
  try {
    return event.senderFrame === event.sender.mainFrame ? 'main' : 'sub';
  } catch {
    return 'unknown';
  }
}

/**
 * Binds renderer authority to this exact main-window WebContents. Auxiliary
 * windows are intentionally never registered.
 */
export function bindTrustedMainWindow(
  window: BrowserWindow,
  rendererUrl: string,
): void {
  const contents = window.webContents;
  trustedMainWindows.set(contents, { window, rendererUrl });
  contents.once('destroyed', () => {
    const current = trustedMainWindows.get(contents);
    if (current?.window === window) trustedMainWindows.delete(contents);
  });
}

type SenderEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

export function isLiveTrustedMainWindowSender(event: SenderEvent): boolean {
  const sender = event.sender;
  const trusted = trustedMainWindows.get(sender);
  if (!trusted) return false;
  try {
    if (
      trusted.window.isDestroyed() ||
      sender.isDestroyed() ||
      sender.isCrashed() ||
      trusted.window.webContents !== sender ||
      event.senderFrame !== sender.mainFrame
    ) {
      return false;
    }
    return isExpectedRendererLocation(sender.getURL(), trusted.rendererUrl);
  } catch {
    return false;
  }
}

function deny(channel: string, event: SenderEvent): void {
  console.warn(
    `[trusted-ipc] denied "${channel}" from unverified sender ` +
      `(origin=${safeSenderOrigin(event.sender)}, ` +
      `frame=${safeSenderFrameKind(event)})`,
  );
}

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

/** Registers an invoke handler that can only be reached by the main frame. */
export function handleTrusted(channel: string, handler: InvokeHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isLiveTrustedMainWindowSender(event)) {
      deny(channel, event);
      throw new Error('ipc sender não autorizado');
    }
    return handler(event, ...args);
  });
}

type EventListener = (event: IpcMainEvent, ...args: unknown[]) => void;

/** Registers an event listener that silently drops untrusted senders. */
export function onTrusted(channel: string, listener: EventListener): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isLiveTrustedMainWindowSender(event)) {
      deny(channel, event);
      return;
    }
    listener(event, ...args);
  });
}
