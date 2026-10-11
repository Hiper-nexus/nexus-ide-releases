import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FOOTPRINT_PS_ARGS,
  attributeSessionFootprints,
  footprintPsEnv,
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

// F-1001: no Linux o lstart é btime + starttime/HZ, e o btime segue o relógio de
// parede. Um ajuste do relógio (resume do suspend, passo do NTP) desloca o
// lstart de TODOS os processos; com |diff| > 2 s o root virava null para
// sempre e o badge de RAM sumia. O root da sessão é filho direto do PTY host.
describe('pane-footprint (F-1001): root filho direto do host sobrevive a ajuste do relógio', () => {
  const HOST = 4212;
  const root = { sessionId: 'A', rootPid: 4223, spawnedAtMs };
  const shifted = (seconds: number) => {
    const at = new Date(startedAtMs + seconds * 1_000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, ' ');
    const stamp = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][at.getMonth()]} ${day} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${at.getFullYear()}`;
    return parseRssProcessTable(
      [` ${HOST}     1  80000 ${stamp}`, ` 4223  ${HOST}   3000 ${stamp}`, ` 4225  4223 507000 ${stamp}`].join('\n'),
    );
  };

  it('relógio deslocado +3 s / +5 min: o root filho do host continua atribuído', () => {
    for (const seconds of [3, 300, -90]) {
      const out = attributeSessionFootprints(shifted(seconds), [root], { pid: HOST });
      expect(out, `${seconds} s`).toEqual([{ sessionId: 'A', rootPid: 4223, processCount: 2, rssBytes: (3000 + 507000) * 1024 }]);
    }
  });

  it('PID reciclado continua null: outro pai, o próprio ps do host, ou dois roots com o mesmo PID', () => {
    const foreign = parseRssProcessTable(' 4223     1 900000 Wed Oct  7 10:05:00 2026');
    expect(attributeSessionFootprints(foreign, [root], { pid: HOST })[0]?.rssBytes).toBeNull();
    const psChild = parseRssProcessTable(` 4223  ${HOST}   900 Wed Oct  7 10:05:00 2026`);
    expect(attributeSessionFootprints(psChild, [root], { pid: HOST, transientPids: [4223] })[0]?.rssBytes).toBeNull();
    // A sessão nova herdou o PID antes de a velha sair do mapa: só quem bate o início fica.
    const fresh = { sessionId: 'B', rootPid: 4223, spawnedAtMs: startedAtMs + 300_400 };
    const table = parseRssProcessTable(` 4223  ${HOST}   3000 Wed Oct  7 10:05:00 2026`);
    expect(attributeSessionFootprints(table, [root, fresh], { pid: HOST }).map((item) => item.rssBytes)).toEqual([null, 3000 * 1024]);
  });

  it('sem o PID do host, a regra continua só PID + início', () => {
    expect(attributeSessionFootprints(shifted(3), [root])[0]?.rssBytes).toBeNull();
  });
});

// F-1001: nada executava o `ps` real nem provava o LANG/LC_ALL=C. Em pt-BR o
// `lstart` sai "qui  8 out 00:14:49 2026" e o parse achava 0 de 630 linhas.
const psBinary = ['/bin/ps', '/usr/bin/ps'].find((candidate) => fs.existsSync(candidate));
const ptBR = { LANG: 'pt_BR.UTF-8', LC_ALL: 'pt_BR.UTF-8', LC_TIME: 'pt_BR.UTF-8' };

describe('pane-footprint (F-1001): o ps real da máquina', () => {
  it('o env do host força C mesmo com o locale do operador em pt-BR', () => {
    const env = footprintPsEnv({ PATH: '/usr/bin:/bin', ...ptBR });
    expect(env).toMatchObject({ LANG: 'C', LC_ALL: 'C', LC_TIME: 'C', PATH: '/usr/bin:/bin' });
    // A forma localizada não é lida: sem C, o parse falharia.
    expect(parseRssProcessTable(' 4223  4212   3000 qui  8 out 00:14:49 2026')).toEqual([]);
  });

  it.skipIf(!psBinary)('com o env do host, o parse acha o próprio processo do teste (todas as linhas)', () => {
    const output = execFileSync(psBinary!, [...FOOTPRINT_PS_ARGS], {
      env: footprintPsEnv({ ...process.env, ...ptBR }),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const lines = output.split('\n').filter((line) => line.trim() !== '');
    const rows = parseRssProcessTable(output);
    expect(rows.length).toBe(lines.length);
    const own = rows.find((row) => row.pid === process.pid);
    expect(own).toBeDefined();
    expect(own!.ppid).toBe(process.ppid);
    const startedWallMs = Date.now() - process.uptime() * 1_000;
    expect(Math.abs(own!.startedAtMs - startedWallMs)).toBeLessThan(5_000);
    const [footprint] = attributeSessionFootprints(rows, [
      { sessionId: 'self', rootPid: process.pid, spawnedAtMs: startedWallMs },
    ], { pid: process.ppid });
    expect(footprint!.rssBytes).toBeGreaterThan(0);
  });

  it.skipIf(!psBinary)('sem forçar C, um locale pt-BR instalado quebra o parse (por isso o env do host)', (ctx) => {
    const run = (env: NodeJS.ProcessEnv) => execFileSync(psBinary!, ['-o', 'pid=,ppid=,rss=,lstart=', '-p', String(process.pid)], { env, encoding: 'utf8' });
    const localized = run({ ...process.env, ...ptBR });
    const c = run(footprintPsEnv({ ...process.env, ...ptBR }));
    // Só a data depende do locale; o RSS muda entre duas chamadas do ps.
    const lstart = (env: NodeJS.ProcessEnv) => execFileSync(psBinary!, ['-o', 'lstart=', '-p', String(process.pid)], { env, encoding: 'utf8' });
    if (lstart({ ...process.env, ...ptBR }) === lstart(footprintPsEnv({ ...process.env, ...ptBR }))) ctx.skip(); // locale pt_BR não instalado nesta máquina
    expect(parseRssProcessTable(localized)).toEqual([]);
    expect(parseRssProcessTable(c).map((row) => row.pid)).toEqual([process.pid]);
  });
});
