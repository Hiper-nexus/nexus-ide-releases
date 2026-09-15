import { describe, expect, it } from 'vitest';
import {
  honorSealedRosterRuntime,
  pinUniqueSealedRosterOnDecision,
  uniqueSealedRuntimeForAdapter,
} from './sealed-agent-runtime';

describe('honorSealedRosterRuntime', () => {
  it('mesmo CLI: modelo e effort selados vencem o default do route_task', () => {
    expect(
      honorSealedRosterRuntime({
        sealedCli: 'codex',
        sealedModel: 'gpt-5.6-sol',
        sealedEffort: 'high',
        requestedAdapterId: 'codex',
        requestedModel: 'gpt-5.6-luna',
        requestedEffort: 'low',
      }),
    ).toEqual({
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      rosterHonored: true,
    });
  });

  it('mesmo CLI DeepSeek: Pro selado vence Flash do ranking', () => {
    expect(
      honorSealedRosterRuntime({
        sealedCli: 'deepseek',
        sealedModel: 'deepseek-v4-pro',
        requestedAdapterId: 'deepseek',
        requestedModel: 'deepseek-v4-flash',
      }),
    ).toEqual({
      adapterId: 'deepseek',
      model: 'deepseek-v4-pro',
      effort: undefined,
      rosterHonored: true,
    });
  });

  it('Maestro omite model: o selo do roster ainda entra', () => {
    expect(
      honorSealedRosterRuntime({
        sealedCli: 'codex',
        sealedModel: 'gpt-5.6-sol',
        sealedEffort: 'xhigh',
      }),
    ).toEqual({
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      rosterHonored: true,
    });
  });

  it('CLI diferente (failover): usa a rota, não mistura o selo', () => {
    expect(
      honorSealedRosterRuntime({
        sealedCli: 'deepseek',
        sealedModel: 'deepseek-v4-pro',
        sealedEffort: 'high',
        requestedAdapterId: 'codex',
        requestedModel: 'gpt-5.6-terra',
        requestedEffort: 'medium',
      }),
    ).toEqual({
      adapterId: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      rosterHonored: false,
    });
  });
});

describe('uniqueSealedRuntimeForAdapter', () => {
  it('pina o único agente daquela CLI com modelo selado', () => {
    expect(
      uniqueSealedRuntimeForAdapter(
        [
          { cli: 'claude', model: 'claude-opus-5' },
          { cli: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
        ],
        'codex',
      ),
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
  });

  it('não pina quando dois agentes da mesma CLI têm modelos distintos', () => {
    expect(
      uniqueSealedRuntimeForAdapter(
        [
          { cli: 'codex', model: 'gpt-5.6-sol' },
          { cli: 'codex', model: 'gpt-5.6-terra' },
        ],
        'codex',
      ),
    ).toBeNull();
  });
});

describe('pinUniqueSealedRosterOnDecision', () => {
  it('substitui o default do router pelo selo único', () => {
    const pinned = pinUniqueSealedRosterOnDecision(
      {
        adapterId: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'low',
        reason: 'easy; ranking',
      },
      [{ cli: 'codex', model: 'gpt-5.6-sol', effort: 'high' }],
    );
    expect(pinned.model).toBe('gpt-5.6-sol');
    expect(pinned.effort).toBe('high');
    expect(pinned.reason).toContain('roster selado gpt-5.6-sol');
  });
});
