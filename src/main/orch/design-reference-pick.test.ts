import { describe, expect, it } from 'vitest';
import { pickDesignReference } from './design-reference-pick';

const CATALOGO = [
  { fileName: 'barbearia-navalha.md', title: '# Navalha — barbearia masculina' },
  { fileName: 'saas-dashboard.md', title: '# SaaS dashboard escuro' },
  { fileName: 'ecommerce-moda.md', title: '# E-commerce de moda' },
  { fileName: 'README.md', title: '# Índice do catálogo' },
];

describe('pickDesignReference — o Nexus escolhe, não a LLM', () => {
  it('casa a referência pelo assunto do pedido', () => {
    expect(
      pickDesignReference(
        'crie uma landing para minha barbearia com botão de agendar',
        CATALOGO,
      )?.fileName,
    ).toBe('barbearia-navalha.md');
  });

  it('casa pelo título, não só pelo nome do arquivo', () => {
    expect(
      pickDesignReference('quero um painel de assinaturas saas', CATALOGO)
        ?.fileName,
    ).toBe('saas-dashboard.md');
  });

  it('sem pista nenhuma NÃO inventa referência', () => {
    expect(
      pickDesignReference('corrija o cálculo de imposto do pedido', CATALOGO),
    ).toBeNull();
  });

  it('empate no topo não decide — ambiguidade volta para a pasta', () => {
    expect(
      pickDesignReference('moda e barbearia', [
        { fileName: 'barbearia.md' },
        { fileName: 'moda.md' },
      ]),
    ).toBeNull();
  });

  it('palavras genéricas do pedido não casam com nada', () => {
    // "site", "página", "crie" aparecem em quase todo objetivo: se contassem,
    // qualquer referência casaria e a escolha viraria ruído.
    expect(
      pickDesignReference('crie um site com uma página bonita', CATALOGO),
    ).toBeNull();
  });

  it('catálogo vazio devolve null', () => {
    expect(pickDesignReference('barbearia', [])).toBeNull();
  });
});
