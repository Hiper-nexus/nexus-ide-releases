import { describe, expect, it } from 'vitest';
import {
  isLikelyNoiseTranscript,
  isMediaBoilerplateTranscript,
  isWakeAddressTranscript,
} from './voice-noise';

describe('isLikelyNoiseTranscript', () => {
  it('drops pure interjections and elongated vowels', () => {
    for (const t of ['', '.', 'ah', 'ai ai', 'aaaah', 'hmm', 'uh', 'you', 'kkkk', 'hahaha']) {
      expect(isLikelyNoiseTranscript(t), t).toBe(true);
    }
  });

  it('drops media boilerplate', () => {
    expect(isLikelyNoiseTranscript('thank you')).toBe(true);
    expect(isLikelyNoiseTranscript('obrigado por assistir')).toBe(true);
    expect(isLikelyNoiseTranscript('se inscreve no canal')).toBe(true);
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

  it('keeps any Jarvis address — alone or near-miss STT (product policy)', () => {
    for (const t of [
      'Jarvis',
      'jarvis',
      'javis',
      'javes',
      'Jarvi',
      'Ei, Jarvis.',
      'Hey, Javes.',
      'ei jarvis',
      'hey javes',
      'e aí jarvis',
      'o javis',
      'jarvis abre',
    ]) {
      expect(isLikelyNoiseTranscript(t), t).toBe(false);
      expect(isWakeAddressTranscript(t), t).toBe(true);
    }
  });

  it('still drops Ooooooooh-style TTS garbage', () => {
    expect(isLikelyNoiseTranscript('Ooooooooh!')).toBe(true);
  });

  it('drops the long combined YouTube boilerplate seen in production logs', () => {
    const transcript =
      'Obrigado por assistir, se inscreva no canal e ative o sininho para receber notificações de novos vídeos.';
    expect(isMediaBoilerplateTranscript(transcript)).toBe(true);
    expect(isLikelyNoiseTranscript(transcript)).toBe(true);
  });
});

describe('repetição degenerada e alucinação de apresentação', () => {
  const HALLUCINATION = Array(6)
    .fill('The following is a presentation of the')
    .join('. ');

  it('descarta a alucinação "The following is a presentation of..." repetida', async () => {
    const { isDegenerateRepetition, isLikelyNoiseTranscript } = await import('./voice-noise');
    expect(isDegenerateRepetition(HALLUCINATION)).toBe(true);
    expect(isLikelyNoiseTranscript(HALLUCINATION)).toBe(true);
  });

  it('descarta a frase sozinha (boilerplate conhecido)', async () => {
    const { isLikelyNoiseTranscript } = await import('./voice-noise');
    expect(isLikelyNoiseTranscript('The following is a presentation of the')).toBe(true);
  });

  it('pega repetição da mesma palavra ou n-grama colada', async () => {
    const { isDegenerateRepetition } = await import('./voice-noise');
    expect(isDegenerateRepetition('you you you you you you')).toBe(true);
    expect(isDegenerateRepetition('thank you so much thank you so much thank you so much')).toBe(true);
  });

  it('não pega fala normal nem repetição curta legítima', async () => {
    const { isDegenerateRepetition } = await import('./voice-noise');
    expect(isDegenerateRepetition('abra o arquivo de configuração e rode os testes')).toBe(false);
    expect(isDegenerateRepetition('no no')).toBe(false);
    expect(isDegenerateRepetition('run the tests. then run the build. then commit')).toBe(false);
    expect(isDegenerateRepetition('')).toBe(false);
  });
});
