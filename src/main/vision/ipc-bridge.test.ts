import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VISION_CHANNELS } from '../../shared/vision-ipc';
import type {
  ScreenCaptureResultInternal,
  VisionContext,
} from '../../shared/vision-ipc';
import type { ProjectExecutionScope } from '../../shared/types';
import { RateLimiter } from './rate-limiter';

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const windows = new Map<number, any>();
  const scopes = new Map<number, ProjectExecutionScope>();
  const scopeListeners = new Set<(...args: any[]) => void>();
  return {
    handlers,
    windows,
    scopes,
    scopeListeners,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    },
    BrowserWindow: {
      fromWebContents: vi.fn((owner: { id: number }) => windows.get(owner.id) ?? null),
      getFocusedWindow: vi.fn(),
      getAllWindows: vi.fn(() => []),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: harness.ipcMain,
  BrowserWindow: harness.BrowserWindow,
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  getRendererWorkspaceScope: (owner: { id: number }) =>
    harness.scopes.get(owner.id) ?? null,
  requireRendererWorkspaceScope: (owner: { id: number }) => {
    const scope = harness.scopes.get(owner.id);
    if (!scope) throw new Error('renderer has no authorized workspace scope');
    return scope;
  },
  onRendererWorkspaceScopeChange: (listener: (...args: any[]) => void) => {
    harness.scopeListeners.add(listener);
    return () => harness.scopeListeners.delete(listener);
  },
}));

import {
  registerVisionIpc,
  resetVisionIpcStateForTest,
} from './ipc-bridge';

const SCOPE_A = Object.freeze({
  version: 1 as const,
  installationId: 'installation',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
});
const SCOPE_B = Object.freeze({
  ...SCOPE_A,
  projectId: 'project-b',
  checkoutId: 'checkout-b',
  rootRealPath: '/workspace/b',
});
const IMAGE_A = Buffer.from('image-a').toString('base64');
const IMAGE_B = Buffer.from('image-b').toString('base64');

function captureFor(
  owner: 'A' | 'B',
): ScreenCaptureResultInternal {
  return {
    imageBase64: owner === 'A' ? IMAGE_A : IMAGE_B,
    ocrText: `text-${owner}`,
    format: 'png',
    width: 1200,
    height: 800,
    capturedAt: '2026-07-07T12:00:00.000Z',
    sourceId: `window:nexus:${owner}`,
  };
}

function createOwner(id: number, label: 'A' | 'B') {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let destroyed = false;
  let crashed = false;
  const owner = {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    isCrashed: vi.fn(() => crashed),
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const values = listeners.get(event) ?? new Set();
      values.add(listener);
      listeners.set(event, values);
      return owner;
    }),
    removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
      return owner;
    }),
    emit: (event: string) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
      listeners.delete(event);
    },
    destroy: () => {
      destroyed = true;
      owner.emit('destroyed');
    },
    crash: () => {
      crashed = true;
      owner.emit('render-process-gone');
    },
  };
  harness.windows.set(id, {
    isDestroyed: () => destroyed,
    getMediaSourceId: () => `window:nexus:${label}`,
    webContents: owner,
  });
  return owner;
}

const ownerA = createOwner(1, 'A');
const ownerB = createOwner(2, 'B');

async function invoke<T>(
  channel: string,
  owner: ReturnType<typeof createOwner>,
  raw?: unknown,
): Promise<T> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`missing handler for ${channel}`);
  return (await handler({ sender: owner }, raw)) as T;
}

