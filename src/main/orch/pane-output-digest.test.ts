import { describe, expect, it } from 'vitest';
import {
  digestPaneTail,
  DIGEST_MAX_SIGNAL_LINES,
  DIGEST_TAIL_LINES,
} from './pane-output-digest';

const lines = (n: number, prefix = 'linha') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

describe('digestPaneTail', () => {
  it('janela curta: devolve as linhas não-vazias, sem marcar gap nenhum', () => {
    const digest = digestPaneTail('compilando\npronto');
    expect(digest.text).toBe('compilando\npronto');
    expect(digest.keptLines).toBe(2);
    expect(digest.omittedLines).toBe(0);
  });

  it('guarda sinais do miolo na ordem original e o tail verbatim', () => {
    const earlier = [
      'lint passou',
      'error: cannot find module ./x',
      ...lines(40),
      'warning: deprecado',
      ...lines(40),
    ];
    const tail = lines(DIGEST_TAIL_LINES + 5, 'tail');
    const digest = digestPaneTail([...earlier, ...tail].join('\n'));

    const out = digest.text.split('\n');
    expect(out[0]).toBe('…');
    expect(out[1]).toBe('error: cannot find module ./x');
    expect(out[2]).toBe('…');
    expect(out[3]).toBe('warning: deprecado');
    expect(out[4]).toBe('…');
    // Tail: as últimas 30 linhas não-vazias, verbatim e na ordem.
    expect(out.slice(5)).toEqual(tail.slice(-DIGEST_TAIL_LINES));
  });

  it('deduplica sinais repetidos e nunca passa de 12', () => {
    const earlier = Array.from(
      { length: 30 },
      (_, i) => `error: falha ${i % 3}`,
    );
    const digest = digestPaneTail(
      [...earlier, ...lines(DIGEST_TAIL_LINES, 'tail')].join('\n'),
    );
    const signalLines = digest.text
      .split('\n')
      .filter((line) => line.startsWith('error'));
    expect(signalLines).toEqual([
      'error: falha 0',
      'error: falha 1',
      'error: falha 2',
    ]);
    expect(signalLines.length).toBeLessThanOrEqual(DIGEST_MAX_SIGNAL_LINES);
  });

  it('descarta moldura de box-drawing/spinner sem contar como conteúdo', () => {
    const digest = digestPaneTail(
      [
        '┌──────────┐',
        '│ spinner ⠋ │'.replace(/[^⠋─│┌┐└┘ ]/g, ''),
        '⠋⠙⠹⠸',
        'trabalhando',
        '└──────────┘',
      ].join('\n'),
    );
    expect(digest.text).toBe('trabalhando');
    expect(digest.keptLines).toBe(1);
  });

  it('prompt de confirmação é sinal (pergunta/[y/n])', () => {
    const digest = digestPaneTail(
      [...lines(50), 'Apply these changes? [y/n]', ...lines(40, 'tail')].join(
        '\n',
      ),
    );
    expect(digest.text).toContain('Apply these changes? [y/n]');
    expect(digest.text).toContain('…');
  });

  it('sem sinal no miolo: uma única "…" marca o corte antes do tail', () => {
    const digest = digestPaneTail(
      [...lines(60), ...lines(DIGEST_TAIL_LINES, 'tail')].join('\n'),
    );
    const out = digest.text.split('\n');
    expect(out[0]).toBe('…');
    expect(out.length).toBe(DIGEST_TAIL_LINES + 1);
    expect(out.slice(1)).toEqual(lines(DIGEST_TAIL_LINES, 'tail').slice(0));
  });

  it('contagens: kept + omitted cobrem todas as linhas do input', () => {
    const input = ['error: x', ...lines(100), ...lines(20, 'tail')].join('\n');
    const digest = digestPaneTail(input);
    expect(digest.keptLines + digest.omittedLines).toBe(
      input.split('\n').length,
    );
    expect(digest.omittedLines).toBeGreaterThan(0);
  });

  it('sinal colado no tail não ganha "…" duplicado', () => {
    const digest = digestPaneTail(['ok', 'tests: 10 passed'].join('\n'));
    expect(digest.text).toBe('ok\ntests: 10 passed');
  });

  it('tail vazio e input vazio não quebram', () => {
    expect(digestPaneTail('').text).toBe('');
    expect(digestPaneTail('').keptLines).toBe(0);
  });
});
