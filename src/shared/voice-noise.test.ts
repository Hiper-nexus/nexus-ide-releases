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
