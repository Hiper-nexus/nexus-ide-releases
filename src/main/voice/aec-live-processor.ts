import type { AecHelperClient } from './aec-helper-client';
import { AEC_FRAME_SAMPLES } from './aec-runtime';

export interface LiveAecProcessor {
  capture(samples: Int16Array, sink: (processed: Int16Array) => void): void;
  render24k(samples: Int16Array): void;
  reset(): void;
}

interface PendingCapture {
  generation: number;
  sink: (processed: Int16Array) => void;
}

/** Dynamic bridge shared across controller recreation. Every accepted native
 * capture frame owns one sink; reset invalidates late frames on session change. */
export class AecLiveProcessor implements LiveAecProcessor {
  private captureTail: Int16Array<ArrayBufferLike> = new Int16Array(0);
  private renderTail: Int16Array<ArrayBufferLike> = new Int16Array(0);
  private pending: PendingCapture[] = [];
  private generation = 0;

  constructor(private readonly client: AecHelperClient) {
    client.on('processed', (samples: Int16Array) => {
      const owner = this.pending.shift();
      if (!owner || owner.generation !== this.generation) return;
      owner.sink(samples.slice());
    });
  }

  capture(samples: Int16Array, sink: (processed: Int16Array) => void): void {
    if (!this.client.isReady) {
      sink(samples);
      return;
    }
    this.captureTail = append(this.captureTail, samples);
    while (this.captureTail.length >= AEC_FRAME_SAMPLES) {
      const frame = this.captureTail.slice(0, AEC_FRAME_SAMPLES);
      this.captureTail = this.captureTail.slice(AEC_FRAME_SAMPLES);
      if (this.client.offerCapture(frame)) {
        this.pending.push({ generation: this.generation, sink });
      } else {
        sink(frame);
      }
    }
  }

  render24k(samples: Int16Array): void {
    if (!this.client.isReady || samples.length === 0) return;
    const down = resample24To16(samples);
    this.renderTail = append(this.renderTail, down);
    while (this.renderTail.length >= AEC_FRAME_SAMPLES) {
      const frame = this.renderTail.slice(0, AEC_FRAME_SAMPLES);
      this.renderTail = this.renderTail.slice(AEC_FRAME_SAMPLES);
      this.client.offerRender(frame);
    }
  }

  reset(): void {
    this.generation += 1;
    this.pending = [];
    this.captureTail = new Int16Array(0);
    this.renderTail = new Int16Array(0);
  }
}

function append(
  left: Int16Array<ArrayBufferLike>,
  right: Int16Array<ArrayBufferLike>,
): Int16Array<ArrayBufferLike> {
  const out = new Int16Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

function resample24To16(samples: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(samples.length * 2 / 3));
  for (let i = 0; i < out.length; i += 1) {
    const source = i * 1.5;
    const left = Math.floor(source);
    const fraction = source - left;
    const a = samples[left] ?? 0;
    const b = samples[Math.min(left + 1, samples.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}
