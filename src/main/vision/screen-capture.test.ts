import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock electron before importing the module
vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
  },
}));

import { desktopCapturer, BrowserWindow } from 'electron';
import { captureNexusWindow, getScreenPermissionStatus, assertScreenPermission } from './screen-capture';

describe('getScreenPermissionStatus', () => {
  it('returns not-determined on non-macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(getScreenPermissionStatus()).toBe('not-determined');
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});

describe('assertScreenPermission', () => {
  it('does not throw on non-macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => assertScreenPermission()).not.toThrow();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});

describe('captureNexusWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures the NexusIDE window by name', async () => {
    const mockThumbnail = {
      toPNG: () => Buffer.from('fake-png'),
      getSize: () => ({ width: 1920, height: 1080 }),
    };
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { id: 'w1', name: 'NexusIDE', thumbnail: mockThumbnail as any, appIcon: null as any, display_id: '' } as any,
      { id: 'w2', name: 'Finder', thumbnail: mockThumbnail as any, appIcon: null as any, display_id: '' } as any,
    ]);
    const result = await captureNexusWindow();
    expect(result.format).toBe('png');
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.imageBase64).toBe('ZmFrZS1wbmc='); // base64 of "fake-png"
    expect(result.capturedAt).toBeTruthy();
  });

  it('falls back to focused window when no name match', async () => {
    const mockThumbnail = {
      toPNG: () => Buffer.from('fake-png'),
      getSize: () => ({ width: 800, height: 600 }),
    };
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { id: 'w1', name: 'Terminal', thumbnail: mockThumbnail as any, appIcon: null as any, display_id: '' } as any,
    ]);
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({
      getTitle: () => 'Terminal',
    } as any);
    const result = await captureNexusWindow();
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  it('falls back to any window with non-empty name', async () => {
    const mockThumbnail = {
      toPNG: () => Buffer.from('fake-png'),
      getSize: () => ({ width: 640, height: 480 }),
    };
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { id: 'w1', name: '', thumbnail: mockThumbnail as any, appIcon: null as any, display_id: '' } as any,
      { id: 'w2', name: 'SomeApp', thumbnail: mockThumbnail as any, appIcon: null as any, display_id: '' } as any,
    ]);
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
    const result = await captureNexusWindow();
    expect(result.width).toBe(640);
  });

  it('throws when no windows available', async () => {
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([]);
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
    await expect(captureNexusWindow()).rejects.toThrow('Nenhuma janela encontrada');
  });
});