import { describe, expect, it } from 'vitest';

import {
  attributeSessionFootprints,
  parseRssProcessTable,
  summarizeFootprints,
} from './pane-footprint';

describe('pane-footprint (F-572): RSS da árvore de processos por sessão', () => {
  const table = parseRssProcessTable(
    [
      '    1     0   1000',
      ' 4223  4212   3000', // supervisor (root da sessão A)
      ' 4225  4223 507000', // claude
      ' 4253  4225  48000', // mcp filho
      ' 4254  4225  48000', // mcp filho
      ' 9000     1   2000', // fora da árvore
      ' 5100  5000  4000', // root da sessão B
      ' 5101  5100 90000',
    ].join('\n'),
  );

  it('parseia pid/ppid/rss em KB e ignora linhas quebradas', () => {
    expect(parseRssProcessTable('  x y z\n 12 1 300\n')).toEqual([
      { pid: 12, ppid: 1, rssKB: 300 },
    ]);
  });

  it('atribui root + descendentes a cada sessão', () => {
    const out = attributeSessionFootprints(table, [
      { sessionId: 'A', rootPid: 4223 },
      { sessionId: 'B', rootPid: 5100 },
    ]);
    expect(out).toEqual([
      { sessionId: 'A', rootPid: 4223, processCount: 4, rssBytes: (3000 + 507000 + 48000 + 48000) * 1024 },
      { sessionId: 'B', rootPid: 5100, processCount: 2, rssBytes: (4000 + 90000) * 1024 },
    ]);
  });

  it('root ausente (pid reciclado) vira footprint nulo, nunca chuta', () => {
    const out = attributeSessionFootprints(table, [{ sessionId: 'Z', rootPid: 777 }]);
    expect(out).toEqual([{ sessionId: 'Z', rootPid: 777, processCount: 0, rssBytes: null }]);
  });

  it('pid duplicado na tabela invalida a atribuição inteira', () => {
    const dup = [...table, { pid: 4225, ppid: 1, rssKB: 1 }];
    const out = attributeSessionFootprints(dup, [{ sessionId: 'A', rootPid: 4223 }]);
    expect(out[0]?.rssBytes).toBeNull();
  });

  it('resume total e os maiores', () => {
    const out = attributeSessionFootprints(table, [
      { sessionId: 'A', rootPid: 4223 },
      { sessionId: 'B', rootPid: 5100 },
    ]);
    const summary = summarizeFootprints(out);
    expect(summary.totalRssBytes).toBe((3000 + 507000 + 48000 + 48000 + 4000 + 90000) * 1024);
    expect(summary.sessions).toBe(2);
    expect(summary.largest?.sessionId).toBe('A');
  });
});
