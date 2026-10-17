import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AtomicWrite = typeof import('../util/atomic-write').writeFileAtomicAsync;

// A gravação real continua valendo (arquivo de verdade em tmp); o spy só conta
// as chamadas e deixa cada teste atrasar ou segurar uma delas.
const real = vi.hoisted(() => ({ write: undefined as unknown as AtomicWrite }));
vi.mock('../util/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util/atomic-write')>();
  real.write = actual.writeFileAtomicAsync;
  return { ...actual, writeFileAtomicAsync: vi.fn(actual.writeFileAtomicAsync) };
});

import { writeFileAtomicAsync } from '../util/atomic-write';
import {
  clearRouteProvenance,
  configureMissionlessPersistence,
  flushRouteProvenance,
  recordAgentSpawn,
  resetRouteProvenancePersistence,
} from './route-provenance';

const writeSpy = vi.mocked(writeFileAtomicAsync);
// Só o debounce é falso: Date e I/O seguem reais, então a gravação em tmp acontece de verdade.
const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout'] };

/** Segura a próxima gravação no portão do rename (tmp já escrito, arquivo ainda não publicado). */
function holdNextWriteAtCommit(): { atCommit: Promise<void>; release: () => void } {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atCommit = new Promise<void>((resolve) => { reached = resolve; });
  writeSpy.mockImplementationOnce((target, value, mode, options) =>
    real.write(target, value, mode, {
      ...options,
      beforeCommit: async () => {
        reached();
        await gate;
        await options?.beforeCommit?.();
      },
    }),
  );
  return { atCommit, release };
}

// Revisão adversarial do N1 (debounce da persistência do contador sem missão).
describe('persistência debounced do contador de rotas sem missão', () => {
  let dir: string;
  const file = () => path.join(dir, 'missionless-route-uses.json');
  const saved = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as Array<{ sessionId?: string }>;
  const savedSessions = () => saved().map((use) => use.sessionId);
  const seedFile = (sessions: string[]) => {
    const now = Date.now();
    fs.writeFileSync(
      file(),
      JSON.stringify(
        sessions.map((sessionId, i) => ({ adapterId: 'claude', sessionId, kind: 'spawn', at: now - 1000 + i })),
      ),
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-prov-debounce-'));
    writeSpy.mockReset();
    writeSpy.mockImplementation(real.write);
    configureMissionlessPersistence(dir);
  });
  afterEach(() => {
    resetRouteProvenancePersistence();
    vi.useRealTimers();
    configureMissionlessPersistence(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('o timer grava o arquivo sozinho, sem flush, e o flush seguinte não regrava', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    recordAgentSpawn({ adapterId: 'claude', sessionId: 's1' });
    expect(fs.existsSync(file())).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(savedSessions()).toEqual(['s1']));

    await flushRouteProvenance(); // nada ficou sujo depois da gravação do timer
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('sem regravação ociosa: um registro e 10 s depois há exatamente uma gravação', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    writeSpy.mockImplementation(async () => undefined); // disco instantâneo: era o que reagendava a cada gravação
    recordAgentSpawn({ adapterId: 'claude', sessionId: 's1' });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flush com o contador não carregado preserva o arquivo existente', async () => {
    // Sessão que só retoma panes: recordAgentSpawn é pulado (req.resume) e ninguém lê o contador.
    seedFile(['a', 'b', 'c']);

    await flushRouteProvenance();

    expect(savedSessions()).toEqual(['a', 'b', 'c']);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('reinício simulado com gravação pendente não zera o arquivo do contador novo', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'antes-do-reinicio' });
    seedFile(['a', 'b', 'c']);
    configureMissionlessPersistence(dir); // memória zera; o timer velho não pode gravar a lista vazia

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(savedSessions()).toEqual(['a', 'b', 'c']);
  });

  it('flush atrás de uma gravação em voo termina com o estado mais novo', async () => {
    // Disco lento: a gravação do snapshot velho só termina depois de a do novo ter sido pedida.
    writeSpy.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return real.write(...args);
    });
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'velho' });
    const first = flushRouteProvenance();
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'novo' });

    await Promise.all([first, flushRouteProvenance()]);

    expect(savedSessions()).toEqual(['velho', 'novo']);
  });

  it('clearRouteProvenance cancela o timer e não deixa gravação em voo ou na fila ressuscitar o arquivo', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const hold = holdNextWriteAtCommit();
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'em-voo' });
    const inFlight = flushRouteProvenance();
    await hold.atCommit;
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'na-fila' });
    const queued = flushRouteProvenance();
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'no-timer' });

    clearRouteProvenance();
    hold.release();
    await Promise.all([inFlight, queued]);

    expect(fs.readdirSync(dir)).toEqual([]); // nem o arquivo nem sobra de .tmp
    expect(vi.getTimerCount()).toBe(0);
  });
});
