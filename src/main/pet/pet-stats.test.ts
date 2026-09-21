import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../shared/usage-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  PetLifetimeTracker,
  petLevelForXp,
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
