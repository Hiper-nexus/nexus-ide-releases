import { describe, expect, it } from 'vitest';
import {
  buildDelegationBrief,
  parseBriefResult,
  briefPointerLine,
} from './delegation-brief';

/**
 * Delegação por PONTEIRO — o gap real nº 1 da lista de 2,5.
 *
 * Hoje todo worker recebe o briefing inteiro no contexto: caro em tokens, caro
 * no boot, e sem deixar artefato. O Overclock persiste o brief num arquivo do
 * WORKSPACE e manda ao worker uma linha de ponteiro; o worker escreve o
 * resultado de volta no MESMO arquivo, sob `## Resultado`.
 *
 * Para o Nexus isso serve duas vezes: corta contexto E deixa um artefato
 * revisável de cada delegação, o que combina com a proveniência que é a nossa
 * essência — prompt efêmero não deixa rastro; brief em arquivo deixa.
 */
describe('delegation brief', () => {
  it('monta o brief com pedido e seção de resultado vazia', () => {
    const brief = buildDelegationBrief({
      id: 'b-1',
      title: 'Corrigir o login',
      request: 'Investigue o 401 e corrija.',
    });

    expect(brief).toContain('# Corrigir o login');
    expect(brief).toContain('Investigue o 401');
    expect(brief).toContain('## Resultado');
  });

  it('o ponteiro é UMA linha e nomeia o arquivo e a seção', () => {
    const linha = briefPointerLine({ id: 'b-1', path: '.nexus/briefs/b-1.md' });

    expect(linha.split('\n')).toHaveLength(1);
    expect(linha).toContain('.nexus/briefs/b-1.md');
    expect(linha).toContain('## Resultado');
  });

  it('lê o resultado que o worker escreveu de volta', () => {
    const brief = buildDelegationBrief({
      id: 'b-2',
      title: 'T',
      request: 'faça X',
    });
    const preenchido = brief.replace(
      '## Resultado\n\n_(o worker preenche esta seção)_',
      '## Resultado\n\nFeito: corrigi o parser e adicionei teste.',
    );

    expect(parseBriefResult(preenchido)).toBe(
      'Feito: corrigi o parser e adicionei teste.',
    );
  });

  it('resultado ainda não preenchido devolve null, nunca o placeholder', () => {
    const brief = buildDelegationBrief({ id: 'b-3', title: 'T', request: 'r' });
    expect(parseBriefResult(brief)).toBeNull();
  });

  it('brief sem a seção devolve null em vez de explodir', () => {
    expect(parseBriefResult('# só um título\n\ntexto solto')).toBeNull();
  });
});
