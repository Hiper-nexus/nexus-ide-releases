/**
 * IPC bridge — Fase 5 Jarvis Vision.
 * Wires vision handlers into the main process IPC.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { VISION_CHANNELS } from '../../shared/vision-ipc';
import type {
  AxNode,
  OcrResult,
  ScreenCaptureResult,
  ScreenPermissionStatus,
  VisionContext,
  VisionContextOptions,
} from '../../shared/vision-ipc';
import { captureNexusWindow, getScreenPermissionStatus } from './screen-capture';
import { RateLimiter } from './rate-limiter';
import { ocrImage } from './ocr';
import { collectVisionContext } from './vision-orchestrator';

const rateLimiter = new RateLimiter(3_000);

let lastCaptureResult: ScreenCaptureResult | null = null;

async function captureWithRateLimit(): Promise<ScreenCaptureResult> {
  if (!rateLimiter.canCapture()) {
    const waitMs = rateLimiter.nextAvailableIn();
    throw new Error(
      `Rate limit: aguarde ${Math.ceil(waitMs / 1000)}s antes de capturar novamente.`,
    );
  }

  const result = await captureNexusWindow();
  rateLimiter.markCaptured();
  lastCaptureResult = result;
  broadcast(VISION_CHANNELS.captured, result);

  return result;
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    wc.send(channel, payload);
  }
}

async function readFocusedAxTree(): Promise<AxNode> {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isDestroyed()) {
    throw new Error('Nenhuma janela ativa para extrair AX tree.');
  }

  const wc = focused.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) {
    throw new Error('WebContents não disponível.');
  }

  try {
    const result = await wc.executeJavaScript(
      'window.nexus?.vision?.getAxTree()',
    );
    return result as AxNode;
  } catch {
    throw new Error('Falha ao extrair AX tree do renderer.');
  }
}

function parseVisionContextOptions(raw: unknown): VisionContextOptions {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  return {
    ...(typeof input.includeScreenshot === 'boolean'
      ? { includeScreenshot: input.includeScreenshot }
      : {}),
    ...(typeof input.includeOcr === 'boolean'
      ? { includeOcr: input.includeOcr }
      : {}),
    ...(typeof input.allowCloudImage === 'boolean'
      ? { allowCloudImage: input.allowCloudImage }
      : {}),
  };
}

export function registerVisionIpc(): void {
  // Screen capture
  ipcMain.handle(
    VISION_CHANNELS.capture,
    async (): Promise<ScreenCaptureResult> => captureWithRateLimit(),
  );

  // Combined local vision context. Raw image is returned only with consent.
  ipcMain.handle(
    VISION_CHANNELS.context,
    async (_event, rawOptions: unknown): Promise<VisionContext> =>
      collectVisionContext(parseVisionContextOptions(rawOptions), {
        capture: captureWithRateLimit,
        readAxTree: readFocusedAxTree,
      }),
  );

  // AX tree — delegates to the renderer via executeJavaScript
  ipcMain.handle(
    VISION_CHANNELS.axTree,
    async (): Promise<AxNode> => readFocusedAxTree(),
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
