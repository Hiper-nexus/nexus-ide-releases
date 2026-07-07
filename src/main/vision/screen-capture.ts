/**
 * Screen capture module — Fase 5 Jarvis Vision.
 * Captures the Nexus IDE window using desktopCapturer.
 */
import { desktopCapturer, BrowserWindow, systemPreferences } from 'electron';
import type {
  ScreenCaptureResultInternal,
  ScreenPermissionStatus,
} from '../../shared/vision-ipc';
import { ScreenRecordingPermissionDenied } from '../../shared/vision-ipc';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)
  );
}

function nexusWindowSourceIds(): Set<string> {
  const ids = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => window.getMediaSourceId())
    .filter((id) => id.length > 0);
  return new Set(ids);
}

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
 * Matches Electron's canonical media source id for an app-owned BrowserWindow.
 */
export async function captureNexusWindow(): Promise<ScreenCaptureResultInternal> {
  assertScreenPermission();
  const expectedSourceIds = nexusWindowSourceIds();

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false,
  });

  let source = sources.find((candidate) => expectedSourceIds.has(candidate.id));

  if (!source && process.env.NEXUS_VISION_DEBUG_ALLOW_NAME_MATCH === '1') {
    source = sources.find((candidate) => candidate.name.includes('NexusIDE'));
    if (source) {
      console.warn(
        '[vision] NEXUS_VISION_DEBUG_ALLOW_NAME_MATCH matched source by name; do not enable in release.',
      );
    }
  }

  if (!source) {
    throw new Error('nexus_window_not_identified');
  }

  const thumbnail = source.thumbnail;
  const size = thumbnail.getSize();
  const imageBuffer = thumbnail.toPNG();
  if (!isPng(imageBuffer)) {
    throw new Error('Screen capture did not return a valid PNG image.');
  }

  return {
    imageBase64: imageBuffer.toString('base64'),
    format: 'png',
    width: size.width,
    height: size.height,
    capturedAt: new Date().toISOString(),
    sourceId: source.id,
  };
}
