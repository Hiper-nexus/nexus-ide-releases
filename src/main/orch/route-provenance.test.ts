import { beforeEach, describe, expect, it } from 'vitest';
import {
  adHocSpawnGateError,
  clearRouteProvenance,
  hasRecentRouteMatch,
  missionlessRouteCountsByAdapterSince,
  recordMissionlessRouteDecision,
  recordRouteDecision,
} from './route-provenance';

const WARNED = { warning: 'New xAI model; verify tier/pricing before making it the default.' };

describe('route provenance', () => {
  beforeEach(() => clearRouteProvenance());

  it('sem registro, não há match', () => {
    expect(hasRecentRouteMatch('grok', 'grok-4.1')).toBe(false);
  });

  it('decisão registrada vira proveniência para adapter+model exatos', () => {
    recordRouteDecision({ adapterId: 'grok', model: 'grok-4.1' });
    expect(hasRecentRouteMatch('grok', 'grok-4.1')).toBe(true);
    expect(hasRecentRouteMatch('grok', 'grok-4.5')).toBe(false);
    expect(hasRecentRouteMatch('codex', 'grok-4.1')).toBe(false);
  });

  it('mantém apenas as decisões recentes (ring com cap)', () => {
    recordRouteDecision({ adapterId: 'grok', model: 'grok-4.1' });
    for (let i = 0; i < 32; i += 1) {
      recordRouteDecision({ adapterId: 'codex', model: `gpt-x-${i}` });
    }
    expect(hasRecentRouteMatch('grok', 'grok-4.1')).toBe(false);
    expect(hasRecentRouteMatch('codex', 'gpt-x-31')).toBe(true);
  });
});

describe('memória de rotas sem missão (F-1291)', () => {
  beforeEach(() => clearRouteProvenance());

  it('vazia, não conta nada', () => {
    expect(missionlessRouteCountsByAdapterSince(0).size).toBe(0);
  });

  it('acumula por adapter dentro da janela', () => {
    const now = Date.now();
    recordMissionlessRouteDecision('claude', now - 1000);
    recordMissionlessRouteDecision('claude', now - 500);
    recordMissionlessRouteDecision('kimi', now - 100);
    expect(missionlessRouteCountsByAdapterSince(now - 60_000)).toEqual(
      new Map([['claude', 2], ['kimi', 1]]),
    );
  });

  it('fora da janela não conta', () => {
    const now = Date.now();
    recordMissionlessRouteDecision('claude', now - 8 * 24 * 60 * 60_000);
    expect(
      missionlessRouteCountsByAdapterSince(now - 7 * 24 * 60 * 60_000).size,
    ).toBe(0);
  });

  it('é limitada (não cresce sem teto)', () => {
    for (let i = 0; i < 200; i += 1) {
      recordMissionlessRouteDecision('claude', Date.now());
    }
    expect(missionlessRouteCountsByAdapterSince(0).get('claude')).toBeLessThanOrEqual(128);
  });

  it('clearRouteProvenance zera junto', () => {
    recordMissionlessRouteDecision('claude');
    clearRouteProvenance();
    expect(missionlessRouteCountsByAdapterSince(0).size).toBe(0);
  });
});

describe('adHocSpawnGateError', () => {
  beforeEach(() => clearRouteProvenance());

  it('modelo sem warning passa direto', () => {
    expect(adHocSpawnGateError('grok', 'grok-4.1', {})).toBeNull();
    expect(adHocSpawnGateError('grok', 'grok-4.1', null)).toBeNull();
  });

  it('modelo com warning SEM decisão do router é recusado com instrução', () => {
    const error = adHocSpawnGateError('grok', 'grok-4.5', WARNED);
    expect(error).toBeTruthy();
    expect(error).toContain('nexus_route_task');
    expect(error).toContain('grok-4.5');
  });

  it('modelo com warning COM decisão registrada passa', () => {
    recordRouteDecision({ adapterId: 'grok', model: 'grok-4.5' });
    expect(adHocSpawnGateError('grok', 'grok-4.5', WARNED)).toBeNull();
  });

  it('spawn sem model explícito não é gateado aqui', () => {
    expect(adHocSpawnGateError('grok', undefined, WARNED)).toBeNull();
  });
});
