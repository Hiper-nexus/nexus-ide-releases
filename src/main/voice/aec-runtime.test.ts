import { describe, expect, it } from 'vitest';
import { AEC_FRAME_SAMPLES, resolveAecRuntime } from './aec-runtime';

function resolve(
  platform: NodeJS.Platform,
  options: { exists?: boolean; env?: NodeJS.ProcessEnv; resourcesPath?: string } = {},
) {
  return resolveAecRuntime({
    platform,
    arch: 'x64',
    resourcesPath: options.resourcesPath ?? '/app/resources',
    exists: () => options.exists ?? true,
    env: options.env ?? {},
  });
}

describe('AEC runtime selection', () => {
  it('uses Core Audio, WASAPI and PipeWire helpers behind one contract', () => {
    expect(resolve('darwin').backend).toBe('coreaudio-process-tap');
    expect(resolve('win32').backend).toBe('wasapi-loopback');
    expect(resolve('linux', { env: { XDG_RUNTIME_DIR: '/run/user/1' } }).backend)
      .toBe('pipewire-monitor');
  });

  it('selects PulseAudio monitor when Linux has no PipeWire runtime signal', () => {
    expect(resolve('linux').backend).toBe('pulseaudio-monitor');
  });

  it('uses common WASM AEC3 when the optional native helper is absent', () => {
    expect(resolve('win32', { exists: false })).toMatchObject({
      backend: 'wasm-aec3', native: false, degraded: false,
    });
  });

  it('supports an explicit native-AEC kill switch on every OS', () => {
    expect(resolve('darwin', { env: { NEXUS_NATIVE_AEC: '0' } })).toMatchObject({
      backend: 'wasm-aec3', native: false, degraded: false,
    });
  });

  it('standardizes AEC3 input as 10ms/16kHz frames', () => {
    expect(AEC_FRAME_SAMPLES).toBe(160);
  });
});
