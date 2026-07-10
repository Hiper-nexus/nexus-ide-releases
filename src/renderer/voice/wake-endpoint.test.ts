import { describe, expect, it } from 'vitest';
import { shouldEndpointUtterance, VAD_MIN_SPEECH_MS } from './wake-endpoint';

const base = {
  heardSpeech: true,
  speechMs: 900,
  silentMs: 800,
  totalMs: 1_000,
  silenceMs: 700,
  minListenMs: 1_500,
  maxMs: 15_000,
};

describe('shouldEndpointUtterance', () => {
  it('encerra no teto duro (maxMs) sempre', () => {
    expect(
      shouldEndpointUtterance({ ...base, heardSpeech: false, totalMs: 15_000 }),
    ).toBe(true);
  });

  it('nunca encerra por silêncio antes de ouvir fala', () => {
    expect(
      shouldEndpointUtterance({ ...base, heardSpeech: false, silentMs: 5_000 }),
    ).toBe(false);
  });

  it('não encerra enquanto o silêncio for menor que silenceMs', () => {
    expect(shouldEndpointUtterance({ ...base, silentMs: 400 })).toBe(false);
  });

  it('VAD: comando real terminado encerra ANTES do piso minListenMs', () => {
    // fala >= VAD_MIN_SPEECH_MS, silêncio suficiente, mas total < minListenMs
    expect(
      shouldEndpointUtterance({
        ...base,
        speechMs: VAD_MIN_SPEECH_MS + 100,
        totalMs: 1_000, // < 1_500 (piso)
        silentMs: 750,
      }),
    ).toBe(true);
  });

  it('fala curta (blip) ainda respeita o piso minListenMs', () => {
    // heardSpeech true mas pouca fala real → espera o piso
    expect(
      shouldEndpointUtterance({
        ...base,
        speechMs: VAD_MIN_SPEECH_MS - 100,
        totalMs: 1_000, // < piso
        silentMs: 750,
      }),
    ).toBe(false);
    // ...e ao cruzar o piso, encerra
    expect(
      shouldEndpointUtterance({
        ...base,
        speechMs: VAD_MIN_SPEECH_MS - 100,
        totalMs: 1_600, // >= piso
        silentMs: 750,
      }),
    ).toBe(true);
  });

  it('respeita um vadMinSpeechMs customizado', () => {
    expect(
      shouldEndpointUtterance({
        ...base,
        speechMs: 300,
        totalMs: 800,
        silentMs: 750,
        vadMinSpeechMs: 250,
      }),
    ).toBe(true);
  });

  it('does not let seeded wake speech close a live-greeting capture before the command', () => {
    const greetingTurn = {
      heardSpeech: true,
      speechMs: 0,
      silentMs: 900,
      silenceMs: 700,
      minListenMs: 4_300,
      maxMs: 15_000,
    };
    expect(shouldEndpointUtterance({ ...greetingTurn, totalMs: 1_000 })).toBe(false);
    expect(shouldEndpointUtterance({ ...greetingTurn, totalMs: 4_000 })).toBe(false);
    expect(
      shouldEndpointUtterance({
        ...greetingTurn,
        speechMs: VAD_MIN_SPEECH_MS + 200,
        totalMs: 4_900,
        silentMs: 750,
      }),
    ).toBe(true);
    expect(shouldEndpointUtterance({ ...greetingTurn, totalMs: 4_400 })).toBe(true);
  });
});
