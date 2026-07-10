/**
 * IPC bridge — Fase 5 Jarvis Vision.
 * Wires vision handlers into the main process IPC.
 */
import { randomUUID } from 'node:crypto';
import { ipcMain, BrowserWindow } from 'electron';
import { VISION_CHANNELS } from '../../shared/vision-ipc';
import type {
  AxNode,
  OcrResult,
  ScreenCaptureMetadata,
  ScreenCaptureResultInternal,
  ScreenPermissionStatus,
  VisionContext,
  VisionContextOptions,
  VisionGetImageResult,
  VisionImageConsentResult,
} from '../../shared/vision-ipc';
import type { VisionSettings } from '../../shared/settings-types';
import { captureNexusWindow, getScreenPermissionStatus } from './screen-capture';
import { RateLimiter } from './rate-limiter';
import { ocrImage } from './ocr';
import { collectVisionContext } from './vision-orchestrator';
import {
  getVisionSettings,
  setVisionSettingsPatch,
} from '../persistence/settings-store';
import { readFocusedNexusAxTree } from './ax-tree-reader';

interface VisionIpcDeps {
  capture: () => Promise<ScreenCaptureResultInternal>;
  readAxTree: () => Promise<AxNode>;
  ocr: (buffer: Buffer) => Promise<OcrResult>;
  getScreenPermissionStatus: () => ScreenPermissionStatus;
  getVisionSettings: () => VisionSettings;
  setVisionSettings: (patch: Partial<VisionSettings>) => VisionSettings;
  createConsentToken: () => string;
  rateLimiter: RateLimiter;
}

const defaultRateLimiter = new RateLimiter(3_000);
const RAW_CAPTURE_TTL_MS = 30_000;

let lastCaptureResult: ScreenCaptureResultInternal | null = null;
let lastCaptureTimer: NodeJS.Timeout | null = null;
let activeImageConsentToken: string | null = null;

function defaultDeps(overrides: Partial<VisionIpcDeps>): VisionIpcDeps {
  return {
    capture: captureNexusWindow,
    readAxTree: readFocusedNexusAxTree,
    ocr: ocrImage,
    getScreenPermissionStatus,
    getVisionSettings,
    setVisionSettings: setVisionSettingsPatch,
    createConsentToken: randomUUID,
    rateLimiter: defaultRateLimiter,
    ...overrides,
  };
}

function toMetadata(
  result: ScreenCaptureResultInternal,
): ScreenCaptureMetadata {
  return {
    format: result.format,
    width: result.width,
    height: result.height,
    capturedAt: result.capturedAt,
    sourceId: result.sourceId,
    hasImage: result.imageBase64.length > 0,
    hasOcr: Boolean(result.ocrText),
  };
}

function rememberCapture(result: ScreenCaptureResultInternal): void {
  lastCaptureResult = result;
  if (lastCaptureTimer) clearTimeout(lastCaptureTimer);
  lastCaptureTimer = setTimeout(() => {
    clearRememberedCapture();
  }, RAW_CAPTURE_TTL_MS);
  lastCaptureTimer.unref?.();
}

function clearRememberedCapture(): void {
  lastCaptureResult = null;
  if (lastCaptureTimer) {
    clearTimeout(lastCaptureTimer);
    lastCaptureTimer = null;
  }
}

async function captureWithRateLimit(
  deps: VisionIpcDeps,
): Promise<ScreenCaptureResultInternal> {
  if (!deps.rateLimiter.tryAcquire()) {
    const waitMs = deps.rateLimiter.nextAvailableIn();
    throw new Error(
      `Rate limit: aguarde ${Math.ceil(waitMs / 1000)}s antes de capturar novamente.`,
    );
  }

  const result = await deps.capture();
  rememberCapture(result);
  broadcast(VISION_CHANNELS.captured, toMetadata(result));

  return result;
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    wc.send(channel, payload);
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

function parseGetImageToken(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const input = raw as Record<string, unknown>;
  return typeof input.consentToken === 'string' ? input.consentToken : '';
}

function parseImageConsent(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (!raw || typeof raw !== 'object') return false;
  const input = raw as Record<string, unknown>;
  return input.allowCloudImage === true;
}

function getImage(raw: unknown, deps: VisionIpcDeps): VisionGetImageResult {
  const settings = deps.getVisionSettings();
  const consentToken = parseGetImageToken(raw);
  const hasConsent =
    settings.allowCloudImage === true &&
    activeImageConsentToken !== null &&
    consentToken === activeImageConsentToken;

  if (!hasConsent) return { error: 'consent_required' };
  if (!lastCaptureResult) return { error: 'not_found' };

  return {
    imageBase64: lastCaptureResult.imageBase64,
    format: lastCaptureResult.format,
    width: lastCaptureResult.width,
    height: lastCaptureResult.height,
    capturedAt: lastCaptureResult.capturedAt,
    sourceId: lastCaptureResult.sourceId,
  };
}

function setImageConsent(
  raw: unknown,
  deps: VisionIpcDeps,
): VisionImageConsentResult {
  const allowCloudImage = parseImageConsent(raw);
  const settings = deps.setVisionSettings({ allowCloudImage });
  if (!settings.allowCloudImage) {
    activeImageConsentToken = null;
    clearRememberedCapture();
    return { allowCloudImage: false, consentToken: null };
  }

  activeImageConsentToken = deps.createConsentToken();
  return { allowCloudImage: true, consentToken: activeImageConsentToken };
}

export function registerVisionIpc(overrides: Partial<VisionIpcDeps> = {}): void {
  const deps = defaultDeps(overrides);

  // Screen capture
  ipcMain.handle(
    VISION_CHANNELS.capture,
    async (): Promise<ScreenCaptureMetadata> =>
      toMetadata(await captureWithRateLimit(deps)),
  );

  // Raw image access — requires a fresh settings read and active consent token.
  ipcMain.handle(
    VISION_CHANNELS.getImage,
    (_event, raw: unknown): VisionGetImageResult => getImage(raw, deps),
  );

  ipcMain.handle(
    VISION_CHANNELS.setImageConsent,
    (_event, raw: unknown): VisionImageConsentResult =>
      setImageConsent(raw, deps),
  );

  // Combined local vision context. Raw image stays main-process only.
  ipcMain.handle(
    VISION_CHANNELS.context,
    async (_event, rawOptions: unknown): Promise<VisionContext> =>
      collectVisionContext(parseVisionContextOptions(rawOptions), {
        capture: () => captureWithRateLimit(deps),
        readAxTree: deps.readAxTree,
        ocr: deps.ocr,
      }),
  );

  // AX tree — delegates to the renderer via executeJavaScript
  ipcMain.handle(
    VISION_CHANNELS.axTree,
    async (): Promise<AxNode> => deps.readAxTree(),
  );

  // OCR
  ipcMain.handle(
    VISION_CHANNELS.ocr,
    async (_event, raw: unknown): Promise<OcrResult> => {
      if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('Imagem inválida para OCR.');
      }
      const buffer = Buffer.from(raw, 'base64');
      return deps.ocr(buffer);
    },
  );

  // Permission check
  ipcMain.handle(
    VISION_CHANNELS.permission,
    (): ScreenPermissionStatus => deps.getScreenPermissionStatus(),
  );
}

export function getLastCaptureMetadata(): ScreenCaptureMetadata | null {
  return lastCaptureResult ? toMetadata(lastCaptureResult) : null;
}

export function getRateLimiter(): RateLimiter {
  return defaultRateLimiter;
}

export function resetVisionIpcStateForTest(): void {
  activeImageConsentToken = null;
  clearRememberedCapture();
}
