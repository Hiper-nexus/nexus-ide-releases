import { describe, expect, it } from 'vitest';
import { buildClarify, resolveClarifyAnswer } from './clarify';

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

  it('allowFreeform pode ser desligado', () => {
    const c = buildClarify({ question: 'x', options: ['a', 'b'], allowFreeform: false });
    expect(c.allowFreeform).toBe(false);
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
});
