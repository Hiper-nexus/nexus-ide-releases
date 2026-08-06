import { describe, expect, it } from 'vitest';
import {
  extractNeedTerms,
  rankCapabilitiesByNeed,
} from './capability-need-ranking';

const CATALOGO = [
  {
    name: 'security-reviewer',
    description: 'Audita OWASP, injeção e segredos vazados.',
    labels: ['security', 'review'],
  },
  {
    name: 'frontend-developer',
    description: 'Constrói telas em React com acessibilidade.',
    labels: ['frontend', 'react'],
  },
  {
    name: 'doc-updater',
    description: 'Atualiza README e guias do projeto.',
    labels: ['docs'],
  },
  {
    name: 'react-reviewer',
    description: 'Revisa hooks e fronteiras de componente React.',
    labels: ['react', 'review'],
  },
];

describe('termos da necessidade', () => {
  it('descarta palavras que aparecem em toda necessidade', () => {
    // Se "preciso de um agente para" contasse, todo candidato empataria — que é
    // o mesmo que não ranquear.
    expect(extractNeedTerms('preciso de um agente para revisar React')).toEqual(
      expect.arrayContaining(['revisar', 'react']),
    );
    expect(extractNeedTerms('preciso de um agente para')).toEqual([]);
  });

  it('preserva termos técnicos curtos que importam', () => {
    const termos = extractNeedTerms('mexer em api e git');
    expect(termos).toContain('api');
    expect(termos).toContain('git');
  });
});

describe('ranqueamento por necessidade', () => {
  it('devolve poucos candidatos, o melhor primeiro, com a razão', () => {
    const { ranked, matched } = rankCapabilitiesByNeed(
      CATALOGO,
      'revisar código React',
      2,
    );

    expect(matched).toBe(true);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.item.name).toBe('react-reviewer');
    expect(ranked[0]!.matchedTerms).toContain('react');
  });

  /**
   * Um rótulo é declaração; a mesma palavra na prosa pode ser ressalva. Se o
   * peso fosse igual, "não faz security" ranquearia como especialista.
   */
  it('rótulo declarado pesa mais que a mesma palavra na descrição', () => {
    const { ranked } = rankCapabilitiesByNeed(
      [
        { name: 'a', description: 'security security security' },
        { name: 'b', description: 'genérico', labels: ['security'] },
      ],
      'security',
      2,
    );

    expect(ranked[0]!.item.name).toBe('b');
  });

  /**
   * D1: uma busca que não casa com nada não pode ser pior do que não ter
   * buscado. `matched:false` é o sinal para o chamador devolver o catálogo.
   */
  it('nada casou devolve matched:false, nunca erro', () => {
    const resultado = rankCapabilitiesByNeed(CATALOGO, 'terraform kubernetes', 5);
    expect(resultado.matched).toBe(false);
    expect(resultado.ranked).toEqual([]);
  });

  it('necessidade só de palavras vazias não vira "catálogo vazio"', () => {
    const resultado = rankCapabilitiesByNeed(CATALOGO, 'preciso de um', 5);
    expect(resultado.matched).toBe(false);
  });

  it('ordem é estável no empate — o orquestrador relê a lista entre turnos', () => {
    const empatados = [
      { name: 'zeta', labels: ['review'] },
      { name: 'alfa', labels: ['review'] },
    ];
    const primeira = rankCapabilitiesByNeed(empatados, 'review', 5);
    const segunda = rankCapabilitiesByNeed([...empatados].reverse(), 'review', 5);

    expect(primeira.ranked.map((r) => r.item.name)).toEqual(['alfa', 'zeta']);
    expect(segunda.ranked.map((r) => r.item.name)).toEqual(['alfa', 'zeta']);
  });

  it('limite zero ainda entrega um candidato — busca útil nunca volta vazia', () => {
    const { ranked } = rankCapabilitiesByNeed(CATALOGO, 'react', 0);
    expect(ranked).toHaveLength(1);
  });
});
