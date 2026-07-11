import { EventEmitter } from 'node:events';
import {
  AEC_FRAME_SAMPLES,
  type AecRuntimeStatus,
} from './aec-runtime';
import {
  AEC_PROTOCOL_VERSION,
  AecProtocolDecoder,
  createAecHello,
  encodeAecFrame,
  pcm16Payload,
} from './aec-protocol';

export interface AecHelperTransport {
  write(data: Buffer): boolean;
  close(): void;
  onData(listener: (data: Buffer) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
}

export interface AecHelperClientOptions {
  runtime: AecRuntimeStatus;
  transport: AecHelperTransport;
  handshakeTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface AecHelperMetrics {
  erl?: number;
  erle?: number;
  delayMs?: number;
  renderUnderruns?: number;
  renderOverruns?: number;
}

/** Owns protocol, liveness and backpressure. It cannot claim native AEC ready
 * until a versioned hello-ack is received from the packaged helper. */
export class AecHelperClient extends EventEmitter {
  private readonly decoder = new AecProtocolDecoder();
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposers: Array<() => void> = [];
  private ready = false;
  private stopped = false;
  private droppedFrames = 0;

  constructor(private readonly options: AecHelperClientOptions) {
    super();
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get isReady(): boolean { return this.ready && !this.stopped; }
  get dropped(): number { return this.droppedFrames; }

  start(): void {
    if (this.stopped || this.disposers.length > 0) return;
    if (!this.options.runtime.native || !this.options.runtime.helperPath) {
      this.emit('degraded', this.options.runtime.reason);
      return;
    }
    this.disposers = [
      this.options.transport.onData((chunk) => this.onData(chunk)),
      this.options.transport.onExit((error) => this.fail(error ?? new Error('AEC helper exited'))),
    ];
    const hello = Buffer.from(JSON.stringify(createAecHello(this.options.runtime.backend)));
    this.options.transport.write(encodeAecFrame({ type: 1, payload: hello }));
    this.timer = this.setTimer(() => this.fail(new Error('AEC helper handshake timeout')), this.options.handshakeTimeoutMs ?? 2_000);
    this.timer.unref?.();
  }

  offerCapture(samples: Int16Array): boolean { return this.offerPcm(3, samples); }
  offerRender(samples: Int16Array): boolean { return this.offerPcm(4, samples); }

  stop(): void {
    if (this.stopped) return;
    if (this.ready) this.options.transport.write(encodeAecFrame({ type: 8, payload: Buffer.alloc(0) }));
    this.stopped = true;
    this.ready = false;
    this.clearHandshakeTimer();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.options.transport.close();
  }

  private offerPcm(type: 3 | 4, samples: Int16Array): boolean {
    if (!this.isReady || samples.length !== AEC_FRAME_SAMPLES) return false;
    const accepted = this.options.transport.write(encodeAecFrame({ type, payload: pcm16Payload(samples) }));
    if (!accepted) this.droppedFrames += 1;
    return accepted;
  }

  private onData(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.type === 2) {
          const ack = JSON.parse(frame.payload.toString()) as { protocolVersion?: number; ready?: boolean };
          if (ack.protocolVersion !== AEC_PROTOCOL_VERSION || ack.ready !== true) {
            throw new Error('AEC helper rejected handshake');
          }
          this.ready = true;
          this.clearHandshakeTimer();
          this.emit('ready');
        } else if (frame.type === 5) {
          if (!this.ready || frame.payload.byteLength !== AEC_FRAME_SAMPLES * 2) continue;
          const copy = Buffer.from(frame.payload);
          this.emit('processed', new Int16Array(copy.buffer, copy.byteOffset, AEC_FRAME_SAMPLES));
        } else if (frame.type === 6) {
          this.emit('metrics', JSON.parse(frame.payload.toString()) as AecHelperMetrics);
        } else if (frame.type === 7) {
          const detail = JSON.parse(frame.payload.toString()) as { error?: string };
          throw new Error(detail.error || 'AEC helper error');
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.emit('error', error);
    this.stop();
  }

  private clearHandshakeTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
