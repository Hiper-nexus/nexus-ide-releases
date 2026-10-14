/** Project-scoped IPC authority for local Nexus vision. */
import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { VISION_CHANNELS } from '../../shared/vision-ipc';
import type {
  AxNode,
  OcrResult,
  ScreenCaptureMetadata,
  ScreenCaptureResultInternal,
  ScreenPermissionStatus,
  VisionContextOptions,
  VisionGetImageResult,
  VisionImageConsentResult,
} from '../../shared/vision-ipc';
import type { ProjectExecutionScope } from '../../shared/types';
import type { VisionSettings } from '../../shared/settings-types';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  getVisionSettings,
  setVisionSettingsPatch,
} from '../persistence/settings-store';
import { readNexusAxTree } from './ax-tree-reader';
import { ocrImage } from './ocr';
import { RateLimiter } from './rate-limiter';
import {
  captureNexusWindow,
  getScreenPermissionStatus,
  type NexusCaptureTarget,
} from './screen-capture';
import { collectVisionContext } from './vision-orchestrator';

interface VisionIpcDeps {
  capture: (
    target: NexusCaptureTarget,
  ) => Promise<ScreenCaptureResultInternal>;
  readAxTree: (owner: WebContents) => Promise<AxNode>;
  ocr: (buffer: Buffer) => Promise<OcrResult>;
  getScreenPermissionStatus: () => ScreenPermissionStatus;
  getVisionSettings: () => VisionSettings;
  setVisionSettings: (patch: Partial<VisionSettings>) => VisionSettings;
  createConsentToken: () => string;
  now: () => number;
  rateLimiter: RateLimiter;
  ocrRateLimiter: RateLimiter;
}

interface ConsentBinding {
  readonly token: string;
  readonly expiresAt: number;
}

interface OwnerVisionState {
  readonly owner: WebContents;
  readonly scope: ProjectExecutionScope;
  readonly generation: number;
  readonly mediaSourceId: string;
  readonly onDestroyed: () => void;
  readonly onRenderProcessGone: () => void;
  capture: ScreenCaptureResultInternal | null;
  captureTimer: NodeJS.Timeout | null;
  consent: ConsentBinding | null;
}

interface VisionAuthority {
  readonly state: OwnerVisionState;
  readonly owner: WebContents;
  readonly scope: ProjectExecutionScope;
  readonly generation: number;
}

const defaultRateLimiter = new RateLimiter(3_000);
const defaultOcrRateLimiter = new RateLimiter(1_000);
const RAW_CAPTURE_TTL_MS = 30_000;
const CONSENT_TTL_MS = 60_000;
const MAX_OCR_BASE64_CHARS = 16 * 1024 * 1024;
const MAX_OCR_BYTES = 12 * 1024 * 1024;

const ownerStates = new Map<number, OwnerVisionState>();
let nextGeneration = 0;
let unsubscribeScopeChanges: (() => void) | null = null;

function defaultDeps(overrides: Partial<VisionIpcDeps>): VisionIpcDeps {
  return {
    capture: captureNexusWindow,
    readAxTree: readNexusAxTree,
    ocr: ocrImage,
    getScreenPermissionStatus,
    getVisionSettings,
    setVisionSettings: setVisionSettingsPatch,
    createConsentToken: randomUUID,
    now: Date.now,
    rateLimiter: defaultRateLimiter,
    ocrRateLimiter: defaultOcrRateLimiter,
    ...overrides,
  };
}

function sameScope(
  left: ProjectExecutionScope | null,
  right: ProjectExecutionScope,
): boolean {
  return (
    left?.version === right.version &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath &&
    left.identitySource === right.identitySource
  );
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

function clearCapture(state: OwnerVisionState): void {
  state.capture = null;
  if (state.captureTimer) {
    clearTimeout(state.captureTimer);
    state.captureTimer = null;
  }
}

function releaseOwner(ownerId: number, generation?: number): void {
  const state = ownerStates.get(ownerId);
  if (!state || (generation !== undefined && state.generation !== generation)) {
    return;
  }
  ownerStates.delete(ownerId);
  clearCapture(state);
  state.consent = null;
  state.owner.removeListener('destroyed', state.onDestroyed);
  state.owner.removeListener('render-process-gone', state.onRenderProcessGone);
}

function isLive(owner: WebContents): boolean {
  return !owner.isDestroyed() && !owner.isCrashed();
}

/** Permission / System Settings do not bind a project capture lease. */
function requireLiveRenderer(event: IpcMainInvokeEvent): WebContents {
  const owner = event.sender;
  if (!isLive(owner)) throw new Error('vision_renderer_unavailable');
  return owner;
}

function createOwnerState(
  owner: WebContents,
  scope: ProjectExecutionScope,
): OwnerVisionState {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error('vision_renderer_window_unavailable');
  }
  const mediaSourceId = window.getMediaSourceId();
  if (!mediaSourceId) throw new Error('vision_media_source_unavailable');

  const generation = ++nextGeneration;
  const onDestroyed = (): void => releaseOwner(owner.id, generation);
  const onRenderProcessGone = (): void => releaseOwner(owner.id, generation);
  const state: OwnerVisionState = {
    owner,
    scope,
    generation,
    mediaSourceId,
    onDestroyed,
    onRenderProcessGone,
    capture: null,
    captureTimer: null,
    consent: null,
  };
  owner.once('destroyed', onDestroyed);
  owner.once('render-process-gone', onRenderProcessGone);
  ownerStates.set(owner.id, state);
  return state;
}

