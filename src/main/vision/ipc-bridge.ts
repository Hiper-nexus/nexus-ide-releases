/**
 * IPC bridge — Fase 5 Jarvis Vision.
 * Wires vision handlers into the main process IPC.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { VISION_CHANNELS } from '../../shared/vision-ipc';
import type { ScreenCaptureResult, OcrResult, AxNode, ScreenPermissionStatus } from '../../shared/vision-ipc';
import { captureNexusWindow, getScreenPermissionStatus } from './screen-capture';
import { RateLimiter } from './rate-limiter';
import { ocrImage } from './ocr';

const rateLimiter = new RateLimiter(3_000);

let lastCaptureResult: ScreenCaptureResult | null = null;

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    wc.send(channel, payload);
  }
}

export function registerVisionIpc(): void {
  // Screen capture
  ipcMain.handle(
    VISION_CHANNELS.capture,
    async (): Promise<ScreenCaptureResult> => {
      if (!rateLimiter.canCapture()) {
        const waitMs = rateLimiter.nextAvailableIn();
        throw new Error(
          `Rate limit: aguarde ${Math.ceil(waitMs / 1000)}s antes de capturar novamente.`,
        );
      }

      const result = await captureNexusWindow();
      rateLimiter.markCaptured();
      lastCaptureResult = result;

      // Broadcast event to all renderers
      broadcast(VISION_CHANNELS.captured, result);

      return result;
    },
  );

  // AX tree — delegates to the renderer via executeJavaScript
  ipcMain.handle(
    VISION_CHANNELS.axTree,
    async (): Promise<AxNode> => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused || focused.isDestroyed()) {
        throw new Error('Nenhuma janela ativa para extrair AX tree.');
      }

      const wc = focused.webContents;
      if (wc.isDestroyed() || wc.isCrashed()) {
        throw new Error('WebContents não disponível.');
      }

      // Execute in the renderer context (the function is exposed via preload)
      try {
        const result = await wc.executeJavaScript(
          'window.nexus?.vision?.getAxTree()',
        );
        return result as AxNode;
      } catch {
        throw new Error('Falha ao extrair AX tree do renderer.');
      }
    },
  );

  // OCR
  ipcMain.handle(
    VISION_CHANNELS.ocr,
    async (_event, raw: unknown): Promise<OcrResult> => {
      if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('Imagem inválida para OCR.');
      }
      const buffer = Buffer.from(raw, 'base64');
      return ocrImage(buffer);
    },
  );

  // Permission check
  ipcMain.handle(
    VISION_CHANNELS.permission,
    (): ScreenPermissionStatus => getScreenPermissionStatus(),
  );
}

export function getLastCaptureResult(): ScreenCaptureResult | null {
  return lastCaptureResult;
}

export function getRateLimiter(): RateLimiter {
  return rateLimiter;
}