import { beforeEach, describe, expect, it } from 'vitest';
import {
  DECISION_GRACE_MS,
  MISSIONLESS_CAP,
  adHocSpawnGateError,
  clearRouteProvenance,
  hasRecentRouteMatch,
  listDurableRouteUses,
  missionlessRouteCountsByAdapterSince,
  recordAgentSpawn,
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

  it('capacidade comporta o uso real medido — mais de 128 usos na janela contam todos', () => {
    // O teto antigo era 128 (ring de processo); ~350 spawns em 7 dias estouravam.
    for (let i = 0; i < 400; i += 1) {
      recordAgentSpawn({ adapterId: 'claude', sessionId: `s-${i}` }, Date.now() - i);
    }
    expect(missionlessRouteCountsByAdapterSince(0).get('claude')).toBe(400);
  });

  it('e continua com teto (não cresce sem limite)', () => {
    for (let i = 0; i < MISSIONLESS_CAP + 100; i += 1) {
      recordAgentSpawn({ adapterId: 'claude', sessionId: `s-${i}` }, Date.now() - i);
    }
    expect(listDurableRouteUses()).toHaveLength(MISSIONLESS_CAP);
    expect(missionlessRouteCountsByAdapterSince(0).get('claude')).toBe(MISSIONLESS_CAP);
  });

  it('clearRouteProvenance zera junto', () => {
    recordMissionlessRouteDecision({ adapterId: 'claude' });
    clearRouteProvenance();
    expect(missionlessRouteCountsByAdapterSince(0)).toEqual(new Map([['visual:', 0]]));
  });
});

describe('decisão sem missão e spawn físico do mesmo pane contam 1× (F-232)', () => {
  beforeEach(() => clearRouteProvenance());

  it('o spawn consome a decisão pendente do mesmo adapter, preservando a specialty', () => {
    const now = Date.now();
    recordMissionlessRouteDecision(
      { adapterId: 'claude', model: 'claude-opus-5-5', specialty: 'visual' },
      now - 1000,
    );
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5-5', sessionId: 'pane-1' }, now - 500);

    const uses = listDurableRouteUses();
    expect(uses).toHaveLength(1);
    expect(uses[0]?.kind).toBe('spawn');
    expect(uses[0]?.sessionId).toBe('pane-1');
    expect(uses[0]?.at).toBe(now - 500);
    expect(uses[0]?.specialty).toBe('visual');
    expect(missionlessRouteCountsByAdapterSince(now - 60_000)).toEqual(
      new Map([['visual:', 0], ['claude', 1], ['visual:claude:claude-opus-5-5', 1]]),
    );
  });

  it('decisão sozinha conta só enquanto a validade não expira', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude' }, now - DECISION_GRACE_MS - 1000);
    expect(missionlessRouteCountsByAdapterSince(0).get('claude')).toBeUndefined();

    clearRouteProvenance();
    recordMissionlessRouteDecision({ adapterId: 'claude' });
    expect(listDurableRouteUses()[0]?.kind).toBe('decision');
    expect(missionlessRouteCountsByAdapterSince(0).get('claude')).toBe(1);
  });

  it('decisão vencida não é consumida por spawn tardio: são dois fatos distintos', () => {
    const now = Date.now();
    recordMissionlessRouteDecision({ adapterId: 'claude' }, now - DECISION_GRACE_MS - 1000);
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'late' }, now - 500);
    expect(listDurableRouteUses()).toHaveLength(2);
    // a decisão vencida some da contagem, o spawn tardio conta 1
    expect(missionlessRouteCountsByAdapterSince(0).get('claude')).toBe(1);
  });

  it('spawn sem decisão conta 1 e nunca é tratado como pendência de outro adapter', () => {
    recordMissionlessRouteDecision({ adapterId: 'claude' });
    recordAgentSpawn({ adapterId: 'kimi', sessionId: 'pane-k' }, Date.now());
    expect(listDurableRouteUses()).toHaveLength(2);
    const counts = missionlessRouteCountsByAdapterSince(0);
    expect(counts.get('kimi')).toBe(1);
    expect(counts.get('claude')).toBe(1); // a decisão do claude segue pendente
    expect(listDurableRouteUses().filter((u) => u.adapterId === 'claude')[0]?.kind).toBe('decision');
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
