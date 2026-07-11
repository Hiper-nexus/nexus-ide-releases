import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
} from './gpu-fallback-marker';

let dir: string;

afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('gpu-fallback-marker', () => {
  it('persists and re-reads active marker for same build on win32', () => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-gpu-marker-'));
    writeGpuFallbackMarker(
      dir,
      { engagedAt: 1000, crashesInWindow: 3 },
      {
        appVersion: '0.13.0',
        electronVersion: '43.0.0',
        platform: 'win32',
      },
    );
    const active = readActiveGpuFallbackMarker(dir, {
      appVersion: '0.13.0',
      electronVersion: '43.0.0',
      platform: 'win32',
    });
    expect(active?.crashesInWindow).toBe(3);
  });

  it('clears marker when app version changes', () => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-gpu-marker-'));
    writeGpuFallbackMarker(
      dir,
      { engagedAt: 1000, crashesInWindow: 3 },
      {
        appVersion: '0.13.0',
        electronVersion: '43.0.0',
        platform: 'win32',
      },
    );
    const active = readActiveGpuFallbackMarker(dir, {
      appVersion: '0.14.0',
      electronVersion: '43.0.0',
      platform: 'win32',
    });
    expect(active).toBeNull();
  });

  it('clear removes marker', () => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-gpu-marker-'));
    writeGpuFallbackMarker(
      dir,
      { engagedAt: 1, crashesInWindow: 3 },
      {
        appVersion: '1',
        electronVersion: '1',
        platform: 'win32',
      },
    );
    clearGpuFallbackMarker(dir);
    expect(
      readActiveGpuFallbackMarker(dir, {
        appVersion: '1',
        electronVersion: '1',
        platform: 'win32',
      }),
    ).toBeNull();
  });
});
