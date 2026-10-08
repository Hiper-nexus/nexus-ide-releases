import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../shared/usage-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  PetLifetimeTracker,
  petLevelForXp,
  petStatsPath,
  petTierForLevel,
} from './pet-stats';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nexus-pet-stats-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SCOPE: ProjectExecutionScope = {
  installationId: 'inst-1',
  projectId: 'proj-1',
  checkoutId: 'chk-1',
  rootRealPath: '/tmp/proj-1',
} as ProjectExecutionScope;

const SCOPE_B: ProjectExecutionScope = {
  ...SCOPE,
  checkoutId: 'chk-2',
  rootRealPath: '/tmp/proj-2',
} as ProjectExecutionScope;

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    byPane: {},
    byAccount: {},
    global: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
    media: { generations: 0, costUsd: 0 },
    ...over,
  };
}

describe('PetLifetimeTracker', () => {
  it('coalesces physical writes and preserves mutations arriving during asynchronous persistence', async () => {
    const tracker = new PetLifetimeTracker(dir);
    tracker.ingestSnapshot(SCOPE, snap({ global: { costUsd: 1, inputTokens: 10, outputTokens: 0, turns: 1 } }));
    const first = tracker.flushAsync();
    expect(tracker.flushAsync()).toBe(first);
    tracker.ingestSnapshot(SCOPE, snap({ global: { costUsd: 2, inputTokens: 20, outputTokens: 0, turns: 2 } }));
    await first;
    expect(JSON.parse(readFileSync(petStatsPath(dir), 'utf8')).peak.tokensBurned).toBe(10);
    expect(await tracker.flushAsync()).toBe(true);
    expect(new PetLifetimeTracker(dir).stats().tokensBurned).toBe(20);
  });
  it('começa zerado numa instalação nova', () => {
    const t = new PetLifetimeTracker(dir);
    const s = t.stats();
    expect(s.tokensBurned).toBe(0);
    expect(s.usdEquivalent).toBe(0);
    expect(s.panesServed).toBe(0);
    expect(s.missionsDone).toBe(0);
    expect(s.level).toBe(1);
    expect(s.tier).toBe('RECRUTA');
  });

  it('soma tokens/usd/turns de vários escopos', () => {
    const t = new PetLifetimeTracker(dir);
    t.ingestSnapshot(
      SCOPE,
      snap({
        global: { costUsd: 1.5, inputTokens: 10_000, outputTokens: 5_000, turns: 7 },
        byPane: {
          'pane-a': {
            paneId: 'pane-a',
            costUsd: 1,
            inputTokens: 6_000,
            outputTokens: 3_000,
            cacheReadTokens: 0,
            turns: 4,
            source: 'real',
          },
        },
      }),
    );
    t.ingestSnapshot(
      SCOPE_B,
      snap({
        global: { costUsd: 0.5, inputTokens: 2_000, outputTokens: 1_000, turns: 3 },
        byPane: {
          'pane-b': {
            paneId: 'pane-b',
            costUsd: 0.5,
            inputTokens: 2_000,
            outputTokens: 1_000,
            cacheReadTokens: 0,
            turns: 3,
            source: 'real',
          },
        },
      }),
    );
    const s = t.stats();
    expect(s.tokensBurned).toBe(18_000);
    expect(s.usdEquivalent).toBeCloseTo(2.0);
    expect(s.turns).toBe(10);
    expect(s.panesServed).toBe(2);
  });

  it('substitui (não duplica) o snapshot cumulativo do mesmo escopo', () => {
    const t = new PetLifetimeTracker(dir);
    const base = {
      costUsd: 1,
      inputTokens: 10_000,
      outputTokens: 0,
      turns: 1,
    };
    t.ingestSnapshot(SCOPE, snap({ global: base }));
    t.ingestSnapshot(
      SCOPE,
      snap({ global: { ...base, inputTokens: 12_000, turns: 2 } }),
    );
    const s = t.stats();
    expect(s.tokensBurned).toBe(12_000);
    expect(s.turns).toBe(2);
  });

  it('o piso persistido impede regressão antes do primeiro rebroadcast', () => {
    const t = new PetLifetimeTracker(dir);
    t.ingestSnapshot(
      SCOPE,
      snap({
        global: { costUsd: 4.2, inputTokens: 50_000, outputTokens: 0, turns: 9 },
      }),
    );
    t.flush();
    // "Restart": tracker novo sem nenhum escopo ingerido ainda.
    const t2 = new PetLifetimeTracker(dir);
    const s = t2.stats();
    expect(s.tokensBurned).toBe(50_000);
    expect(s.usdEquivalent).toBeCloseTo(4.2);
    expect(s.turns).toBe(9);
  });

  it('paneIds persistidos continuam contando após restart', () => {
    const t = new PetLifetimeTracker(dir);
    t.ingestSnapshot(
      SCOPE,
      snap({
        byPane: {
          'pane-x': {
            paneId: 'pane-x',
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            turns: 0,
            source: 'real',
          },
        },
      }),
    );
    t.flush();
    const t2 = new PetLifetimeTracker(dir);
    expect(t2.stats().panesServed).toBe(1);
  });

  it('missões concluídas persistem e alimentam o XP', () => {
    const t = new PetLifetimeTracker(dir);
    t.recordMissionDone();
    t.recordMissionDone();
    t.flush();
    const t2 = new PetLifetimeTracker(dir);
    expect(t2.stats().missionsDone).toBe(2);
  });

  it('counters de gamificação somam por escopo e persistem no piso', () => {
    const t = new PetLifetimeTracker(dir);
    t.ingestGamificationCounters(SCOPE, {
      mission_done: 3,
      agent_turn: 100,
      task_done: 7,
    });
    t.ingestGamificationCounters(SCOPE_B, { mission_done: 1, agent_turn: 20 });
    const s = t.stats();
    expect(s.counters.mission_done).toBe(4);
    expect(s.counters.agent_turn).toBe(120);
    expect(s.counters.task_done).toBe(7);
    // Rebroadcast cumulativo do mesmo escopo substitui — nunca duplica.
    t.ingestGamificationCounters(SCOPE_B, { mission_done: 1, agent_turn: 25 });
    expect(t.stats().counters.agent_turn).toBe(125);
  });

  it('pico persistido de counters sobrevive a checkout apagado', () => {
    const t = new PetLifetimeTracker(dir);
    t.ingestGamificationCounters(SCOPE, { mission_done: 5 });
    t.flush();
    // Restart sem o escopo: o piso mantém o total (o checkout foi apagado).
    const t2 = new PetLifetimeTracker(dir);
    expect(t2.stats().counters.mission_done).toBe(5);
    // E quando um escopo volta a reportar com valor menor, o piso segura.
    t2.ingestGamificationCounters(SCOPE, { mission_done: 2 });
    expect(t2.stats().counters.mission_done).toBe(5);
  });

  it('counters ruins no arquivo não quebram a carga', () => {
    const t = new PetLifetimeTracker(dir);
    t.ingestGamificationCounters(SCOPE, { mission_done: 2 });
    t.flush();
    // Corrompe o arquivo: counter negativo e não-numérico são descartados.
    const raw = JSON.parse(
      readFileSync(petStatsPath(dir), 'utf8'),
    ) as Record<string, unknown>;
    raw.peakCounters = { mission_done: -4, bogus: 'x', agent_turn: 9 };
    writeFileSync(petStatsPath(dir), JSON.stringify(raw));
    const t2 = new PetLifetimeTracker(dir);
    const s = t2.stats();
    expect(s.counters.mission_done).toBeUndefined();
    expect(s.counters.bogus).toBeUndefined();
    expect(s.counters.agent_turn).toBe(9);
  });

  it('o mesmo paneId em escopos distintos conta duas vezes', () => {
    const pane = {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      turns: 0,
      source: 'real' as const,
    };
    const t = new PetLifetimeTracker(dir);
    t.ingestSnapshot(
      SCOPE,
      snap({ byPane: { shared: { ...pane, paneId: 'shared' } } }),
    );
    t.ingestSnapshot(
      SCOPE_B,
      snap({ byPane: { shared: { ...pane, paneId: 'shared' } } }),
    );
    expect(t.stats().panesServed).toBe(2);
  });
});

