import { describe, expect, it } from 'vitest';

import {
  attributeSessionFootprints,
  parseRssProcessTable,
  summarizeFootprints,
} from './pane-footprint';

/** `lstart` do `ps` (LANG=C) é hora local com precisão de 1 s. */
const STARTED = 'Wed Oct  7 10:00:00 2026';
const startedAtMs = new Date(2026, 9, 7, 10, 0, 0).getTime();
/** O host grava o spawn em ms; o `lstart` trunca para o segundo. */
const spawnedAtMs = startedAtMs + 400;

describe('pane-footprint (F-572): RSS da árvore de processos por sessão', () => {
  const table = parseRssProcessTable(
    [
      `    1     0   1000 ${STARTED}`,
      ` 4223  4212   3000 ${STARTED}`, // supervisor (root da sessão A)
      ` 4225  4223 507000 ${STARTED}`, // claude
      ` 4253  4225  48000 ${STARTED}`, // mcp filho
      ` 4254  4225  48000 ${STARTED}`, // mcp filho
      ` 9000     1   2000 ${STARTED}`, // fora da árvore
      ` 5100  5000   4000 ${STARTED}`, // root da sessão B
      ` 5101  5100  90000 ${STARTED}`,
    ].join('\n'),
  );

  it('parseia pid/ppid/rss em KB/início e ignora linhas quebradas', () => {
    expect(parseRssProcessTable(`  x y z\n 12 1 300 ${STARTED}   \n 13 1 300\n`)).toEqual([
      { pid: 12, ppid: 1, rssKB: 300, startedAtMs },
    ]);
  });

  it('atribui root + descendentes a cada sessão', () => {
    const out = attributeSessionFootprints(table, [
      { sessionId: 'A', rootPid: 4223, spawnedAtMs },
      { sessionId: 'B', rootPid: 5100, spawnedAtMs },
    ]);
    expect(out).toEqual([
      { sessionId: 'A', rootPid: 4223, processCount: 4, rssBytes: (3000 + 507000 + 48000 + 48000) * 1024 },
      { sessionId: 'B', rootPid: 5100, processCount: 2, rssBytes: (4000 + 90000) * 1024 },
    ]);
  });

  it('root ausente (pid reciclado) vira footprint nulo, nunca chuta', () => {
    const out = attributeSessionFootprints(table, [{ sessionId: 'Z', rootPid: 777, spawnedAtMs }]);
    expect(out).toEqual([{ sessionId: 'Z', rootPid: 777, processCount: 0, rssBytes: null }]);
  });

  it('PID reutilizado com outro início não herda o footprint da sessão', () => {
    const root = { sessionId: 'A', rootPid: 4223, spawnedAtMs };
    const before = attributeSessionFootprints(
      parseRssProcessTable(` 4223  4212   3000 ${STARTED}\n 4225  4223 507000 ${STARTED}`),
      [root],
    );
    expect(before[0]?.rssBytes).toBe((3000 + 507000) * 1024);

    // O root morreu e o kernel deu o mesmo PID a um processo estranho, que
    // nasceu 5 minutos depois do spawn da sessão (com filho próprio).
    const reused = attributeSessionFootprints(
      parseRssProcessTable(
        ' 4223     1 900000 Wed Oct  7 10:05:00 2026\n 4300  4223  1000 Wed Oct  7 10:05:01 2026',
      ),
      [root],
    );
    expect(reused).toEqual([{ sessionId: 'A', rootPid: 4223, processCount: 0, rssBytes: null }]);
  });

  it('tolera a precisão de segundo do lstart (e o tremor de 1 s do btime no Linux)', () => {
    const late = { sessionId: 'A', rootPid: 4223, spawnedAtMs: startedAtMs + 1_900 };
    const early = { sessionId: 'A', rootPid: 4223, spawnedAtMs: startedAtMs - 1_900 };
    for (const root of [late, early]) {
      expect(attributeSessionFootprints(table, [root])[0]?.rssBytes).not.toBeNull();
    }
  });

  it('pid duplicado na tabela invalida a atribuição inteira', () => {
    const dup = [...table, { pid: 4225, ppid: 1, rssKB: 1, startedAtMs }];
    const out = attributeSessionFootprints(dup, [{ sessionId: 'A', rootPid: 4223, spawnedAtMs }]);
    expect(out[0]?.rssBytes).toBeNull();
  });

  it('resume total e os maiores', () => {
    const out = attributeSessionFootprints(table, [
      { sessionId: 'A', rootPid: 4223, spawnedAtMs },
      { sessionId: 'B', rootPid: 5100, spawnedAtMs },
    ]);
    const summary = summarizeFootprints(out);
    expect(summary.totalRssBytes).toBe((3000 + 507000 + 48000 + 48000 + 4000 + 90000) * 1024);
    expect(summary.sessions).toBe(2);
    expect(summary.largest?.sessionId).toBe('A');
  });
});
