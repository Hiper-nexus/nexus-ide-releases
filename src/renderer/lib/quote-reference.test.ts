import { describe, expect, it } from 'vitest';
import {
  QUOTE_EXCERPT_MAX_CHARS,
  appendQuote,
  formatQuote,
  parseQuoteOrigins,
  quoteExcerpt,
  quoteOriginTag,
  type QuoteOrigin,
} from './quote-reference';

const ORIGIN: QuoteOrigin = {
  missionId: 'mission-42',
  eventId: 'evt-9f1',
  sequence: 17,
  runId: 'observer:abc',
  paneId: 'pane-7',
  agentName: 'Implementar interface',
};

describe('quote-reference', () => {
  it('a marca de origem volta intacta, mesmo com ids que têm espaço ou colchete', () => {
    const odd: QuoteOrigin = { missionId: 'm 1', eventId: 'e]2', sequence: 3, paneId: 'p 9' };
    const text = `antes\n${quoteOriginTag(ORIGIN)}\nmeio ${quoteOriginTag(odd)} fim`;
    expect(parseQuoteOrigins(text)).toEqual([
      { missionId: 'mission-42', eventId: 'evt-9f1', sequence: 17, paneId: 'pane-7' },
      { missionId: 'm 1', eventId: 'e]2', sequence: 3, paneId: 'p 9' },
    ]);
  });

  it('origem sem pane omite o campo', () => {
    const tag = quoteOriginTag({ missionId: 'm', eventId: 'e', sequence: 1 });
    expect(tag).toBe('[origem: missao=m evento=e seq=1]');
    expect(parseQuoteOrigins(tag)).toEqual([{ missionId: 'm', eventId: 'e', sequence: 1 }]);
  });

  it('formata a citação em Markdown: quem, evento, trecho e a origem fora do bloco', () => {
    const quote = formatQuote(ORIGIN, 'Shell', 'npm test\n\n18 tests passed');
    expect(quote).toBe(
      [
        '> Implementar interface · evento #17 · Shell',
        '> npm test',
        '>',
        '> 18 tests passed',
        '[origem: missao=mission-42 evento=evt-9f1 seq=17 pane=pane-7]',
      ].join('\n'),
    );
  });

  it('sem nome de agente, quem falou é o pane; sem pane, a missão', () => {
    expect(formatQuote({ ...ORIGIN, agentName: undefined }, 'Leitura', 'x')).toMatch(/^> pane pane-7 · /u);
    expect(
      formatQuote({ missionId: 'm', eventId: 'e', sequence: 2 }, 'Estado', 'x'),
    ).toMatch(/^> missão · evento #2/u);
  });

  it('trecho longo é cortado em linhas e caracteres, com reticências', () => {
    const many = Array.from({ length: 40 }, (_, index) => `linha ${index}`).join('\n');
    const cutLines = quoteExcerpt(many);
    expect(cutLines.split('\n')).toHaveLength(24);
    expect(cutLines.endsWith('…')).toBe(true);
    const long = quoteExcerpt('a'.repeat(5_000));
    expect(long.length).toBe(QUOTE_EXCERPT_MAX_CHARS + 1);
    expect(quoteExcerpt('  curto  ')).toBe('curto');
  });

  it('junta ao rascunho com uma linha em branco e deixa espaço para escrever', () => {
    expect(appendQuote('', '> q')).toBe('> q\n\n');
    expect(appendQuote('Revise isto:   \n', '> q')).toBe('Revise isto:\n\n> q\n\n');
  });
});