function requireAuthority(event: IpcMainInvokeEvent): VisionAuthority {
  const owner = event.sender;
  if (!isLive(owner)) throw new Error('vision_renderer_unavailable');
  const scope = requireRendererWorkspaceScope(owner);
  let state = ownerStates.get(owner.id);
  if (state && (!sameScope(state.scope, scope) || state.owner !== owner)) {
    releaseOwner(owner.id, state.generation);
    state = undefined;
  }
  state ??= createOwnerState(owner, scope);
  const authority = { state, owner, scope, generation: state.generation };
  assertAuthority(authority);
  return authority;
}

function assertAuthority(authority: VisionAuthority): void {
  const { owner, scope, generation, state } = authority;
  if (
    !isLive(owner) ||
    ownerStates.get(owner.id) !== state ||
    state.generation !== generation ||
    !sameScope(getRendererWorkspaceScope(owner), scope)
  ) {
    throw new Error('vision_authority_stale');
  }
}

function rememberCapture(
  authority: VisionAuthority,
  result: ScreenCaptureResultInternal,
): void {
  assertAuthority(authority);
  const { state } = authority;
  clearCapture(state);
  state.capture = result;
  const generation = state.generation;
  state.captureTimer = setTimeout(() => {
    const current = ownerStates.get(state.owner.id);
    if (current === state && current.generation === generation) clearCapture(state);
  }, RAW_CAPTURE_TTL_MS);
  state.captureTimer.unref?.();
}

async function captureForOwner(
  deps: VisionIpcDeps,
  authority: VisionAuthority,
): Promise<ScreenCaptureResultInternal> {
  assertAuthority(authority);
  if (!deps.rateLimiter.tryAcquire()) {
    const waitMs = deps.rateLimiter.nextAvailableIn();
    throw new Error(
      `Rate limit: aguarde ${Math.ceil(waitMs / 1000)}s antes de capturar novamente.`,
    );
  }
  const result = await deps.capture({
    mediaSourceId: authority.state.mediaSourceId,
  });
  assertAuthority(authority);
  if (result.sourceId !== authority.state.mediaSourceId) {
    throw new Error('vision_capture_source_mismatch');
  }
  rememberCapture(authority, result);
  assertAuthority(authority);
  authority.owner.send(VISION_CHANNELS.captured, toMetadata(result));
  return result;
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
  const token = (raw as Record<string, unknown>).consentToken;
  return typeof token === 'string' ? token : '';
}

function parseImageConsent(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (!raw || typeof raw !== 'object') return false;
  return (raw as Record<string, unknown>).allowCloudImage === true;
}

function getImage(
  authority: VisionAuthority,
  raw: unknown,
  deps: VisionIpcDeps,
): VisionGetImageResult {
  assertAuthority(authority);
  const { state } = authority;
  const consentToken = parseGetImageToken(raw);
  const consent = state.consent;
  if (consent && consent.expiresAt <= deps.now()) state.consent = null;
  const hasConsent =
    deps.getVisionSettings().allowCloudImage === true &&
    state.consent !== null &&
    state.consent.token === consentToken;
  if (!hasConsent) {
    assertAuthority(authority);
    return { error: 'consent_required' };
  }
  if (!state.capture) {
    assertAuthority(authority);
    return { error: 'not_found' };
  }

  const capture = state.capture;
  assertAuthority(authority);
  state.consent = null;
  return {
    imageBase64: capture.imageBase64,
    format: capture.format,
    width: capture.width,
    height: capture.height,
    capturedAt: capture.capturedAt,
    sourceId: capture.sourceId,
  };
}

function setImageConsent(
  authority: VisionAuthority,
  raw: unknown,
  deps: VisionIpcDeps,
): VisionImageConsentResult {
  assertAuthority(authority);
  const allowCloudImage = parseImageConsent(raw);
  const settings = deps.setVisionSettings({ allowCloudImage });
  assertAuthority(authority);
  if (!settings.allowCloudImage) {
    authority.state.consent = null;
    clearCapture(authority.state);
    return { allowCloudImage: false, consentToken: null };
  }

  const token = deps.createConsentToken();
  authority.state.consent = {
    token,
    expiresAt: deps.now() + CONSENT_TTL_MS,
  };
  assertAuthority(authority);
  return { allowCloudImage: true, consentToken: token };
}

