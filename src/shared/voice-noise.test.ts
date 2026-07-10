import { describe, expect, it } from 'vitest';
import {
  isLikelyNoiseTranscript,
  isMediaBoilerplateTranscript,
} from './voice-noise';

describe('isLikelyNoiseTranscript', () => {
  it('drops the self-talk garbage captured off her own TTS tail', () => {
    // The exact captures from the forensics self-talk cascade.
    expect(isLikelyNoiseTranscript('Ooooooooh!')).toBe(true);
    expect(isLikelyNoiseTranscript('o javis')).toBe(true);
  });

  it('drops classic whisper hallucinations and interjections', () => {
    for (const t of [
      '',
      '.',
      'ah',
      'ai ai',
      'aaaah',
      'hmm',
      'uh',
      'you',
      'thank you',
      'obrigado por assistir',
      'se inscreve no canal',
      'kkkk',
      'hahaha',
      'jarvis',
      'javes',
      'jives',
      'Ai Jives',
      'ai jives',
      'e ai jarvis',
      'e aí jarvis',
    ]) {
      expect(isLikelyNoiseTranscript(t), t).toBe(true);
    }
  });

  it('keeps deliberate short greetings and real commands', () => {
    for (const t of [
      'oi',
      'e aí',
      'sim',
      'não',
      'abre o terminal',
      'pode abrir o navegador',
      'roda os testes',
      'que horas são',
    ]) {
      expect(isLikelyNoiseTranscript(t), t).toBe(false);
    }
  });

  it('drops the long combined YouTube boilerplate seen in production logs', () => {
    const transcript =
      'Obrigado por assistir, se inscreva no canal e ative o sininho para receber notificações de novos vídeos.';
    expect(isMediaBoilerplateTranscript(transcript)).toBe(true);
    expect(isLikelyNoiseTranscript(transcript)).toBe(true);
  });

  it('does not drop a real sentence that merely mentions one media phrase', () => {
    expect(
      isMediaBoilerplateTranscript(
        'Troque no texto a frase obrigado por assistir pela nossa chamada principal',
      ),
    ).toBe(false);
  });
});
