import { describe, expect, it } from 'vitest';
import {
  HANDOFF_FULLTEXT_CAP_CHARS,
  HANDOFF_SUMMARY_COMPACTED_MARK,
  HANDOFF_SUMMARY_CONDENSE_FROM_CHARS,
  capHandoffFullText,
  condenseHandoffSummary,
} from './handoff-summary-rule';

describe('condenseHandoffSummary — régua 280/400 do summary', () => {
  it('até 400 caracteres passa intacto (só trim)', () => {
    const text = `  ${'a'.repeat(398)}  `;

    const result = condenseHandoffSummary(text);

    expect(result).toEqual({ summary: 'a'.repeat(398), condensed: false });
  });

  it('acima de 400 corta na última fronteira de frase entre 280 e 400 e preserva a íntegra', () => {
    const first = `${'Primeira frase com detalhes '.repeat(6).trim()}.`; // ~167 chars
    const second = `${'Segunda frase que fecha a janela '.repeat(5).trim()}.`; // ~164 chars
    const tail = 'Terceira frase muito longa que ultrapassa o limite e nunca deveria aparecer no summary colado no PTY do orquestrador porque isso é ruído puro e mais ruído e mais ruído ainda.';
    const text = `${first} ${second} ${tail}`;
    expect(text.length).toBeGreaterThan(HANDOFF_SUMMARY_CONDENSE_FROM_CHARS);

    const result = condenseHandoffSummary(text);

    expect(result.condensed).toBe(true);
    expect(result.summary).toBe(`${first} ${second} ${HANDOFF_SUMMARY_COMPACTED_MARK}`);
    expect(result.original).toBe(text);
  });

  it('sem fronteira de frase na janela, corta seco em 400 com reticência', () => {
    const text = 'x'.repeat(6_000);

    const result = condenseHandoffSummary(text);

    expect(result.condensed).toBe(true);
    expect(result.summary).toBe(
      `${'x'.repeat(HANDOFF_SUMMARY_CONDENSE_FROM_CHARS - 1)}… ${HANDOFF_SUMMARY_COMPACTED_MARK}`,
    );
    expect(result.summary).toContain('[compacted]');
    expect(result.summary.length).toBeLessThanOrEqual(4_000);
  });

  it('fronteira antes de 280 não conta: o summary não vira uma frase minúscula', () => {
    const text = `Ok. ${'palavra '.repeat(80)}`; // fronteira em 3, resto sem pontuação
    expect(text.length).toBeGreaterThan(HANDOFF_SUMMARY_CONDENSE_FROM_CHARS);

    const result = condenseHandoffSummary(text);

    expect(result.summary.startsWith('Ok. palavra')).toBe(true);
    expect(result.summary.length).toBeGreaterThan(280);
  });

  it('quebra de linha vale como fronteira', () => {
    const line = 'Linha de resultado operacional com contexto suficiente para contar.';
    const text = `${line}\n${line}\n${line}\n${line}\n${line}\n${line}\n${line}`;
    expect(text.length).toBeGreaterThan(HANDOFF_SUMMARY_CONDENSE_FROM_CHARS);

    const result = condenseHandoffSummary(text);

    expect(result.summary.endsWith(`${line} ${HANDOFF_SUMMARY_COMPACTED_MARK}`)).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(
      HANDOFF_SUMMARY_CONDENSE_FROM_CHARS + HANDOFF_SUMMARY_COMPACTED_MARK.length + 1,
    );
  });
});

describe('capHandoffFullText', () => {
  it('mantém texto dentro do teto e corta com marcador acima dele', () => {
    expect(capHandoffFullText('curto')).toBe('curto');
    const long = 'y'.repeat(HANDOFF_FULLTEXT_CAP_CHARS + 10);
    expect(capHandoffFullText(long)).toBe(
      `${'y'.repeat(HANDOFF_FULLTEXT_CAP_CHARS)}\n[...]`,
    );
  });
});
