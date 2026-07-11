// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: userData path only;
// applied before whenReady via pure helpers.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Persisted "disable hardware acceleration for this build" marker.
 * Must be readable before app.whenReady so disableHardwareAcceleration works.
 */

export const GPU_FALLBACK_MARKER_FILE = 'gpu-fallback.json';
export const GPU_FALLBACK_SCHEME_VERSION = 2;

export type GpuFallbackEnvironment = {
  appVersion: string;
  electronVersion: string;
  platform: NodeJS.Platform;
};

export type WindowsGpuFallbackEnvironment = GpuFallbackEnvironment & {
  platform: 'win32';
};

export type GpuFallbackMarker = {
  schemeVersion: number;
  engagedAt: number;
  crashesInWindow: number;
  appVersion: string;
  electronVersion: string;
  platform: 'win32';
};

function markerPath(userDataPath: string): string {
  return join(userDataPath, GPU_FALLBACK_MARKER_FILE);
}

export function readGpuFallbackMarker(userDataPath: string): GpuFallbackMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(userDataPath), 'utf-8')) as Partial<
      Record<keyof GpuFallbackMarker, unknown>
    >;
    if (parsed.schemeVersion !== GPU_FALLBACK_SCHEME_VERSION) return null;
    if (
      typeof parsed.engagedAt !== 'number' ||
      !Number.isFinite(parsed.engagedAt) ||
      typeof parsed.crashesInWindow !== 'number' ||
      !Number.isFinite(parsed.crashesInWindow) ||
      typeof parsed.appVersion !== 'string' ||
      typeof parsed.electronVersion !== 'string' ||
      parsed.platform !== 'win32'
    ) {
      return null;
    }
    return {
      schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
      engagedAt: parsed.engagedAt,
      crashesInWindow: parsed.crashesInWindow,
      appVersion: parsed.appVersion,
      electronVersion: parsed.electronVersion,
      platform: 'win32',
    };
  } catch {
    // missing or corrupt
  }
  return null;
}

export function writeGpuFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number },
  environment: WindowsGpuFallbackEnvironment,
): void {
  const marker: GpuFallbackMarker = {
    schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
    engagedAt: info.engagedAt,
    crashesInWindow: info.crashesInWindow,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: 'win32',
  };
  writeFileSync(markerPath(userDataPath), JSON.stringify(marker));
}

export function clearGpuFallbackMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true });
  } catch {
    // best effort
  }
}

export function readActiveGpuFallbackMarker(
  userDataPath: string,
  environment: GpuFallbackEnvironment,
): GpuFallbackMarker | null {
  const marker = readGpuFallbackMarker(userDataPath);
  if (!marker) {
    if (existsSync(markerPath(userDataPath))) {
      clearGpuFallbackMarker(userDataPath);
    }
    return null;
  }
  if (
    environment.platform !== 'win32' ||
    marker.platform !== environment.platform ||
    marker.appVersion !== environment.appVersion ||
    marker.electronVersion !== environment.electronVersion
  ) {
    // Sticky only for the build that observed the driver crash burst.
    clearGpuFallbackMarker(userDataPath);
    return null;
  }
  return marker;
}