function decodeOwnedOcrInput(
  authority: VisionAuthority,
  raw: unknown,
): Buffer {
  assertAuthority(authority);
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_OCR_BASE64_CHARS ||
    authority.state.capture?.imageBase64 !== raw
  ) {
    throw new Error('Imagem inválida ou não autorizada para OCR.');
  }
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_OCR_BYTES) {
    throw new Error('Imagem inválida ou não autorizada para OCR.');
  }
  return buffer;
}

function installScopeCleanup(): void {
  unsubscribeScopeChanges?.();
  unsubscribeScopeChanges = onRendererWorkspaceScopeChange((owner) => {
    releaseOwner(owner.id);
  });
}

export function registerVisionIpc(overrides: Partial<VisionIpcDeps> = {}): void {
  let deps: VisionIpcDeps | null = null;
  const getDeps = (): VisionIpcDeps => {
    if (!deps) {
      deps = defaultDeps(overrides);
      installScopeCleanup();
    }
    return deps;
  };

  ipcMain.handle(VISION_CHANNELS.capture, async (event) => {
    const currentDeps = getDeps();
    const authority = requireAuthority(event);
    const metadata = toMetadata(await captureForOwner(currentDeps, authority));
    assertAuthority(authority);
    return metadata;
  });

  ipcMain.handle(VISION_CHANNELS.getImage, async (event, raw: unknown) => {
    const currentDeps = getDeps();
    const authority = requireAuthority(event);
    return getImage(authority, raw, currentDeps);
  });

  ipcMain.handle(
    VISION_CHANNELS.setImageConsent,
    async (event, raw: unknown) => {
      const currentDeps = getDeps();
      const authority = requireAuthority(event);
      return setImageConsent(authority, raw, currentDeps);
    },
  );

  ipcMain.handle(VISION_CHANNELS.context, async (event, raw: unknown) => {
    const currentDeps = getDeps();
    const authority = requireAuthority(event);
    const context = await collectVisionContext(parseVisionContextOptions(raw), {
      capture: () => captureForOwner(currentDeps, authority),
      readAxTree: async () => {
        assertAuthority(authority);
        const tree = await currentDeps.readAxTree(authority.owner);
        assertAuthority(authority);
        return tree;
      },
      ocr: async (buffer) => {
        assertAuthority(authority);
        const result = await currentDeps.ocr(buffer);
        assertAuthority(authority);
        return result;
      },
    });
    assertAuthority(authority);
    return context;
  });

  ipcMain.handle(VISION_CHANNELS.axTree, async (event) => {
    const currentDeps = getDeps();
    const authority = requireAuthority(event);
    const tree = await currentDeps.readAxTree(authority.owner);
    assertAuthority(authority);
    return tree;
  });

  ipcMain.handle(VISION_CHANNELS.ocr, async (event, raw: unknown) => {
    const currentDeps = getDeps();
    const authority = requireAuthority(event);
    const buffer = decodeOwnedOcrInput(authority, raw);
    if (!currentDeps.ocrRateLimiter.tryAcquire()) {
      throw new Error('Rate limit: aguarde antes de executar OCR novamente.');
    }
    const result = await currentDeps.ocr(buffer);
    assertAuthority(authority);
    return result;
  });

  ipcMain.handle(VISION_CHANNELS.permission, async (event) => {
    requireLiveRenderer(event);
    return getDeps().getScreenPermissionStatus();
  });

  ipcMain.handle(VISION_CHANNELS.requestPermission, async (event) => {
    requireLiveRenderer(event);
    const { requestScreenPermissionRegistration } = await import(
      './screen-capture'
    );
    return requestScreenPermissionRegistration();
  });

  ipcMain.handle(VISION_CHANNELS.openScreenSettings, async (event) => {
    requireLiveRenderer(event);
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: 'painel de Gravação de Tela é específico do macOS',
      };
    }
    // Deep link FIXO (nenhum input do renderer) para o painel exato onde o
    // usuário habilita o NexusIDE — evita a caça manual nos Ajustes.
    const { shell } = await import('electron');
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    return { ok: true };
  });
}

export function getLastCaptureMetadata(
  ownerId?: number,
): ScreenCaptureMetadata | null {
  const state =
    ownerId === undefined
      ? ownerStates.size === 1
        ? [...ownerStates.values()][0]
        : null
      : ownerStates.get(ownerId) ?? null;
  return state?.capture ? toMetadata(state.capture) : null;
}

export function getRateLimiter(): RateLimiter {
  return defaultRateLimiter;
}

export function resetVisionIpcStateForTest(): void {
  unsubscribeScopeChanges?.();
  unsubscribeScopeChanges = null;
  for (const ownerId of [...ownerStates.keys()]) releaseOwner(ownerId);
  nextGeneration = 0;
}
