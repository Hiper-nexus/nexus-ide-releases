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

  it('casa eco GARBLED do próprio TTS (STT errou letras da cauda)', () => {
    // A cauda do TTS volta pelo mic e o STT transcreve com erros de 1 letra —
    // o casamento exato falhava; o fuzzy (edit-distance ≤1 por palavra) pega.
    expect(
      isLikelySpokenEcho(
        'impersonai e acessai o sistema',
        'Impersonar é acessar o sistema como se fosse outro usuário.',
      ),
    ).toBe(true);
  });

  it('não confunde fala genuína parecida só por acaso', () => {
    // Palavras diferentes (distância > 1) não casam mesmo compartilhando tema.
    expect(
      isLikelySpokenEcho(
        'quero comprar um sistema novo de vendas',
        'Missão enviada ao squad de deploy.',
      ),
    ).toBe(false);
  });
});
