import pcmWorkletUrl from './pcm-processor.js?url';

/**
 * Microphone capture for push-to-talk. Opens a 16 kHz mono getUserMedia stream,
 * accumulates Float32 PCM via an AudioWorklet (with a ScriptProcessorNode
 * fallback), and on stop encodes a 16 kHz PCM16 WAV that the main process feeds
 * to the STT provider. Capture only ever runs between start() and stop() — the
 * stream + audio graph are fully torn down on stop, so the mic is never hot idle.
 */

const TARGET_SAMPLE_RATE = 16_000;

export interface CaptureResult {
  wavBase64: string;
  sampleRate: number;
  /** Total captured audio in seconds (0 when nothing was recorded). */
  durationSec: number;
}

export class VoiceCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private inputSampleRate = TARGET_SAMPLE_RATE;
  private capturing = false;

  isCapturing(): boolean {
    return this.capturing;
  }

  async start(): Promise<void> {
    if (this.capturing) return;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.inputSampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);

    const onFrame = (frame: Float32Array) => {
      if (this.capturing) this.chunks.push(frame);
    };

    try {
      await this.ctx.audioWorklet.addModule(pcmWorkletUrl);
      const node = new AudioWorkletNode(this.ctx, 'nexus-pcm-processor');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
      this.source.connect(node);
      // Keep the graph pulling without routing mic to speakers.
      node.connect(this.ctx.destination);
      this.worklet = node;
    } catch {
      // AudioWorklet unavailable (older runtime / CSP): fall back to the
      // deprecated ScriptProcessorNode, which needs no external module.
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0).slice(0));
      this.source.connect(node);
      node.connect(this.ctx.destination);
      this.scriptNode = node;
    }

    this.capturing = true;
  }

  async stop(): Promise<CaptureResult> {
    if (!this.capturing) {
      return { wavBase64: '', sampleRate: TARGET_SAMPLE_RATE, durationSec: 0 };
    }
    this.capturing = false;
    this.teardown();

    const pcm = mergeChunks(this.chunks);
    this.chunks = [];
    const downsampled = downsample(pcm, this.inputSampleRate, TARGET_SAMPLE_RATE);
    const wav = encodeWav(downsampled, TARGET_SAMPLE_RATE);
    return {
      wavBase64: bytesToBase64(wav),
      sampleRate: TARGET_SAMPLE_RATE,
      durationSec: downsampled.length / TARGET_SAMPLE_RATE,
    };
  }

  private teardown(): void {
    try {
      this.worklet?.disconnect();
      this.scriptNode?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      void this.ctx?.close();
    } catch {
      // best-effort teardown; nothing actionable if a node is already gone.
    }
    this.worklet = null;
    this.scriptNode = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

// ── PCM helpers (pure) ───────────────────────────────────────────────────────

export function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Linear-interpolation resample from `inRate` to `outRate`. */
export function downsample(
  input: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Encode mono Float32 [-1,1] PCM as a 16-bit WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/** Base64-encode bytes in chunks to avoid blowing the call stack on large input. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