describe('nível/tier', () => {
  it('curva de nível é monotônica e o progresso fica em 0..1', () => {
    const l1 = petLevelForXp(0);
    const l2 = petLevelForXp(25);
    const l5 = petLevelForXp(400);
    expect(l1.level).toBe(1);
    expect(l2.level).toBe(2);
    expect(l5.level).toBe(5);
    expect(l2.progress).toBeGreaterThanOrEqual(0);
    expect(l2.progress).toBeLessThanOrEqual(1);
  });

  it('tiers acompanham a escala da gamificação', () => {
    expect(petTierForLevel(1)).toBe('RECRUTA');
    expect(petTierForLevel(4)).toBe('INICIADO');
    expect(petTierForLevel(6)).toBe('VETERANO');
    expect(petTierForLevel(8)).toBe('ELITE');
    expect(petTierForLevel(10)).toBe('MAESTRO');
    expect(petTierForLevel(11)).toBe('LENDA');
  });
});

describe('rollup diário de uso (WEB-12)', () => {
  const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
  const usage = (tokens: number, costUsd: number, turns: number) =>
    snap({ global: { costUsd, inputTokens: tokens, outputTokens: 0, turns } });

  it('primeira leitura de um escopo é linha de base; o que cresce depois entra no dia', () => {
    let now = at(7);
    const t = new PetLifetimeTracker(dir, { now: () => now });
    t.ingestSnapshot(SCOPE, usage(5_000_000, 40, 900)); // histórico importado no boot
    expect(t.history().days).toEqual([]);
    t.ingestSnapshot(SCOPE, usage(5_001_000, 40.5, 902));
    now = at(8, 9);
    t.ingestSnapshot(SCOPE, usage(5_004_000, 41, 905));
    expect(t.history().days).toEqual([
      { day: '2026-10-07', tokens: 1_000, usdEquivalent: 0.5, turns: 2 },
      { day: '2026-10-08', tokens: 3_000, usdEquivalent: 0.5, turns: 3 },
    ]);
  });

  it('restart não conta duas vezes: o escopo volta com o mesmo total e reencontra a marca', () => {
    let now = at(8);
    const first = new PetLifetimeTracker(dir, { now: () => now });
    first.ingestSnapshot(SCOPE, usage(100, 1, 1));
    first.ingestSnapshot(SCOPE, usage(400, 2, 3));
    first.flush();

    now = at(8, 18);
    const second = new PetLifetimeTracker(dir, { now: () => now });
    second.ingestSnapshot(SCOPE, usage(400, 2, 3));
    expect(second.history().days).toEqual([
      { day: '2026-10-08', tokens: 300, usdEquivalent: 1, turns: 2 },
    ]);
    second.ingestSnapshot(SCOPE, usage(500, 2.5, 4));
    expect(second.history().days[0]).toEqual({
      day: '2026-10-08',
      tokens: 400,
      usdEquivalent: 1.5,
      turns: 3,
    });
  });

  it('escopos somam no mesmo dia, cada um contra a própria marca', () => {
    const t = new PetLifetimeTracker(dir, { now: () => at(8) });
    t.ingestSnapshot(SCOPE, usage(1_000, 1, 1));
    t.ingestSnapshot(SCOPE_B, usage(50, 0.5, 1));
    t.ingestSnapshot(SCOPE, usage(1_200, 1.25, 2));
    t.ingestSnapshot(SCOPE_B, usage(80, 0.75, 3));
    expect(t.history().days).toEqual([
      { day: '2026-10-08', tokens: 230, usdEquivalent: 0.5, turns: 3 },
    ]);
  });

  it('banco de escopo recriado vira nova base e não trava a contagem', () => {
    const t = new PetLifetimeTracker(dir, { now: () => at(8) });
    t.ingestSnapshot(SCOPE, usage(1_000, 1, 10));
    t.ingestSnapshot(SCOPE, usage(10, 0.25, 1)); // checkout recriado
    t.ingestSnapshot(SCOPE, usage(60, 0.5, 2));
    expect(t.history().days).toEqual([
      { day: '2026-10-08', tokens: 50, usdEquivalent: 0.25, turns: 1 },
    ]);
  });

  it('guarda no máximo 90 dias, do mais antigo ao mais novo, também no arquivo', () => {
    let now = new Date(2026, 5, 30, 12).getTime();
    const t = new PetLifetimeTracker(dir, { now: () => now });
    t.ingestSnapshot(SCOPE, usage(0, 0, 0));
    for (let day = 0; day < 100; day += 1) {
      now = new Date(2026, 6, 1 + day, 12).getTime();
      t.ingestSnapshot(SCOPE, usage((day + 1) * 10, 0, day + 1));
    }
    const days = t.history().days;
    expect(days).toHaveLength(90);
    expect(days[0]!.day < days[89]!.day).toBe(true);
    expect(days[89]).toEqual({ day: '2026-10-08', tokens: 10, usdEquivalent: 0, turns: 1 });
    t.flush();
    const persisted = JSON.parse(readFileSync(petStatsPath(dir), 'utf8'));
    expect(persisted.history.days).toHaveLength(90);
  });

  it('arquivo adulterado não derruba o tracker: entradas inválidas caem fora', () => {
    writeFileSync(
      petStatsPath(dir),
      JSON.stringify({
        peak: { tokensBurned: 10 },
        history: {
          since: 5,
          scopeMarks: { x: { tokens: 'muito' } },
          days: [{ day: 'ontem', tokens: 1 }, { day: '2026-10-01', tokens: -3, turns: 2 }],
        },
      }),
    );
    const t = new PetLifetimeTracker(dir, { now: () => at(8) });
    expect(t.history()).toMatchObject({
      since: 5,
      days: [{ day: '2026-10-01', tokens: 0, usdEquivalent: 0, turns: 2 }],
    });
  });
});
