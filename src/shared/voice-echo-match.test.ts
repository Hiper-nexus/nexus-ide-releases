import { describe, expect, it } from 'vitest';
import { isLikelySpokenEcho, normEcho } from './voice-echo-match';

describe('voice-echo-match', () => {
  it('normaliza acentos, caixa e pontuação', () => {
    expect(normEcho('  Missão enviada, chefe!  ')).toBe('missao enviada chefe');
  });

  it('detecta eco por substring contígua', () => {
    expect(
      isLikelySpokenEcho(
        'rodando os testes agora',
        'Rodando os testes agora no terminal.',
      ),
    ).toBe(true);
  });

  it('detecta eco por sobreposição de palavras', () => {
    expect(
      isLikelySpokenEcho(
        'subindo squad code review você',
        'Subindo o squad de code review para você.',
      ),
    ).toBe(true);
  });

  it('deixa passar fala genuína do usuário', () => {
    expect(
      isLikelySpokenEcho('abre o projeto da barbearia', 'Missão enviada ao squad.'),
    ).toBe(false);
  });
});
