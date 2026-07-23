import { describe, expect, it } from 'vitest';
import {
  buildClarify,
  parseClarifyAnswerArtifact,
  parseClarifyQuestionArtifact,
  resolveClarifyAnswer,
} from './clarify';

describe('buildClarify', () => {
  it('normaliza opções em chips com id estável', () => {
    const c = buildClarify({
      question: 'Qual banco?',
      options: ['Postgres', 'MySQL', 'SQLite'],
    });
    expect(c.question).toBe('Qual banco?');
    expect(c.chips.map((chip) => chip.label)).toEqual(['Postgres', 'MySQL', 'SQLite']);
    expect(c.chips[0].id).toBe('opt-1');
    expect(c.allowFreeform).toBe(true);
  });

  it('rejeita menos de 2 opções', () => {
    expect(() => buildClarify({ question: 'x', options: ['só uma'] })).toThrow(/opç/i);
  });

  it('rejeita pergunta vazia', () => {
    expect(() => buildClarify({ question: '  ', options: ['a', 'b'] })).toThrow(/pergunta/i);
  });

  it('limita a 6 opções', () => {
    expect(() =>
      buildClarify({ question: 'x', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
    ).toThrow(/6/);
  });

  it('rejeita opções duplicadas ou com controles', () => {
    expect(() =>
      buildClarify({ question: 'x', options: ['Postgres', 'postgres'] }),
    ).toThrow(/duplicad/i);
    expect(() =>
      buildClarify({ question: 'x', options: ['válida', 'quebra\u0000'] }),
    ).toThrow(/controle/i);
  });

  it('allowFreeform pode ser desligado', () => {
    const c = buildClarify({ question: 'x', options: ['a', 'b'], allowFreeform: false });
    expect(c.allowFreeform).toBe(false);
  });
});

describe('durable clarify artifact parsing', () => {
  it('aceita apenas ids de chip determinísticos', () => {
    const valid = {
      kind: 'nexus-clarify-question',
      schemaVersion: 1,
      clarify: {
        question: 'Qual banco?',
        chips: [
          { id: 'opt-1', label: 'Postgres' },
          { id: 'opt-2', label: 'SQLite' },
        ],
        allowFreeform: false,
      },
    };
    expect(parseClarifyQuestionArtifact(valid)?.clarify.chips).toHaveLength(2);
    expect(
      parseClarifyQuestionArtifact({
        ...valid,
        clarify: {
          ...valid.clarify,
          chips: [
            { id: 'forjado', label: 'Postgres' },
            valid.clarify.chips[1],
          ],
        },
      }),
    ).toBeNull();
  });

  it('rejeita envelopes de resposta malformados', () => {
    expect(
      parseClarifyAnswerArtifact({
        kind: 'nexus-clarify-answer',
        schemaVersion: 1,
        questionId: 'question-a',
        answer: { kind: 'chip', chipId: 'opt-1', value: 'Postgres' },
      }),
    ).toMatchObject({ questionId: 'question-a' });
    expect(
      parseClarifyAnswerArtifact({
        kind: 'nexus-clarify-answer',
        schemaVersion: 1,
        questionId: '../question-a',
        answer: { kind: 'chip', chipId: 'opt-99', value: 'Postgres' },
      }),
    ).toBeNull();
  });
});

describe('resolveClarifyAnswer', () => {
  const clarify = buildClarify({ question: 'Qual banco?', options: ['Postgres', 'MySQL'] });

  it('roteia resposta por id de chip', () => {
    const r = resolveClarifyAnswer(clarify, 'opt-2');
    expect(r).toEqual({ kind: 'chip', chipId: 'opt-2', value: 'MySQL' });
  });

  it('roteia resposta por texto exato do chip (case-insensitive)', () => {
    expect(resolveClarifyAnswer(clarify, 'postgres')).toMatchObject({
      kind: 'chip',
      value: 'Postgres',
    });
  });

  it('roteia por índice 1-based', () => {
    expect(resolveClarifyAnswer(clarify, '2')).toMatchObject({ kind: 'chip', value: 'MySQL' });
  });

  it('texto livre vira freeform quando permitido', () => {
    expect(resolveClarifyAnswer(clarify, 'MariaDB, na verdade')).toEqual({
      kind: 'freeform',
      value: 'MariaDB, na verdade',
    });
  });

  it('texto livre é rejeitado quando allowFreeform=false', () => {
    const strict = buildClarify({ question: 'x', options: ['a', 'b'], allowFreeform: false });
    expect(resolveClarifyAnswer(strict, 'outra coisa')).toEqual({ kind: 'unmatched' });
  });

  it('resposta vazia é unmatched', () => {
    expect(resolveClarifyAnswer(clarify, '   ')).toEqual({ kind: 'unmatched' });
  });

  it('índice fora do range cai em freeform quando permitido', () => {
    expect(resolveClarifyAnswer(clarify, '9')).toEqual({ kind: 'freeform', value: '9' });
    expect(resolveClarifyAnswer(clarify, '0')).toEqual({ kind: 'freeform', value: '0' });
  });

  it('índice fora do range é unmatched quando allowFreeform=false', () => {
    const strict = buildClarify({ question: 'x', options: ['a', 'b'], allowFreeform: false });
    expect(resolveClarifyAnswer(strict, '9')).toEqual({ kind: 'unmatched' });
    expect(resolveClarifyAnswer(strict, '0')).toEqual({ kind: 'unmatched' });
  });
});
