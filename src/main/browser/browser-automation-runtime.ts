import { ipcMain } from 'electron';
import type { IpcMainEvent, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  BROWSER_AUTOMATION_CHANNELS,
  type BrowserAutomationCommand,
  type BrowserAutomationRequest,
} from '../../shared/browser-automation';
import { browserAutomationEnvelopeSchema } from './browser-automation-schema';

const AUTOMATION_TIMEOUT_MS = 7_000;

interface PendingAutomation {
  paneId: string;
  webContentsId: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingAutomation = new Map<string, PendingAutomation>();
let isResponseHandlerRegistered = false;

export function registerBrowserAutomationResponseHandler(): void {
  if (isResponseHandlerRegistered) return;
  isResponseHandlerRegistered = true;
  ipcMain.on(
    BROWSER_AUTOMATION_CHANNELS.response,
    (event: IpcMainEvent, raw: unknown) => {
      const parsed = browserAutomationEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return;
      const pending = pendingAutomation.get(parsed.data.requestId);
      if (!pending || event.sender.id !== pending.webContentsId) return;
      pendingAutomation.delete(parsed.data.requestId);
      clearTimeout(pending.timer);
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
    pending.reject(new Error(reason));
  }
}

export function runBrowserAutomation(
  paneId: string,
  webContents: WebContents,
  command: BrowserAutomationCommand,
  args: Record<string, unknown>,
  timeoutMs = AUTOMATION_TIMEOUT_MS,
): Promise<unknown> {
  if (webContents.isDestroyed() || webContents.isCrashed()) {
    return Promise.reject(new Error(`browser pane is unavailable: ${paneId}`));
  }
  const requestId = randomUUID();
  const request: BrowserAutomationRequest = { requestId, command, args };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAutomation.delete(requestId);
      reject(new Error('browser automation timed out'));
    }, Math.max(1_000, timeoutMs));
    pendingAutomation.set(requestId, {
      paneId,
      webContentsId: webContents.id,
      resolve,
      reject,
      timer,
    });
    try {
      webContents.send(BROWSER_AUTOMATION_CHANNELS.request, request);
    } catch (error) {
      pendingAutomation.delete(requestId);
      clearTimeout(timer);
      reject(
        error instanceof Error
          ? error
          : new Error('browser automation send failed'),
      );
    }
  });
}
