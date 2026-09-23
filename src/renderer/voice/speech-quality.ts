/**
 * Qualidade da FALA capturada (PURO, testável no vitest).
 *
 * Por que existe: no Windows do operador (23/09) a transcrição "errava tudo"
 * e o Mac, com o mesmo Nexus, acertava. Medido: a voz chegava sem agudos —
 * 2,7% da energia acima de 1 kHz, 77% abaixo de 250 Hz — com o ganho do
 * Windows no máximo. Era um headset de plugue único na entrada rosa: o
 * próprio fone virava "microfone". Sem as consoantes (2–4 kHz) qualquer STT
 * adivinha palavras, e nada no log dizia isso — o diagnóstico levou uma hora.
 *
 * Aqui cada captura ganha três números e um veredito: quanto de fala houve,
 * em que nível, e que fração da energia da fala está acima de 1 kHz. Abaixo
 * de `MUFFLED_TREBLE_SHARE` a voz está abafada e a transcrição vai errar
 * independentemente do provider.
 */

/** Fração mínima da energia da fala acima de 1 kHz para a voz ser inteligível. */
export const MUFFLED_TREBLE_SHARE = 0.04;
/** Fala mínima para dar veredito — um "ok" curto não diz nada do microfone. */
export const MIN_SPEECH_SEC_FOR_VERDICT = 1;
/** Quadro de análise. */
const FRAME_SEC = 0.02;
/** Fala = quadro pelo menos 10 dB acima do piso de ruído da própria captura. */
const SPEECH_ABOVE_NOISE = 10 ** (10 / 20);
/** E acima de −60 dBFS: silêncio digital não vira "fala" por comparação. */
const SPEECH_ABSOLUTE_FLOOR = 10 ** (-60 / 20);

export type SpeechQualityVerdict = 'ok' | 'muffled' | 'no-speech';

export interface SpeechQuality {
  /** Segundos de quadros com fala. */
  readonly speechSec: number;
  /** Mediana do nível dos quadros de fala, em dBFS; null sem fala. */
  readonly speechLevelDb: number | null;
  /** Pico absoluto da captura, em dBFS; null em captura vazia. */
  readonly peakDb: number | null;
  /** Energia 1–4 kHz / energia 80 Hz–4 kHz, só nos quadros de fala; null sem fala. */
  readonly trebleShare: number | null;
  readonly verdict: SpeechQualityVerdict;
}

interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** Passa-altas de 2ª ordem (RBJ, Q = 1/√2). */
function highPass(cutoffHz: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Passa-baixas de 2ª ordem (RBJ, Q = 1/√2). */
function lowPass(cutoffHz: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function filter(input: Float32Array, f: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i] ?? 0;
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function toDb(value: number): number {
  return Math.round(20 * Math.log10(value) * 10) / 10;
}

export function analyzeSpeechQuality(
  samples: Float32Array,
  sampleRate: number,
): SpeechQuality {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  if (samples.length < frame || sampleRate < 4_000) {
    return {
      speechSec: 0,
      speechLevelDb: null,
      peakDb: null,
      trebleShare: null,
      verdict: 'no-speech',
    };
  }
  // Tudo medido na banda da voz (até 4 kHz): sem DC, sem ronco e sem o chiado
  // acima de 4 kHz — numa captura fraca a 48 kHz o chiado se passava por
  // agudo e o abafado saía "ok". Assim o veredito não depende da taxa.
  const bandTop = Math.min(4_000, sampleRate * 0.45);
  const voice = filter(filter(samples, highPass(80, sampleRate)), lowPass(bandTop, sampleRate));
  const treble = filter(filter(samples, highPass(1_000, sampleRate)), lowPass(bandTop, sampleRate));

  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  }

  const frames: Array<{ rms: number; voice: number; treble: number }> = [];
  for (let offset = 0; offset + frame <= voice.length; offset += frame) {
    let v = 0;
    let t = 0;
    for (let i = offset; i < offset + frame; i += 1) {
      const a = voice[i] ?? 0;
      const b = treble[i] ?? 0;
      v += a * a;
      t += b * b;
    }
    frames.push({ rms: Math.sqrt(v / frame), voice: v, treble: t });
  }
  const sorted = frames.map((entry) => entry.rms).sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const speech = frames.filter(
    (entry) =>
      entry.rms >= SPEECH_ABSOLUTE_FLOOR && entry.rms >= noise * SPEECH_ABOVE_NOISE,
  );
  const speechSec = Math.round(speech.length * FRAME_SEC * 10) / 10;
  if (speech.length === 0) {
    return {
      speechSec: 0,
      speechLevelDb: null,
      peakDb: peak > 0 ? toDb(peak) : null,
      trebleShare: null,
      verdict: 'no-speech',
    };
  }
  let voiceEnergy = 0;
  let trebleEnergy = 0;
  for (const entry of speech) {
    voiceEnergy += entry.voice;
    trebleEnergy += entry.treble;
  }
  const trebleShare =
    voiceEnergy > 0 ? Math.round((trebleEnergy / voiceEnergy) * 1000) / 1000 : 0;
  const levels = speech.map((entry) => entry.rms).sort((a, b) => a - b);
  const median = levels[Math.floor(levels.length / 2)] ?? 0;
  const verdict: SpeechQualityVerdict =
    speechSec < MIN_SPEECH_SEC_FOR_VERDICT
      ? 'no-speech'
      : trebleShare < MUFFLED_TREBLE_SHARE
        ? 'muffled'
        : 'ok';
  return {
    speechSec,
    speechLevelDb: median > 0 ? toDb(median) : null,
    peakDb: peak > 0 ? toDb(peak) : null,
    trebleShare,
    verdict,
  };
}

export interface MuffledMicNoticeDeps {
  push(
    kind: 'warn',
    title: string,
    options: {
      detail: string;
      action: { label: string; onClick: () => void };
      dedupeKey: string;
      ttlMs: number;
    },
  ): void;
  openVoiceSettings(): void;
}

let muffledNoticeShown = false;

/**
 * Avisa UMA vez por sessão que a voz está chegando abafada. O ditado segue —
 * a transcrição ainda pode servir —, mas o operador fica sabendo que a causa
 * está no microfone, não no provider: foi essa a pergunta que custou uma hora.
 */
export function noticeMuffledMic(
  quality: SpeechQuality | undefined,
  deps: MuffledMicNoticeDeps,
): boolean {
  if (!quality || quality.verdict !== 'muffled' || muffledNoticeShown) return false;
  muffledNoticeShown = true;
  deps.push('warn', 'Microfone chegando abafado', {
    detail:
      'Sua voz chega sem agudos e a transcrição vai trocar palavras. Em geral é ' +
      'fone ou headset de plugue único ligado na entrada rosa: use o microfone ' +
      'USB ou um adaptador que separa microfone e fone.',
    action: { label: 'Abrir Voz', onClick: deps.openVoiceSettings },
    dedupeKey: 'voice-muffled-mic',
    ttlMs: 20_000,
  });
  return true;
}

/** Só para testes: a sessão recomeça sem aviso dado. */
export function resetMuffledMicNotice(): void {
  muffledNoticeShown = false;
}
