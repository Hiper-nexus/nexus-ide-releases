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

  it('vazia, só o marcador visual presente', () => {
    expect(missionlessRouteCountsByAdapterSince(0)).toEqual(new Map([['visual:', 0]]));
  });

  it('acumula por adapter dentro da janela', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude' }, now - 1000);
    recordMissionlessRouteDecision({ adapterId: 'claude' }, now - 500);
    recordMissionlessRouteDecision({ adapterId: 'kimi' }, now - 100);
    expect(missionlessRouteCountsByAdapterSince(now - 60_000)).toEqual(
      new Map([['visual:', 0], ['claude', 2], ['kimi', 1]]),
    );
  });

  it('fora da janela não conta', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude' }, now - 8 * 24 * 60 * 60_000);
    expect(missionlessRouteCountsByAdapterSince(now - 7 * 24 * 60 * 60_000)).toEqual(
      new Map([['visual:', 0]]),
    );
  });

  it('é limitada (não cresce sem teto)', () => {
    for (let i = 0; i < 200; i += 1) {
      recordMissionlessRouteDecision({ adapterId: 'claude' }, Date.now());
    }
    expect(missionlessRouteCountsByAdapterSince(0).get('claude')).toBeLessThanOrEqual(128);
  });

  it('clearRouteProvenance zera junto', () => {
    recordMissionlessRouteDecision({ adapterId: 'claude' });
    clearRouteProvenance();
    expect(missionlessRouteCountsByAdapterSince(0)).toEqual(new Map([['visual:', 0]]));
  });
});

describe('memória de rotas sem missão — contadores visuais por modelo (F-1400 parte 2)', () => {
  beforeEach(() => clearRouteProvenance());

  it('conta visual por modelo e mantém o total por adapter', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'claude-opus-5-5', specialty: 'visual' }, now - 1000);
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'claude-opus-5-5', specialty: 'visual' }, now - 500);
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'claude-sonnet-5-5', specialty: 'visual' }, now - 100);
    expect(missionlessRouteCountsByAdapterSince(now - 60_000)).toEqual(
      new Map([
        ['visual:', 0],
        ['claude', 3],
        ['visual:claude:claude-opus-5-5', 2],
        ['visual:claude:claude-sonnet-5-5', 1],
      ]),
    );
  });

  it('especialidade não visual não gera contador visual', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude', model: 'claude-sonnet-5-5', specialty: 'bug' }, now - 1000);
    const counts = missionlessRouteCountsByAdapterSince(now - 60_000);
    expect(counts.get('claude')).toBe(1);
    expect(counts.has('visual:claude:claude-sonnet-5-5')).toBe(false);
  });

  it('sem modelo explícito não gera contador visual', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude', specialty: 'visual' }, now - 1000);
    expect(missionlessRouteCountsByAdapterSince(now - 60_000).has('visual:claude:undefined')).toBe(false);
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
