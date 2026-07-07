import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VISION_CHANNELS } from '../../shared/vision-ipc';
import type { ScreenCaptureResultInternal } from '../../shared/vision-ipc';
import { RateLimiter } from './rate-limiter';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const send = vi.fn();
  const webContents = {
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    send,
  };

  return {
    handlers,
    send,
    ipcMain: {
      handle: vi.fn(
        (channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        },
      ),
    },
    BrowserWindow: {
      getAllWindows: vi.fn(() => [{ webContents }]),
      getFocusedWindow: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  BrowserWindow: electronMock.BrowserWindow,
}));

import {
  registerVisionIpc,
  resetVisionIpcStateForTest,
} from './ipc-bridge';

const TOKEN = '00000000-0000-4000-8000-000000000000';
const CAPTURE: ScreenCaptureResultInternal = {
  imageBase64: 'raw-image',
  ocrText: 'secret text',
  format: 'png',
  width: 1200,
  height: 800,
  capturedAt: '2026-07-07T12:00:00.000Z',
  sourceId: 'window:nexus:1',
};

async function invoke<T>(channel: string, raw?: unknown): Promise<T> {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing handler for ${channel}`);
  return (await handler({}, raw)) as T;
}

function registerTestIpc(initialAllowCloudImage = false): {
  allowCloudImage: (value: boolean) => void;
} {
  let allowCloudImage = initialAllowCloudImage;

  registerVisionIpc({
    capture: vi.fn(async () => CAPTURE),
    readAxTree: vi.fn(async () => ({
      tag: 'body',
      role: null,
      aria: {},
      text: null,
      children: [],
    })),
    ocr: vi.fn(async () => ({ text: 'ocr', confidence: 90 })),
    getScreenPermissionStatus: () => 'granted',
    getVisionSettings: () => ({ allowCloudImage }),
    setVisionSettings: (patch) => {
      allowCloudImage = patch.allowCloudImage ?? allowCloudImage;
      return { allowCloudImage };
    },
    createConsentToken: () => TOKEN,
    rateLimiter: new RateLimiter(0, 10),
  });

  return {
    allowCloudImage: (value: boolean) => {
      allowCloudImage = value;
    },
  };
}

describe('registerVisionIpc', () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.send.mockClear();
    electronMock.ipcMain.handle.mockClear();
    resetVisionIpcStateForTest();
  });

  it('emits safe metadata for vision:captured without imageBase64 or ocrText', async () => {
    registerTestIpc();

    const result = await invoke(VISION_CHANNELS.capture);
    const payload = electronMock.send.mock.calls[0]?.[1];

    expect(result).toEqual({
      format: 'png',
      width: 1200,
      height: 800,
      capturedAt: '2026-07-07T12:00:00.000Z',
      sourceId: 'window:nexus:1',
      hasImage: true,
      hasOcr: true,
    });
    expect(electronMock.send).toHaveBeenCalledWith(
      VISION_CHANNELS.captured,
      result,
    );
    expect(payload).not.toHaveProperty('imageBase64');
    expect(payload).not.toHaveProperty('ocrText');
  });

  it('returns consent_required from vision:getImage when allowCloudImage is false', async () => {
    const controls = registerTestIpc(true);
    const consent = await invoke<{ consentToken: string }>(
      VISION_CHANNELS.setImageConsent,
      { allowCloudImage: true },
    );
    await invoke(VISION_CHANNELS.capture);

    controls.allowCloudImage(false);

    await expect(
      invoke(VISION_CHANNELS.getImage, {
        consentToken: consent.consentToken,
      }),
    ).resolves.toEqual({ error: 'consent_required' });
  });

  it('returns consent_required from vision:getImage when consentToken is invalid', async () => {
    registerTestIpc();
    await invoke(VISION_CHANNELS.setImageConsent, { allowCloudImage: true });
    await invoke(VISION_CHANNELS.capture);

    await expect(
      invoke(VISION_CHANNELS.getImage, { consentToken: 'bad-token' }),
    ).resolves.toEqual({ error: 'consent_required' });
  });

  it('returns imageBase64 from vision:getImage when settings and consentToken are valid', async () => {
    registerTestIpc();
    const consent = await invoke<{ consentToken: string }>(
      VISION_CHANNELS.setImageConsent,
      { allowCloudImage: true },
    );
    await invoke(VISION_CHANNELS.capture);

    await expect(
      invoke(VISION_CHANNELS.getImage, {
        consentToken: consent.consentToken,
      }),
    ).resolves.toEqual({
      imageBase64: 'raw-image',
      format: 'png',
      width: 1200,
      height: 800,
      capturedAt: '2026-07-07T12:00:00.000Z',
      sourceId: 'window:nexus:1',
    });
  });
});
