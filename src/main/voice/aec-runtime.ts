import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AecBackend =
  | 'wasm-aec3'
  | 'coreaudio-process-tap'
  | 'wasapi-loopback'
  | 'pipewire-monitor'
  | 'pulseaudio-monitor'
  | 'chromium-aec';

export interface AecRuntimeStatus {
  backend: AecBackend;
  native: boolean;
  degraded: boolean;
  reason: string;
  helperPath?: string;
}

export interface AecRuntimeDeps {
  platform: NodeJS.Platform;
  arch: string;
  resourcesPath?: string;
  exists: (filePath: string) => boolean;
  env: NodeJS.ProcessEnv;
}

function helperName(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'nexus-aec-macos';
  if (platform === 'win32') return 'nexus-aec-windows.exe';
  if (platform === 'linux') return 'nexus-aec-linux';
  return null;
}

function nativeBackend(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): AecBackend | null {
  if (platform === 'darwin') return 'coreaudio-process-tap';
  if (platform === 'win32') return 'wasapi-loopback';
  if (platform === 'linux') {
    return env.XDG_RUNTIME_DIR || env.PIPEWIRE_RUNTIME_DIR
      ? 'pipewire-monitor'
      : 'pulseaudio-monitor';
  }
  return null;
}

/**
 * Resolves capability only. A native backend becomes active later, after the
 * helper handshake proves protocol compatibility and processed audio arrives.
 * Merely running on macOS/Windows/Linux must never produce a false "AEC ON".
 */
export function resolveAecRuntime(deps: AecRuntimeDeps): AecRuntimeStatus {
  if (deps.env.NEXUS_AEC === '0') {
    return {
      backend: 'chromium-aec', native: false, degraded: false,
      reason: 'AEC disabled by configuration',
    };
  }
  if (deps.env.NEXUS_NATIVE_AEC === '0') {
    return {
      backend: 'wasm-aec3',
      native: false,
      degraded: false,
      reason: 'native AEC disabled; cross-platform WASM AEC3 selected',
    };
  }
  const name = helperName(deps.platform);
  const backend = nativeBackend(deps.platform, deps.env);
  if (!name || !backend) {
    return {
      backend: 'wasm-aec3',
      native: false,
      degraded: false,
      reason: `cross-platform WASM AEC3 selected for ${deps.platform}/${deps.arch}`,
    };
  }
  const root = deps.resourcesPath?.trim();
  if (!root) {
    return {
      backend: 'wasm-aec3',
      native: false,
      degraded: false,
      reason: `native ${backend} helper unavailable; WASM AEC3 selected`,
    };
  }
  const helperPath = path.join(root, 'aec', deps.platform, deps.arch, name);
  if (!deps.exists(helperPath)) {
    return {
      backend: 'wasm-aec3',
      native: false,
      degraded: false,
      reason: `native ${backend} helper not packaged; WASM AEC3 selected`,
    };
  }
  return {
    backend,
    native: true,
    degraded: false,
    reason: 'native helper available; handshake required',
    helperPath,
  };
}

export function getAecRuntimeStatus(resourcesPath?: string): AecRuntimeStatus {
  return resolveAecRuntime({
    platform: process.platform,
    arch: process.arch,
    resourcesPath,
    exists: fs.existsSync,
    env: process.env,
  });
}

export const AEC_PCM_SAMPLE_RATE = 16_000;
export const AEC_FRAME_MS = 10;
export const AEC_FRAME_SAMPLES = (AEC_PCM_SAMPLE_RATE * AEC_FRAME_MS) / 1_000;

// Keep os imported through a real runtime dependency so packaged diagnostics
// can expose the OS release without renderer fingerprinting.
export function aecPlatformLabel(): string {
  return `${process.platform}/${process.arch} ${os.release()}`;
}
