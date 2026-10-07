
import type { IpcMainEvent, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  BROWSER_AUTOMATION_CHANNELS,
  type BrowserAutomationCommand,
  type BrowserAutomationRequest,
} from '../../shared/browser-automation';
import { browserAutomationEnvelopeSchema } from './browser-automation-schema';
import { onIpcGuarded } from '../runtime/git-ipc-guard';

const AUTOMATION_TIMEOUT_MS = 7_000;

interface PendingAutomation {
  paneId: string;
  webContentsId: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
  cancelPress?: () => void;
}

const pendingAutomation = new Map<string, PendingAutomation>();
let isResponseHandlerRegistered = false;

export function registerBrowserAutomationResponseHandler(): void {
  if (isResponseHandlerRegistered) return;
  isResponseHandlerRegistered = true;
  onIpcGuarded(
    BROWSER_AUTOMATION_CHANNELS.response,
    (event: IpcMainEvent, raw: unknown) => {
      const parsed = browserAutomationEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return;
      const pending = pendingAutomation.get(parsed.data.requestId);
      if (!pending || event.sender.id !== pending.webContentsId) return;
      pendingAutomation.delete(parsed.data.requestId);
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      if (!parsed.data.ok) {
        pending.reject(new Error(parsed.data.error ?? 'browser automation failed'));
        return;
      }
      pending.resolve(parsed.data.result);
    },
  );
}

export function rejectPendingBrowserAutomation(
  webContentsId: number,
  reason: string,
): void {
  for (const [requestId, pending] of pendingAutomation) {
    if (pending.webContentsId !== webContentsId) continue;
    pendingAutomation.delete(requestId);
    clearTimeout(pending.timer);
    pending.abortCleanup?.();
    pending.cancelPress?.();
    pending.reject(new Error(reason));
  }
}

export function runBrowserAutomation(
  paneId: string,
  webContents: WebContents,
  command: BrowserAutomationCommand,
  args: Record<string, unknown>,
  timeoutMs = AUTOMATION_TIMEOUT_MS,
  options: { signal?: AbortSignal; assertCurrentAuthority?: () => void } = {},
): Promise<unknown> {
  if (options.signal?.aborted) return Promise.reject(new Error('browser automation cancelled'));
  options.assertCurrentAuthority?.();
  if (webContents.isDestroyed() || webContents.isCrashed()) {
    return Promise.reject(new Error(`browser pane is unavailable: ${paneId}`));
  }
  const requestId = randomUUID();
  const request: BrowserAutomationRequest = { requestId, command, args };
  return new Promise((resolve, reject) => {
    let abortCleanup: (() => void) | undefined;
    const cancelRequest = (reason: string): void => {
      pendingAutomation.delete(requestId);
      clearTimeout(timer);
      abortCleanup?.();
      // Cancels only the request with this Main-minted UUID; a replacement
      // document has no matching pending press and receives no input events.
      if (command === 'press' && !webContents.isDestroyed() && !webContents.isCrashed()) {
        try { webContents.send(BROWSER_AUTOMATION_CHANNELS.cancel, requestId); } catch { /* renderer disappeared */ }
      }
      reject(new Error(reason));
    };
    const timer = setTimeout(() => cancelRequest('browser automation timed out'), Math.max(1_000, timeoutMs));
    if (options.signal) {
      const onAbort = (): void => cancelRequest('browser automation cancelled');
      options.signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
    }
    pendingAutomation.set(requestId, {
      paneId,
      webContentsId: webContents.id,
      resolve,
      reject,
      timer,
      abortCleanup,
      ...(command === 'press' ? { cancelPress: () => {
        if (!webContents.isDestroyed() && !webContents.isCrashed()) {
          try { webContents.send(BROWSER_AUTOMATION_CHANNELS.cancel, requestId); } catch { /* renderer disappeared */ }
        }
      } } : {}),
    });
    try {
      options.assertCurrentAuthority?.();
      if (options.signal?.aborted) { cancelRequest('browser automation cancelled'); return; }
      webContents.send(BROWSER_AUTOMATION_CHANNELS.request, request);
    } catch (error) {
      pendingAutomation.delete(requestId);
      clearTimeout(timer);
      abortCleanup?.();
      reject(
        error instanceof Error
          ? error
          : new Error('browser automation send failed'),
      );
    }
  });
}
