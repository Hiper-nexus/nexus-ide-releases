import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { LiveAecProcessor } from './aec-live-processor';

type AecInstance = Awaited<ReturnType<typeof WebRtcAec3>>['AEC3'] extends new (...args: never[]) => infer T ? T : never;

// Emscripten installs process-level rejection/exception hooks per module
// creation. Share one module for the process; individual AEC3 instances are
// still freed on voice runtime teardown. It is compiled on first use, not at
// import: the app boot must not pay for the WASM when nobody is talking.
const require = createRequire(__filename);
const loadAecModule = WebRtcAec3 as unknown as (
  options?: { wasmBinary?: Uint8Array },
) => ReturnType<typeof WebRtcAec3>;
let sharedAecModule: ReturnType<typeof WebRtcAec3> | null = null;

function aecModule(): ReturnType<typeof WebRtcAec3> {
  if (!sharedAecModule) {
    try {
      const wasmBinary = readFileSync(
        require.resolve('@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm'),
      );
      sharedAecModule = loadAecModule({ wasmBinary });
    } catch (error) {
      sharedAecModule = Promise.reject(error) as ReturnType<typeof WebRtcAec3>;
    }
  }
  return sharedAecModule;
}

function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 32768;
  return out;
}

function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(value * (value < 0 ? 32768 : 32767));
  }
  return out;
}

/** Same WebRTC AEC3 core on macOS, Windows and Linux. It uses provider PCM as
 * far-end reference, so no OS loopback permission is required for Jarvis's own
 * voice. Initialization and any runtime failure fail open to original mic PCM. */
export class WasmAecProcessor implements LiveAecProcessor {
  private aec: AecInstance | null = null;
  private generation = 0;
  private failed = false;

  constructor(
    private readonly onReady?: () => void,
    private readonly onError?: (error: Error) => void,
  ) {
    void aecModule()
      .then((module) => {
        if (this.failed) return;
        this.aec = new module.AEC3(48_000, 1, 1) as AecInstance;
        this.onReady?.();
      })
      .catch((error) => this.fail(error));
  }

  get isReady(): boolean { return this.aec !== null && !this.failed; }

  capture(samples: Int16Array, sink: (processed: Int16Array) => void): void {
    const aec = this.aec;
    if (!aec || this.failed) {
      sink(samples);
      return;
    }
    const generation = this.generation;
    try {
      const input = [int16ToFloat(samples)];
      const options = { sampleRateIn: 16_000, sampleRateOut: 16_000 };
      const size = aec.processSize(input, options);
      const output = [new Float32Array(size)];
      aec.process(output, input, options);
      if (generation === this.generation && output[0].length > 0) {
        sink(floatToInt16(output[0]));
      }
    } catch (error) {
      this.fail(error);
      sink(samples);
    }
  }

  render24k(samples: Int16Array): void {
    const aec = this.aec;
    if (!aec || this.failed || samples.length === 0) return;
    try {
      aec.analyze([int16ToFloat(samples)], { sampleRateIn: 24_000 });
    } catch (error) {
      this.fail(error);
    }
  }

  reset(): void {
    this.generation += 1;
  }

  dispose(): void {
    this.failed = true;
    this.generation += 1;
    this.aec?.free();
    this.aec = null;
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.aec?.free();
    this.aec = null;
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Voice registration creates the AEC runtime at app boot, but most sessions
 * never capture audio. This defers the WASM compile and the AEC3 instance
 * (~10 MB) to the first frame; until the real processor is ready it fails
 * open to the original PCM, exactly like WasmAecProcessor while it loads.
 */
export class LazyWasmAecProcessor implements LiveAecProcessor {
  private inner: WasmAecProcessor | null = null;
  private disposed = false;

  constructor(private readonly create: () => WasmAecProcessor) {}

  capture(samples: Int16Array, sink: (processed: Int16Array) => void): void {
    const processor = this.processor();
    if (!processor) {
      sink(samples);
      return;
    }
    processor.capture(samples, sink);
  }

  render24k(samples: Int16Array): void {
    this.processor()?.render24k(samples);
  }

  reset(): void {
    this.inner?.reset();
  }

  dispose(): void {
    this.disposed = true;
    this.inner?.dispose();
    this.inner = null;
  }

  private processor(): WasmAecProcessor | null {
    if (this.disposed) return null;
    this.inner ??= this.create();
    return this.inner;
  }
}
