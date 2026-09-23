import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MUFFLED_TREBLE_SHARE,
  analyzeSpeechQuality,
  noticeMuffledMic,
  resetMuffledMicNotice,
} from './speech-quality';

/**
 * Fala sintética: sílabas de 200 ms (vogal com harmônicos de uma fundamental
 * de 140 Hz) separadas por pausas. `topHz` corta os harmônicos — é o que um
 * "microfone" feito de fone de ouvido faz com a voz.
 */
function syntheticSpeech(
  sampleRate: number,
  opts: { seconds?: number; topHz?: number; gain?: number; hiss?: number } = {},
): Float32Array {
  const { seconds = 4, topHz = 3_800, gain = 0.3, hiss = 0 } = opts;
  const out = new Float32Array(Math.round(sampleRate * seconds));
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    const t = i / sampleRate;
    const syllable = Math.floor(t / 0.2) % 3 !== 2; // 2 sílabas, 1 pausa
    let v = 0;
    if (syllable) {
      for (let h = 1; h * 140 < topHz; h += 1) {
        // Inclinação natural da voz: harmônicos altos mais fracos (≈ −6 dB/oitava).
        v += Math.sin(2 * Math.PI * 140 * h * t) / h;
      }
    }
    out[i] = v * gain * 0.2 + hiss * noise();
  }
  return out;
}

describe('analyzeSpeechQuality', () => {
  it('voz com consoantes (harmônicos até ~4 kHz) sai ok', () => {
    const quality = analyzeSpeechQuality(syntheticSpeech(16_000), 16_000);

    expect(quality.verdict).toBe('ok');
    expect(quality.trebleShare).toBeGreaterThan(MUFFLED_TREBLE_SHARE);
    expect(quality.speechSec).toBeGreaterThan(2);
  });

  it('voz sem agudos (fone na entrada rosa, 23/09) sai abafada', () => {
    const quality = analyzeSpeechQuality(syntheticSpeech(16_000, { topHz: 700 }), 16_000);

    expect(quality.verdict).toBe('muffled');
    expect(quality.trebleShare).toBeLessThan(MUFFLED_TREBLE_SHARE);
  });

  it('o veredito não depende da taxa: chiado acima de 4 kHz não passa por agudo', () => {
    const at48k = analyzeSpeechQuality(
      syntheticSpeech(48_000, { topHz: 700, gain: 0.05, hiss: 0.01 }),
      48_000,
    );
    const at16k = analyzeSpeechQuality(syntheticSpeech(16_000, { topHz: 700 }), 16_000);

    expect(at48k.verdict).toBe('muffled');
    expect(at16k.verdict).toBe('muffled');
  });

  it('silêncio ou fala curta demais não dão veredito sobre o microfone', () => {
    expect(analyzeSpeechQuality(new Float32Array(16_000 * 3), 16_000).verdict).toBe('no-speech');
    expect(
      analyzeSpeechQuality(syntheticSpeech(16_000, { seconds: 0.6, topHz: 700 }), 16_000).verdict,
    ).toBe('no-speech');
  });

  it('registra nível e pico em dBFS arredondados', () => {
    const quality = analyzeSpeechQuality(syntheticSpeech(16_000), 16_000);

    expect(quality.peakDb).toBeLessThan(0);
    expect(quality.speechLevelDb).toBeLessThan(quality.peakDb!);
    expect(Number.isInteger(quality.speechLevelDb! * 10)).toBe(true);
  });
});

describe('noticeMuffledMic', () => {
  beforeEach(() => resetMuffledMicNotice());

  const muffled = analyzeSpeechQuality(syntheticSpeech(16_000, { topHz: 700 }), 16_000);
  const clean = analyzeSpeechQuality(syntheticSpeech(16_000), 16_000);

  it('avisa uma vez por sessão, com o caminho para Ajustes › Voz', () => {
    const push = vi.fn();
    const openVoiceSettings = vi.fn();

    expect(noticeMuffledMic(muffled, { push, openVoiceSettings })).toBe(true);
    expect(noticeMuffledMic(muffled, { push, openVoiceSettings })).toBe(false);

    expect(push).toHaveBeenCalledOnce();
    const [kind, title, options] = push.mock.calls[0]!;
    expect(kind).toBe('warn');
    expect(title).toBe('Microfone chegando abafado');
    expect(options.detail).toMatch(/entrada rosa/);
    options.action.onClick();
    expect(openVoiceSettings).toHaveBeenCalledOnce();
  });

  it('voz boa ou captura sem medição não avisam nada', () => {
    const push = vi.fn();

    expect(noticeMuffledMic(clean, { push, openVoiceSettings: vi.fn() })).toBe(false);
    expect(noticeMuffledMic(undefined, { push, openVoiceSettings: vi.fn() })).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('fiação da qualidade da fala no ditado', () => {
  it('a captura mede a fala no mesmo PCM de 16 kHz que vai para a STT', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./voice-capture.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/quality: analyzeSpeechQuality\(downsampled, TARGET_SAMPLE_RATE\)/u);
  });

  it('o ditado registra a qualidade e avisa ANTES de transcrever', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('./voice-finish-and-process.ts', import.meta.url),
      'utf8',
    );
    const branch = source.slice(source.indexOf('if (dictationTurn) {'));
    const logAt = branch.indexOf("'stt.audioQuality'");
    const noticeAt = branch.indexOf('noticeMuffledMic(result.quality');
    const transcribeAt = branch.indexOf('await transcribeCapture()');

    expect(logAt).toBeGreaterThan(0);
    expect(noticeAt).toBeGreaterThan(logAt);
    // Quando o texto sair errado, o log já diz se a culpa é do microfone.
    expect(transcribeAt).toBeGreaterThan(noticeAt);
  });
});
