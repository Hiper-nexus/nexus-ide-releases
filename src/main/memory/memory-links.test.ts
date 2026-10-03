import { describe, expect, it } from 'vitest';
import {
  extractMemoryLinkTargets,
  fileLinkTarget,
  filePathsOfTargets,
  memorySubjectKey,
} from './memory-links';

describe('memory-links — arestas derivadas do texto (F-800/F-801)', () => {
  it('liga caminhos citados, wikilinks, a linha Mission: e a atribuição do operador', () => {
    const targets = extractMemoryLinkTargets(
      [
        '# Pool do PostgreSQL',
        '',
        'O pool vive em src/main/db/pool.ts e é lido por [[src/main/db/client.ts]].',
        'Ver também [[Decisão do cache|cache]] e https://exemplo.com/a/b.ts.',
        'Mission: m-42',
      ].join('\n'),
      'operator:mission:m-7',
    );
    expect(targets).toEqual(
      expect.arrayContaining([
        'file:src/main/db/pool.ts',
        'file:src/main/db/client.ts',
        'note:decisao do cache',
        'mission:m-42',
        'mission:m-7',
      ]),
    );
    // URL não é arquivo do repo.
    expect(targets.some((t) => t.includes('exemplo.com'))).toBe(false);
    expect(filePathsOfTargets(targets).sort()).toEqual([
      'src/main/db/client.ts',
      'src/main/db/pool.ts',
    ]);
  });

  it('normaliza caminhos e recusa o que sai do repo', () => {
    expect(fileLinkTarget('./src\\main\\x.ts')).toBe('file:src/main/x.ts');
    expect(fileLinkTarget('../etc/passwd')).toBeNull();
    expect(fileLinkTarget('/abs/path.ts')).toBeNull();
  });

  it('a chave de assunto vem só de um heading real; rótulos genéricos não são assunto', () => {
    expect(memorySubjectKey('# Regra do Pool  do PostgreSQL\n\ncorpo')).toBe(
      'regra do pool do postgresql',
    );
    expect(memorySubjectKey('#   Regra do pool do PostgreSQL!')).toBe(
      'regra do pool do postgresql',
    );
    expect(memorySubjectKey('sem heading\n# depois')).toBeNull();
    expect(memorySubjectKey('# Delivered handoff\n\nSummary: x')).toBeNull();
    expect(memorySubjectKey('# Session digest')).toBeNull();
    expect(memorySubjectKey('# Operator preference')).toBeNull();
    expect(memorySubjectKey('#sem espaço')).toBeNull();
  });

  it('limita o número de alvos por memória', () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/a/f${i}.ts`).join(' ');
    expect(extractMemoryLinkTargets(many).length).toBeLessThanOrEqual(64);
  });
});

describe('F-764: varredura linear em texto de agente (memory-links)', () => {
  const SIZE = 16_384;
  const inputs: Array<[string, string]> = [
    ['só barras', '/'.repeat(SIZE)],
    ['segmentos sem extensão', 'aaaa/'.repeat(SIZE / 5)],
    ['pontos sem barra', 'a.'.repeat(SIZE / 2)],
    ['uma barra e muitos pontos', `x/${'a.'.repeat(SIZE / 2)}`],
    ['parênteses e barras', '(a/'.repeat(SIZE / 3)],
    ['wikilinks abertos', '[['.repeat(SIZE / 2)],
    ['Mission: repetido', 'Mission: \n'.repeat(SIZE / 10)],
    ['hífens e sublinhados', '-_'.repeat(SIZE / 2)],
    ['espaços e pontos', ' .'.repeat(SIZE / 2)],
  ];

  it.each(inputs)('%s: tempo linear', (_label, text) => {
    extractMemoryLinkTargets(text);
    memorySubjectKey(text);
    const startedAt = performance.now();
    extractMemoryLinkTargets(text);
    memorySubjectKey(text);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(50);
  });
});
