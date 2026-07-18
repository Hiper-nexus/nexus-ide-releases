import { describe, expect, it } from 'vitest';
import {
  buildOmpRouteContext,
  resolveStickyOmpAdapter,
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
