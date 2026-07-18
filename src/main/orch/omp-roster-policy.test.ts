import { describe, expect, it } from 'vitest';
import {
  buildOmpAutoSpawnPrompt,
  buildOmpRouteContext,
  resolveStickyOmpAdapter,
  shouldAutoSpawnOmpCompanion,
} from './omp-roster-policy';

describe('resolveStickyOmpAdapter', () => {
  it('does not sticky non-omp roster agents', () => {
    const result = resolveStickyOmpAdapter({
      rosterCli: 'codex',
      requestedAdapterId: 'kimi',
      requestedModel: 'kimi-code/kimi-for-coding',
      rosterModel: undefined,
      rosterEffort: 'medium',
      requestedEffort: undefined,
      ompInstalled: true,
      ompParticipation: 'diversity',
    });
    expect(result).toEqual({
      adapterId: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      effort: 'medium',
      sticky: false,
    });
  });

  it('forces omp when roster is omp even if route_task picked claude', () => {
    const result = resolveStickyOmpAdapter({
      rosterCli: 'omp',
      requestedAdapterId: 'claude',
      requestedModel: 'claude-sonnet-5',
      rosterModel: 'zai/glm-5',
      rosterEffort: 'high',
      requestedEffort: 'high',
      ompInstalled: true,
      ompParticipation: 'diversity',
      defaultOmpModel: 'zai/glm-5',
    });
    expect(result.adapterId).toBe('omp');
    expect(result.model).toBe('zai/glm-5');
    expect(result.effort).toBe('high');
    expect(result.sticky).toBe(true);
  });

  it('keeps route model when request already targets omp', () => {
    const result = resolveStickyOmpAdapter({
      rosterCli: 'omp',
      requestedAdapterId: 'omp',
      requestedModel: 'xai/grok-4.5',
      rosterModel: 'zai/glm-5',
      rosterEffort: 'medium',
      requestedEffort: undefined,
      ompInstalled: true,
      ompParticipation: 'prefer',
    });
    expect(result.adapterId).toBe('omp');
    expect(result.model).toBe('xai/grok-4.5');
    expect(result.sticky).toBe(false);
  });

  it('does not sticky when participation is off', () => {
    const result = resolveStickyOmpAdapter({
      rosterCli: 'omp',
      requestedAdapterId: 'claude',
      requestedModel: 'claude-sonnet-5',
      rosterModel: 'zai/glm-5',
      rosterEffort: 'high',
      requestedEffort: undefined,
      ompInstalled: true,
      ompParticipation: 'off',
    });
    expect(result.adapterId).toBe('claude');
    expect(result.sticky).toBe(false);
  });

  it('does not sticky when omp is not installed', () => {
    const result = resolveStickyOmpAdapter({
      rosterCli: 'omp',
      requestedAdapterId: 'claude',
      requestedModel: 'claude-sonnet-5',
      rosterModel: 'zai/glm-5',
      rosterEffort: 'high',
      requestedEffort: undefined,
      ompInstalled: false,
      ompParticipation: 'diversity',
    });
    expect(result.adapterId).toBe('claude');
    expect(result.sticky).toBe(false);
  });
});

describe('buildOmpRouteContext', () => {
  it('builds diversity context with used adapters', () => {
    const ctx = buildOmpRouteContext({
      ompParticipation: 'diversity',
      missionAdapterIds: ['claude', 'codex'],
      preferAdapters: ['omp'],
    });
    expect(ctx.ompParticipation).toBe('diversity');
    expect(ctx.missionUsedAdapters?.has('claude')).toBe(true);
    expect(ctx.preferAdapters).toEqual(['omp']);
  });
});

describe('shouldAutoSpawnOmpCompanion', () => {
  const base = {
    ompParticipation: 'prefer' as const,
    ompAutoSpawn: true,
    ompInstalled: true,
    justSpawnedAdapterId: 'codex',
    missionHasOmp: false,
    role: 'worker' as const,
  };

  it('spawns companion after first non-omp worker', () => {
    expect(shouldAutoSpawnOmpCompanion(base)).toBe(true);
  });

  it('skips when omp already on mission or just spawned', () => {
    expect(shouldAutoSpawnOmpCompanion({ ...base, missionHasOmp: true })).toBe(
      false,
    );
    expect(
      shouldAutoSpawnOmpCompanion({ ...base, justSpawnedAdapterId: 'omp' }),
    ).toBe(false);
  });

  it('skips when auto-spawn off or participation fallback/off', () => {
    expect(shouldAutoSpawnOmpCompanion({ ...base, ompAutoSpawn: false })).toBe(
      false,
    );
    expect(
      shouldAutoSpawnOmpCompanion({ ...base, ompParticipation: 'off' }),
    ).toBe(false);
    expect(
      shouldAutoSpawnOmpCompanion({ ...base, ompParticipation: 'fallback' }),
    ).toBe(false);
  });

  it('skips orchestrator role and missing bin', () => {
    expect(
      shouldAutoSpawnOmpCompanion({ ...base, role: 'orchestrator' }),
    ).toBe(false);
    expect(shouldAutoSpawnOmpCompanion({ ...base, ompInstalled: false })).toBe(
      false,
    );
  });
});

describe('buildOmpAutoSpawnPrompt', () => {
  it('includes mission id and autopilot instructions', () => {
    const prompt = buildOmpAutoSpawnPrompt({
      missionId: 'm-1',
      goalHint: 'Corrigir login',
    });
    expect(prompt).toContain('missionId=m-1');
    expect(prompt).toContain('Corrigir login');
    expect(prompt).toMatch(/handoff/i);
  });
});
