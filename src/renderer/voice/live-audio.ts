/**
 * Jarvis Live (realtime) — áudio no renderer. Toca o PCM 24 kHz que desce do
 * transporte Gemini Live e converte frames do mic (Float32) para PCM 16 kHz
 * base64 que sobe pro main. Os helpers de conversão são puros e testados; a
 * borda WebAudio (LiveAudioPlayer) só é exercida em runtime.
 */

const OUTPUT_SAMPLE_RATE = 24_000;
const INPUT_SAMPLE_RATE = 16_000;

/** Float32 [-1,1] → Int16 LE bytes. */
export function floatToInt16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(clamped * 0x7fff), true);
  }
  return out;
}

/** Int16 LE bytes → Float32 [-1,1]. */
export function int16BytesToFloat(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 0x7fff;
  }
  return out;
}

/** Downsample linear (nearest) de srcRate → dstRate. */
export function downsampleFloat(
  input: Float32Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    out[i] = input[Math.floor(i * ratio)] ?? 0;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Frame de mic (Float32, qualquer sample rate) → PCM 16 kHz base64. */
export function micFrameToBase64(
  frame: Float32Array,
  srcRate: number,
): string {
  const down = downsampleFloat(frame, srcRate, INPUT_SAMPLE_RATE);
  return bytesToBase64(floatToInt16Bytes(down));
}

/**
 * DEFECT 2: ms de áudio realtime AINDA agendado (do relógio atual até o fim da
 * fila gapless). Cada chunk é agendado em `nextStartAt`, então a supressão de
 * wake precisa cobrir a fila INTEIRA — não só a duração de um chunk. Sem isto,
 * um flush de N chunks (~20s) suprimia só ~1 chunk+cauda e o detector reabria no
 * meio da própria fala realtime (ela acorda na própria voz). Puro/testável.
 */
export function scheduledTailMs(nextStartAt: number, currentTime: number): number {
  const remaining = nextStartAt - currentTime;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.ceil(remaining * 1_000);
}

/**
 * Fila de reprodução do áudio realtime: enfileira chunks PCM 24 kHz na
 * timeline do AudioContext para tocar contínuo sem gaps. barge-in limpa a fila.
 */
export class LiveAudioPlayer {
  private ctx: AudioContext | null = null;
  private nextStartAt = 0;
  private active: AudioBufferSourceNode[] = [];

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    }
    return this.ctx;
  }

  /** Enfileira um chunk PCM 24 kHz e devolve os ms de áudio AINDA agendado
   *  (chunk atual + tudo já na fila gapless), para o chamador suprimir o wake
   *  pela fila INTEIRA — não só por um chunk (DEFECT 2). 0 se vazio. */
  play(b64: string): number {
    const floats = int16BytesToFloat(base64ToBytes(b64));
    if (floats.length === 0) return 0;
    const ctx = this.context();
    const buffer = ctx.createBuffer(1, floats.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(floats);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextStartAt);
    source.start(startAt);
    this.nextStartAt = startAt + buffer.duration;
    this.active.push(source);
    source.onended = () => {
      this.active = this.active.filter((s) => s !== source);
    };
    return scheduledTailMs(this.nextStartAt, ctx.currentTime);
  }

  /** Ms ainda agendados na fila gapless (0 se vazia / sem contexto). */
  remainingMs(): number {
    if (!this.ctx) return 0;
    return scheduledTailMs(this.nextStartAt, this.ctx.currentTime);
  }

  /** barge-in: corta tudo que está soando e zera a timeline. */
  stop(): void {
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        // já parou
      }
    }
    this.active = [];
    this.nextStartAt = this.ctx?.currentTime ?? 0;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
