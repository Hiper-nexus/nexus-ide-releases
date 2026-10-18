import { useVoiceStore } from './voice-store';

/**
 * Nível do áudio de SAÍDA (a voz da Jarvis): um AnalyserNode inserido na saída
 * dos players (classic TTS e Live PCM) publica o RMS suavizado em
 * `voice-store.outputLevel` enquanto o status é `speaking` — a figura de
 * partículas do HUD se move com a própria fala, não só com o microfone.
 * A parte numérica é pura e exportada para teste sem WebAudio.
 */

/** Ganho do RMS: voz TTS fica tipicamente em ~0.05–0.25; 4x lê como nível [0,1]. */
export const OUTPUT_LEVEL_GAIN = 4;
/** Suavização por quadro: sobe rápido (ataca junto com a sílaba). */
export const OUTPUT_LEVEL_ATTACK = 0.55;
/** ...e desce devagar (a cauda da sílaba não pisca). */
export const OUTPUT_LEVEL_RELEASE = 0.18;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** RMS de um buffer de amostras [-1,1] (0 se vazio). */
export function rmsOf(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

/** Alvo de nível [0,1] para um RMS bruto. */
export function outputLevelTarget(rms: number): number {
  return clamp01(rms * OUTPUT_LEVEL_GAIN);
}

/** Um passo de suavização em direção ao alvo (ataque ou liberação). */
export function smoothOutputLevel(previous: number, target: number): number {
  const k = target > previous ? OUTPUT_LEVEL_ATTACK : OUTPUT_LEVEL_RELEASE;
  return previous + (target - previous) * k;
}

interface TapEntry {
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  taps: number;
}

/**
 * Um medidor por processo: `tap` insere a fonte no caminho de saída
 * (`source → analyser → ctx.destination`) e devolve a soltura; o loop rAF lê o
 * RMS e publica em `voice-store.outputLevel` só enquanto o status é
 * `speaking` (fora dele publica 0). Um AnalyserNode por AudioContext — o
 * classic cria um contexto por playback, o Live mantém o próprio.
 */
export class OutputLevelMeter {
  private entries = new Map<AudioContext, TapEntry>();
  private raf = 0;
  private smooth = 0;

  tap(ctx: AudioContext, source: AudioNode): () => void {
    let entry = this.entries.get(ctx);
    if (!entry) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; // ~10 ms @48k: RMS responsivo e barato por quadro
      analyser.connect(ctx.destination);
      entry = { analyser, samples: new Float32Array(analyser.fftSize), taps: 0 };
      this.entries.set(ctx, entry);
      if (!this.raf) this.raf = requestAnimationFrame(this.loop);
    }
    source.connect(entry.analyser);
    entry.taps += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      const current = this.entries.get(ctx);
      if (!current) return;
      current.taps -= 1;
      try {
        source.disconnect(current.analyser);
      } catch {
        // contexto já fechado
      }
      if (current.taps <= 0) this.removeEntry(ctx, current);
    };
  }

  private removeEntry(ctx: AudioContext, entry: TapEntry): void {
    try {
      entry.analyser.disconnect();
    } catch {
      // contexto já fechado
    }
    this.entries.delete(ctx);
    if (this.entries.size === 0 && this.smooth !== 0) {
      this.smooth = 0;
      useVoiceStore.getState().setOutputLevel(0);
    }
  }

  private loop = (): void => {
    if (this.entries.size === 0) {
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
    const { status, setOutputLevel } = useVoiceStore.getState();
    if (status !== 'speaking') {
      if (this.smooth !== 0) {
        this.smooth = 0;
        setOutputLevel(0);
      }
      return;
    }
    // Soma as energias de todos os contextos ativos (classic + live raramente
    // soam juntos; somar evita que um silencie o outro).
    let target = 0;
    for (const entry of this.entries.values()) {
      entry.analyser.getFloatTimeDomainData(entry.samples);
      target += outputLevelTarget(rmsOf(entry.samples));
    }
    this.smooth = smoothOutputLevel(this.smooth, clamp01(target));
    setOutputLevel(this.smooth);
  };
}

/** Medidor único da voz da Jarvis (classic TTS + Live PCM). */
export const jarvisOutputMeter = new OutputLevelMeter();
