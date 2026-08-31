import { describe, expect, it } from 'vitest';
import { matchTerminalPaths } from './terminal-path-links';

describe('matchTerminalPaths — extração pura de caminhos clicáveis', () => {
  it('caminho com locator file.ts:12:5 vira o caminho limpo', () => {
    const line = 'error at /Users/ana/dev/proj/src/main.ts:42:7 in render';
    const matches = matchTerminalPaths(line);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      text: '/Users/ana/dev/proj/src/main.ts',
      start: line.indexOf('/Users'),
      end: line.indexOf('/Users') + '/Users/ana/dev/proj/src/main.ts'.length,
    });
  });

  it('pontuação de frase no fim não entra no caminho', () => {
    const matches = matchTerminalPaths('veja /Users/ana/report.md, depois.');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe('/Users/ana/report.md');
  });

  it('caminho dentro de parênteses descasca o parêntese', () => {
    const matches = matchTerminalPaths('falhou em (/tmp/build.log): retry');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe('/tmp/build.log');
  });

  it('linha sem caminho absoluto devolve vazio', () => {
    expect(matchTerminalPaths('nada clicável aqui, só palavras')).toEqual([]);
    expect(matchTerminalPaths('relative/path/file.ts')).toEqual([]);
  });

  it('não matchea caminho degenerado só-barra', () => {
    expect(matchTerminalPaths('root / endpoint')).toEqual([]);
  });

  it('múltiplos caminhos na mesma linha são todos capturados', () => {
    const matches = matchTerminalPaths(
      'diff /Users/a/one.ts e /Users/b/two.py',
    );
    expect(matches.map((m) => m.text)).toEqual([
      '/Users/a/one.ts',
      '/Users/b/two.py',
    ]);
  });

  it('linha gigante (log corrompido) devolve vazio sem travar', () => {
    expect(matchTerminalPaths('x'.repeat(4_000))).toEqual([]);
  });
});