function bindScope(
  owner: ReturnType<typeof createOwner>,
  scope: ProjectExecutionScope,
): void {
  const previous = harness.scopes.get(owner.id) ?? null;
  harness.scopes.set(owner.id, scope);
  for (const listener of harness.scopeListeners) {
    listener(owner, previous, scope);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registerTestIpc() {
  let allowCloudImage = false;
  let token = 0;
  let now = 1_000;
  const capture = vi.fn(async ({ mediaSourceId }: { mediaSourceId: string }) =>
    captureFor(mediaSourceId.endsWith(':A') ? 'A' : 'B'),
  );
  const readAxTree = vi.fn(async (owner: { id: number }) => ({
    tag: 'body',
    role: null,
    aria: {},
    text: `project-${owner.id}`,
    children: [],
  }));
  const ocr = vi.fn(async (buffer: Buffer) => ({
    text: buffer.toString(),
    confidence: 90,
  }));
  registerVisionIpc({
    capture,
    readAxTree: readAxTree as never,
    ocr,
    getScreenPermissionStatus: () => 'granted',
    getVisionSettings: () => ({ allowCloudImage }),
    setVisionSettings: (patch) => {
      allowCloudImage = patch.allowCloudImage ?? allowCloudImage;
      return { allowCloudImage };
    },
    createConsentToken: () => `token-${++token}`,
    now: () => now,
    rateLimiter: new RateLimiter(0, 100),
    ocrRateLimiter: new RateLimiter(0, 100),
  });
  return {
    capture,
    readAxTree,
    ocr,
    advanceTime: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('registerVisionIpc multi-window authority', () => {
  beforeEach(() => {
    resetVisionIpcStateForTest();
    harness.handlers.clear();
    harness.scopes.clear();
    harness.scopeListeners.clear();
    harness.ipcMain.handle.mockClear();
    ownerA.send.mockClear();
    ownerB.send.mockClear();
    bindScope(ownerA, SCOPE_A);
    bindScope(ownerB, SCOPE_B);
  });

  it('requires an authorized live scope on every Vision IPC channel', async () => {
    registerTestIpc();
    harness.scopes.delete(ownerB.id);

    for (const channel of [
      VISION_CHANNELS.capture,
      VISION_CHANNELS.getImage,
      VISION_CHANNELS.setImageConsent,
      VISION_CHANNELS.context,
      VISION_CHANNELS.axTree,
      VISION_CHANNELS.ocr,
      VISION_CHANNELS.permission,
    ]) {
      await expect(invoke(channel, ownerB, {})).rejects.toThrow(
        'authorized workspace scope',
      );
    }
  });

  it('rejects a destroyed sender before reading permission or project state', async () => {
    const ownerC = createOwner(3, 'A');
    bindScope(ownerC, SCOPE_A);
    registerTestIpc();
    ownerC.destroy();

    await expect(invoke(VISION_CHANNELS.permission, ownerC)).rejects.toThrow(
      'vision_renderer_unavailable',
    );
  });

  it('captures the exact owner source and emits metadata only to that owner', async () => {
    const { capture } = registerTestIpc();

    const metadata = await invoke(VISION_CHANNELS.capture, ownerA);

    expect(capture).toHaveBeenCalledWith({ mediaSourceId: 'window:nexus:A' });
    expect(ownerA.send).toHaveBeenCalledWith(
      VISION_CHANNELS.captured,
      metadata,
    );
    expect(ownerB.send).not.toHaveBeenCalled();
    expect(metadata).not.toHaveProperty('imageBase64');
    expect(metadata).not.toHaveProperty('ocrText');
  });

  it('binds consent and raw captures to owner and scope, with single-use tokens', async () => {
    registerTestIpc();
    const consentA = await invoke<{ consentToken: string }>(
      VISION_CHANNELS.setImageConsent,
      ownerA,
      { allowCloudImage: true },
    );
    await invoke(VISION_CHANNELS.capture, ownerA);

    await expect(
      invoke(VISION_CHANNELS.getImage, ownerB, {
        consentToken: consentA.consentToken,
      }),
    ).resolves.toEqual({ error: 'consent_required' });
    await expect(
      invoke(VISION_CHANNELS.getImage, ownerA, {
        consentToken: consentA.consentToken,
      }),
    ).resolves.toMatchObject({ imageBase64: IMAGE_A, sourceId: 'window:nexus:A' });
    await expect(
      invoke(VISION_CHANNELS.getImage, ownerA, {
        consentToken: consentA.consentToken,
      }),
    ).resolves.toEqual({ error: 'consent_required' });
  });

  it('does not transfer consent through global settings or clear another owner state', async () => {
    registerTestIpc();
    const consentA = await invoke<{ consentToken: string }>(
      VISION_CHANNELS.setImageConsent,
      ownerA,
      true,
    );
    await invoke(VISION_CHANNELS.capture, ownerA);

    await invoke(VISION_CHANNELS.setImageConsent, ownerB, false);
    await invoke(VISION_CHANNELS.setImageConsent, ownerB, true);

    await expect(
      invoke(VISION_CHANNELS.getImage, ownerA, {
        consentToken: consentA.consentToken,
      }),
    ).resolves.toMatchObject({ imageBase64: IMAGE_A });
    await expect(
      invoke(VISION_CHANNELS.getImage, ownerB, { consentToken: consentA.consentToken }),
    ).resolves.toEqual({ error: 'consent_required' });
  });

  it('expires owner consent tokens even while the global setting stays enabled', async () => {
    const controls = registerTestIpc();
    const consent = await invoke<{ consentToken: string }>(
      VISION_CHANNELS.setImageConsent,
      ownerA,
      true,
    );
    await invoke(VISION_CHANNELS.capture, ownerA);
    controls.advanceTime(60_001);

    await expect(
      invoke(VISION_CHANNELS.getImage, ownerA, {
        consentToken: consent.consentToken,
      }),
    ).resolves.toEqual({ error: 'consent_required' });
  });

  it('rejects a capture result whose source differs from the owner window', async () => {
    registerVisionIpc({
      capture: vi.fn(async () => captureFor('B')),
      readAxTree: vi.fn() as never,
      rateLimiter: new RateLimiter(0, 10),
    });

    await expect(invoke(VISION_CHANNELS.capture, ownerA)).rejects.toThrow(
      'vision_capture_source_mismatch',
    );
    expect(ownerA.send).not.toHaveBeenCalled();
    expect(ownerB.send).not.toHaveBeenCalled();
  });

  it('rejects a late capture when the renderer scope changes', async () => {
    const pending = deferred<ScreenCaptureResultInternal>();
    registerVisionIpc({
      capture: vi.fn(() => pending.promise),
      readAxTree: vi.fn() as never,
      rateLimiter: new RateLimiter(0, 10),
    });

    const result = invoke(VISION_CHANNELS.capture, ownerA);
    bindScope(ownerA, SCOPE_B);
    pending.resolve(captureFor('A'));

    await expect(result).rejects.toThrow('vision_authority_stale');
    expect(ownerA.send).not.toHaveBeenCalled();
    expect(ownerB.send).not.toHaveBeenCalled();
  });

  it('rejects late AX callbacks after owner destruction', async () => {
    const pending = deferred<any>();
    registerVisionIpc({
      capture: vi.fn() as never,
      readAxTree: vi.fn(() => pending.promise),
    });

    const result = invoke(VISION_CHANNELS.axTree, ownerA);
    ownerA.emit('destroyed');
    pending.resolve({ tag: 'body', role: null, aria: {}, text: 'A', children: [] });

    await expect(result).rejects.toThrow('vision_authority_stale');
  });

  it('collects context only from the invoking owner and revalidates all awaits', async () => {
    const { capture, readAxTree, ocr } = registerTestIpc();

    const context = await invoke<VisionContext>(VISION_CHANNELS.context, ownerA, {
      includeScreenshot: true,
      includeOcr: true,
    });

    expect(capture).toHaveBeenCalledWith({ mediaSourceId: 'window:nexus:A' });
    expect(readAxTree).toHaveBeenCalledWith(ownerA);
    expect(ocr).toHaveBeenCalledWith(Buffer.from(IMAGE_A, 'base64'));
    expect(context.ax.tree?.text).toBe('project-1');
    expect(context.ocr.text).toBe('image-a');
    expect(ownerB.send).not.toHaveBeenCalled();
  });

  it('accepts OCR only for the exact raw capture owned by the sender', async () => {
    const { ocr } = registerTestIpc();
    await invoke(VISION_CHANNELS.capture, ownerA);

    await expect(invoke(VISION_CHANNELS.ocr, ownerA, IMAGE_A)).resolves.toEqual({
      text: 'image-a',
      confidence: 90,
    });
    await expect(invoke(VISION_CHANNELS.ocr, ownerB, IMAGE_A)).rejects.toThrow(
      'não autorizada',
    );
    await expect(invoke(VISION_CHANNELS.ocr, ownerA, IMAGE_B)).rejects.toThrow(
      'não autorizada',
    );
    expect(ocr).toHaveBeenCalledTimes(1);
  });

  it('cleans owner authority on render-process-gone and requires a fresh generation', async () => {
    registerTestIpc();
    const consent = await invoke<{ consentToken: string }>(
      VISION_CHANNELS.setImageConsent,
      ownerA,
      true,
    );
    await invoke(VISION_CHANNELS.capture, ownerA);
    ownerA.emit('render-process-gone');

    await expect(
      invoke(VISION_CHANNELS.getImage, ownerA, {
        consentToken: consent.consentToken,
      }),
    ).resolves.toEqual({ error: 'consent_required' });
  });
});
