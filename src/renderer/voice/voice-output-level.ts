import { useVoiceStore } from './voice-store';

/**
 * Nível do áudio de SAÍDA (a voz da Jarvis): um AnalyserNode inserido na saída
 * dos players (classic TTS e Live PCM) publica o RMS suavizado em
 * `voice-store.outputLevel` enquanto o status é `speaking` — a figura de
 * partículas do HUD se move com a própria fala, não só com o microfone.
 *
 * Além do volume sai o "brilho" do espectro (`outputBrightness`): a fração da
 * energia nos agudos (2–6 kHz: e, i, s, x) contra a dos formantes graves
 * (200–1100 Hz: a, o, u). É o que dá forma à boca: vogal aberta abre a boca,
 * chiado a estica. E o par é publicado ATRASADO pela latência de saída do
 * contexto: o analisador lê a amostra antes de ela sair do alto-falante, e sem
 * o atraso a boca andava à frente da voz (fone Bluetooth chega a 200 ms).
 * A parte numérica é pura e exportada para teste sem WebAudio.
 */

/** Ganho do RMS: voz TTS fica tipicamente em ~0.05–0.25; 4x lê como nível [0,1]. */
export const OUTPUT_LEVEL_GAIN = 4;
/** Suavização por quadro: sobe rápido (ataca junto com a sílaba). */
export const OUTPUT_LEVEL_ATTACK = 0.55;
/** ...e desce devagar (a cauda da sílaba não pisca). */
export const OUTPUT_LEVEL_RELEASE = 0.18;
/** Suavização do brilho: a forma da boca muda por fonema, não por amostra. */
export const OUTPUT_BRIGHTNESS_SMOOTHING = 0.35;
/**
 * Nível mínimo para o espectro valer: abaixo disso é cauda, respiração ou
 * chiado de fundo, e o brilho volta a 0 (boca neutra) em vez de esticá-la.
 */
export const OUTPUT_BRIGHTNESS_MIN_LEVEL = 0.08;
/** Teto da compensação de latência: acima disso o dado é suspeito. */
export const OUTPUT_LATENCY_MAX_MS = 350;

/** Faixas do brilho (Hz): formantes graves × agudos/fricativas. */
const LOW_BAND_HZ: readonly [number, number] = [200, 1100];
const HIGH_BAND_HZ: readonly [number, number] = [2000, 6000];

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

function bandPower(dbBins: ArrayLike<number>, binHz: number, band: readonly [number, number]): number {
  const from = Math.max(0, Math.floor(band[0] / binHz));
  const to = Math.min(dbBins.length - 1, Math.ceil(band[1] / binHz));
  let power = 0;
  for (let i = from; i <= to; i += 1) {
    const db = dbBins[i] ?? -Infinity;
    if (Number.isFinite(db)) power += 10 ** (db / 10);
  }
  return power;
}

/**
 * Brilho espectral [0,1] a partir do espectro em dB (`getFloatFrequencyData`):
 * 0 = energia toda nos formantes graves (a, o), 1 = toda nos agudos (s, i).
 * Sem energia nenhuma (silêncio) devolve 0 — boca neutra, não esticada.
 */
export function spectralBrightness(
  dbBins: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
): number {
  if (dbBins.length === 0 || sampleRate <= 0 || fftSize <= 0) return 0;
  const binHz = sampleRate / fftSize;
  const low = bandPower(dbBins, binHz, LOW_BAND_HZ);
  const high = bandPower(dbBins, binHz, HIGH_BAND_HZ);
  const total = low + high;
  if (!(total > 0)) return 0;
  // A voz tem quase toda a energia nos graves: a razão crua mal passa de 0,1
  // numa vogal. Reescala para a faixa útil (0,05 → 0, 0,55 → 1).
  return clamp01((high / total - 0.05) / 0.5);
}

/**
 * Atraso (ms) entre o analisador ler a amostra e ela sair do alto-falante:
 * `baseLatency` (contexto → sistema) + `outputLatency` (sistema → saída).
 * Campo ausente vale 0; o total trava em [0, OUTPUT_LATENCY_MAX_MS].
 */
export function outputLatencyMs(ctx: Pick<AudioContext, 'baseLatency' | 'outputLatency'> | null): number {
  if (!ctx) return 0;
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
  return Math.min(OUTPUT_LATENCY_MAX_MS, Math.max(0, (base + out) * 1000));
}

export interface VoiceFrame {
  level: number;
  brightness: number;
}

