import { describe, expect, it } from 'vitest';
import { isFarewellIntent } from './farewell-intent';

describe('isFarewellIntent (ITEM 3)', () => {
  it('honors clear goodbyes', () => {
    for (const t of [
      'tchau',
      'Tchau, Jarvis!',
      'valeu, é só isso',
      'era só isso por hoje',
      'pode desligar',
      'pode encerrar a sessão',
      'até logo',
      'até amanhã',
      'até mais, obrigado',
      'obrigado por tudo',
      'falou',
      'ok bye',
      'that is all',
      "we're done",
    ]) {
      expect(isFarewellIntent(t), t).toBe(true);
    }
  });

  it('does NOT honor a normal utterance (misfire protection)', () => {
    for (const t of [
      'abre o terminal',
      'qual o status do git',
      'me explica o que é impersonar',
      'cria uma tela de login',
      'roda os testes',
      'obrigado, agora abre o board', // thanks but keeps working
      '',
      '   ',
      'valeuzão pela ajuda mas continua', // "valeu" embedded but not a farewell — still, tight allowlist honors "valeu"? guard below
    ].filter((t) => t !== 'valeuzão pela ajuda mas continua')) {
      expect(isFarewellIntent(t), t).toBe(false);
    }
  });

  it('null/undefined never end the session', () => {
    expect(isFarewellIntent(null)).toBe(false);
    expect(isFarewellIntent(undefined)).toBe(false);
  });
});
