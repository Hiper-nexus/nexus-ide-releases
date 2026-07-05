import { describe, expect, it } from 'vitest';
import { EchoSuppressor, ECHO_TTL_MS, normEcho } from './echo-suppress';

function makeSuppressor(start = 1_000_000) {
  let now = start;
  const sup = new EchoSuppressor(() => now);
  return { sup, advance: (ms: number) => (now += ms) };
}

describe('normEcho', () => {
  it('normaliza acentos, caixa e pontuação', () => {
    expect(normEcho('  Missão enviada, chefe!  ')).toBe('missao enviada chefe');
  });
});

describe('EchoSuppressor', () => {
  it('detecta eco por substring contígua', () => {
    const { sup } = makeSuppressor();
    sup.record('Rodando os testes agora no terminal.');
    expect(sup.isEcho('rodando os testes agora')).toBe(true);
  });

  it('detecta eco por sobreposição de palavras (≥80%)', () => {
    const { sup } = makeSuppressor();
    sup.record('Subindo o squad de code review para você.');
    // Mesmas palavras significativas, ordem/ruído do mic diferentes.
    expect(sup.isEcho('subindo squad code review você')).toBe(true);
  });

  it('deixa passar fala genuína do usuário', () => {
    const { sup } = makeSuppressor();
    sup.record('Missão enviada ao squad.');
    expect(sup.isEcho('abre o projeto da barbearia')).toBe(false);
  });

  it('nunca marca eco sem fala recente ou com input muito curto', () => {
    const { sup } = makeSuppressor();
    expect(sup.isEcho('rodando os testes')).toBe(false);
    sup.record('Certo, pode deixar comigo então.');
    expect(sup.isEcho('sim')).toBe(false);
  });

  it('expira a janela por TTL — fala antiga não censura o usuário', () => {
    const { sup, advance } = makeSuppressor();
    sup.record('Rodando os testes agora.');
    advance(ECHO_TTL_MS + 1);
    expect(sup.isEcho('rodando os testes agora')).toBe(false);
  });

  it('mantém a janela limitada derrubando as falas mais antigas', () => {
    const { sup } = makeSuppressor();
    sup.record('primeira frase falada bem antiga sobre deploy');
    for (let i = 0; i < 20; i++) {
      sup.record(`frase de preenchimento numero ${i} com conteudo variado`);
    }
    expect(sup.isEcho('primeira frase falada bem antiga sobre deploy')).toBe(false);
  });

  it('reset limpa tudo', () => {
    const { sup } = makeSuppressor();
    sup.record('Rodando os testes agora.');
    sup.reset();
    expect(sup.isEcho('rodando os testes agora')).toBe(false);
  });
});
