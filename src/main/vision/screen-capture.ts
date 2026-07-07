/**
 * Screen capture module — Fase 5 Jarvis Vision.
 * Captures the Nexus IDE window using desktopCapturer.
 */
import { desktopCapturer, BrowserWindow, systemPreferences } from 'electron';
import type { ScreenCaptureResult, ScreenPermissionStatus } from '../../shared/vision-ipc';
import { ScreenRecordingPermissionDenied } from '../../shared/vision-ipc';

/** Resolve screen permission via macOS systemPreferences. */
export function getScreenPermissionStatus(): ScreenPermissionStatus {
  if (process.platform !== 'darwin') {
    // On non-macOS, desktopCapturer prompts the OS directly.
    return 'not-determined';
  }
  const status = systemPreferences.getMediaAccessStatus('screen');
  return status as ScreenPermissionStatus;
}

/** Ensure screen recording permission is granted. Throws if denied. */
export function assertScreenPermission(): void {
  if (process.platform !== 'darwin') return;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'denied' || status === 'restricted') {
    throw new ScreenRecordingPermissionDenied();
  }
}

/**
 * Capture the Nexus IDE window as a PNG buffer.
 * Filters sources by window name matching "NexusIDE" and falls back
 * to the focused window.
 */
export async function captureNexusWindow(): Promise<ScreenCaptureResult> {
  assertScreenPermission();

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false,
  });

  // Strategy 1: match by window name
  let source = sources.find((s) => s.name.includes('NexusIDE'));

  // Strategy 2: fallback to focused window
  if (!source) {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      const title = focused.getTitle();
      source = sources.find((s) => s.name === title);
    }
  }

  // Strategy 3: any window with a non-empty name (last resort)
  if (!source) {
    source = sources.find((s) => s.name.length > 0);
  }

  if (!source) {
    throw new Error('Nenhuma janela encontrada para captura.');
  }

  const thumbnail = source.thumbnail;
  const size = thumbnail.getSize();
  const imageBuffer = thumbnail.toPNG();

  return {
    imageBase64: imageBuffer.toString('base64'),
    format: 'png',
    width: size.width,
    height: size.height,
    capturedAt: new Date().toISOString(),
  };
}