/**
 * Linha de atraso dos quadros da voz: `push` grava o quadro medido agora e
 * `read` devolve o que estava sendo medido `delayMs` atrás (o que o ouvido
 * escuta neste instante). Antes de existir histórico suficiente devolve o
 * quadro mais antigo que houver; vazio devolve silêncio.
 */
export class VoiceFrameDelayLine {
  private times: number[] = [];
  private frames: VoiceFrame[] = [];

  constructor(private readonly horizonMs = OUTPUT_LATENCY_MAX_MS + 100) {}

  push(now: number, frame: VoiceFrame): void {
    this.times.push(now);
    this.frames.push(frame);
    // Descarta o que já passou do horizonte (mantém pelo menos um).
    let drop = 0;
    while (drop < this.times.length - 1 && now - this.times[drop + 1]! >= this.horizonMs) drop += 1;
    if (drop > 0) {
      this.times.splice(0, drop);
      this.frames.splice(0, drop);
    }
  }

  read(now: number, delayMs: number): VoiceFrame {
    if (this.frames.length === 0) return { level: 0, brightness: 0 };
    const at = now - Math.max(0, delayMs);
    // O quadro mais recente medido até `at`; se nenhum, o mais antigo.
    for (let i = this.times.length - 1; i >= 0; i -= 1) {
      if (this.times[i]! <= at) return this.frames[i]!;
    }
    return this.frames[0]!;
  }

  clear(): void {
    this.times = [];
    this.frames = [];
  }
}

interface TapEntry {
  ctx: AudioContext;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  spectrum: Float32Array<ArrayBuffer> | null;
  taps: number;
}

/**
 * Um medidor por processo: `tap` insere a fonte no caminho de saída
 * (`source → analyser → ctx.destination`) e devolve a soltura; o loop rAF lê o
 * RMS e o brilho e publica em `voice-store` só enquanto o status é
 * `speaking` (fora dele publica 0). Um AnalyserNode por AudioContext — o
 * classic cria um contexto por playback, o Live mantém o próprio.
 */
export class OutputLevelMeter {
  private entries = new Map<AudioContext, TapEntry>();
  private raf = 0;
  private smooth = 0;
  private brightness = 0;
  private delay = new VoiceFrameDelayLine();
  private published = false;

  tap(ctx: AudioContext, source: AudioNode): () => void {
    let entry = this.entries.get(ctx);
    if (!entry) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; // ~10 ms @48k: RMS responsivo e barato por quadro
      // O espectro é por fonema: pouca média entre quadros (o padrão 0,8 arrasta).
      analyser.smoothingTimeConstant = 0.3;
      analyser.connect(ctx.destination);
      const spectrum =
        typeof analyser.getFloatFrequencyData === 'function'
          ? new Float32Array(analyser.frequencyBinCount || analyser.fftSize / 2)
          : null;
      entry = { ctx, analyser, samples: new Float32Array(analyser.fftSize), spectrum, taps: 0 };
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
    if (this.entries.size === 0) this.silence();
  }

  private silence(): void {
    this.smooth = 0;
    this.brightness = 0;
    this.delay.clear();
    if (this.published) {
      this.published = false;
      useVoiceStore.getState().setOutputLevel(0, 0);
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
      this.silence();
      return;
    }
    // Soma as energias de todos os contextos ativos (classic + live raramente
    // soam juntos; somar evita que um silencie o outro). O brilho vem do
    // contexto mais alto; a latência, do maior atraso entre eles.
    let target = 0;
    let loudest = -1;
    let brightness = 0; // sem voz de verdade: boca neutra
    let latency = 0;
    for (const entry of this.entries.values()) {
      entry.analyser.getFloatTimeDomainData(entry.samples);
      const level = outputLevelTarget(rmsOf(entry.samples));
      target += level;
      latency = Math.max(latency, outputLatencyMs(entry.ctx));
      if (entry.spectrum && level > loudest && level > OUTPUT_BRIGHTNESS_MIN_LEVEL) {
        loudest = level;
        entry.analyser.getFloatFrequencyData(entry.spectrum);
        brightness = spectralBrightness(entry.spectrum, entry.ctx.sampleRate, entry.analyser.fftSize);
      }
    }
    this.smooth = smoothOutputLevel(this.smooth, clamp01(target));
    this.brightness += (brightness - this.brightness) * OUTPUT_BRIGHTNESS_SMOOTHING;
    const now = performance.now();
    this.delay.push(now, { level: this.smooth, brightness: this.brightness });
    const heard = this.delay.read(now, latency);
    this.published = true;
    setOutputLevel(heard.level, heard.brightness);
  };
}

/** Medidor único da voz da Jarvis (classic TTS + Live PCM). */
export const jarvisOutputMeter = new OutputLevelMeter();
