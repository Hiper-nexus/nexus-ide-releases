import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock electron before importing the module
vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(),
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
  },
}));

import { desktopCapturer, BrowserWindow, systemPreferences } from 'electron';
import { captureNexusWindow, getScreenPermissionStatus, assertScreenPermission } from './screen-capture';
import { ScreenRecordingPermissionDenied } from '../../shared/vision-ipc';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function mockThumbnail(width: number, height: number) {
  return {
    toPNG: () => VALID_PNG,
    getSize: () => ({ width, height }),
  };
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
}

describe('getScreenPermissionStatus', () => {
  it('returns not-determined on non-macOS', () => {
    withPlatform('linux', () => {
      expect(getScreenPermissionStatus()).toBe('not-determined');
    });
  });
});

describe('assertScreenPermission', () => {
  it('does not throw on non-macOS', () => {
    withPlatform('linux', () => {
      expect(() => assertScreenPermission()).not.toThrow();
    });
  });

  it('throws a typed error when macOS screen recording permission is denied', () => {
    withPlatform('darwin', () => {
      vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('denied' as any);
      expect(() => assertScreenPermission()).toThrow(ScreenRecordingPermissionDenied);
    });
  });
});

describe('captureNexusWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted' as any);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      {
        isDestroyed: () => false,
        getMediaSourceId: () => 'window:nexus:1',
      } as any,
    ]);
  });

  it('captures the NexusIDE window when the media source id matches exactly', async () => {
    const thumbnail = mockThumbnail(1920, 1080);
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { id: 'window:nexus:1', name: 'Renamed Window', thumbnail: thumbnail as any, appIcon: null as any, display_id: '' } as any,
      { id: 'window:finder:1', name: 'Finder', thumbnail: thumbnail as any, appIcon: null as any, display_id: '' } as any,
    ]);
    const result = await captureNexusWindow();
    expect(result.format).toBe('png');
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(Buffer.from(result.imageBase64, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(result.capturedAt).toBeTruthy();
    expect(result.sourceId).toBe('window:nexus:1');
  });

  it('rejects non-Nexus windows when no media source id matches', async () => {
    const thumbnail = mockThumbnail(640, 480);
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { id: 'window:terminal:1', name: 'Terminal', thumbnail: thumbnail as any, appIcon: null as any, display_id: '' } as any,
      { id: 'window:someapp:1', name: 'SomeApp', thumbnail: thumbnail as any, appIcon: null as any, display_id: '' } as any,
    ]);

    await expect(captureNexusWindow()).rejects.toThrow(
      'nexus_window_not_identified',
    );
  });

  it('throws when Electron returns an invalid image buffer', async () => {
    const thumbnail = {
      toPNG: () => Buffer.from('not-a-png'),
      getSize: () => ({ width: 1, height: 1 }),
    };
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { id: 'window:nexus:1', name: 'NexusIDE', thumbnail: thumbnail as any, appIcon: null as any, display_id: '' } as any,
    ]);

    await expect(captureNexusWindow()).rejects.toThrow('valid PNG');
  });

  it('throws when no windows available', async () => {
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([]);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
    await expect(captureNexusWindow()).rejects.toThrow(
      'nexus_window_not_identified',
    );
  });
});
