import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  type AdapterAvailability,
} from './task-router';
import type { SpecialtyBenchmark } from '../../shared/mission-route-specialty';

// F-770 (G2): a rotação garantida por missão e o fair-share 7d eram pulados
// quando a especialidade era bug/security/visual — mesmo com política
// HEURÍSTICA, em que a especialidade nem reordena adapters
// (HEURISTIC_SPECIALTY_ADAPTERS é vazio). Resultado: uma missão cheia de
// correções concentrava todos os workers no líder da tabela. Só a política
// benchmark medida pode desligar a diversidade agora; frontier/high-risk e
// a lane visual aplicada seguem protegidos. F-821: `security` voltou a ficar
// de fora (bug segue diversificando).
const adapters: AdapterAvailability[] = [
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  {
    id: 'mimo-code',
    installed: true,
    models: ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro'],
  },
  { id: 'muse', installed: true, models: ['muse-spark-1.3'] },
];

const BUG_TASK = 'corrigir o bug do login que derruba a sessão do usuário';

const routeBug = (
  global: Record<string, number>,
  mission: Record<string, number> = {},
  extra: Record<string, unknown> = {},
) =>
  routeTask(BUG_TASK, adapters, DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
    // multiScore desligado: a ordem da tabela fica crua e o efeito isolado da
    // diversidade é legível no resultado (mesmo padrão do fair-share.test).
    multiScore: false,
    missionUseCounts: new Map(Object.entries(mission)),
    globalUseCounts: new Map(Object.entries(global)),
    ...extra,
  });

describe('diversidade por especialidade (F-770)', () => {
  it('missão com specialty=bug e 3 adapters elegíveis → 3 assentos distintos', () => {
    const seats = [
      routeBug({}, {})!.adapterId,
      routeBug({}, { glm: 1 })!.adapterId,
      routeBug({}, { glm: 1, 'mimo-code': 1 })!.adapterId,
    ];
    expect(seats).toEqual(['glm', 'mimo-code', 'muse']);
    expect(new Set(seats).size).toBe(3);
  });

  it('fair-share alcança tarefa de bug com política heurística', () => {
    const decision = routeBug({ glm: 9, 'mimo-code': 0, muse: 0 });
    expect(decision!.specialty).toBe('bug');
    expect(decision!.adapterId).toBe('mimo-code');
    expect(decision!.reason).toContain('fair-share');
  });

  // F-821 (revisão ec8524a8, B5): o F-770 liberou a diversidade para bug E
  // security; num conserto de segurança de tier medium isso passava o assento
  // ao CLI menos usado, tirando o líder do multi-score. `bug` segue
  // diversificando (testes acima); `security` volta a ficar de fora.
  const SECURITY_TASK = 'corrigir o middleware de auth que aceita token expirado';
  const routeSecurity = (
    global: Record<string, number>,
    mission: Record<string, number> = {},
    tier: 'easy' | 'medium' | 'hard' = 'medium',
  ) =>
    routeTask(SECURITY_TASK, adapters, DEFAULT_ROUTING_TABLE, tier, false, undefined, {
      multiScore: false,
      missionUseCounts: new Map(Object.entries(mission)),
      globalUseCounts: new Map(Object.entries(global)),
    });

  it('fair-share NÃO alcança tarefa de segurança: o líder fica mesmo com uso 7d alto', () => {
    const decision = routeSecurity({ glm: 9, 'mimo-code': 0, muse: 0 });
    expect(decision!.specialty).toBe('security');
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).not.toContain('fair-share');
  });

  it('rotação por missão NÃO alcança tarefa de segurança: o líder já usado fica', () => {
    const decision = routeSecurity({}, { glm: 1 });
    expect(decision!.specialty).toBe('security');
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).not.toContain('rotação');
    // Mesmo cenário com bug: a rotação segue valendo (F-770).
    const bug = routeBug({}, { glm: 1 });
    expect(bug!.adapterId).toBe('mimo-code');
    expect(bug!.reason).toContain('rotação');
  });

  it('três correções de segurança seguidas não revezam assentos às cegas', () => {
    const seats = [
      routeSecurity({}, {})!.adapterId,
      routeSecurity({}, { glm: 1 })!.adapterId,
      routeSecurity({}, { glm: 1, 'mimo-code': 1 })!.adapterId,
    ];
    expect(seats).toEqual(['glm', 'glm', 'glm']);
  });

  it('o mesmo texto SEM especialidade de segurança continua diversificando', () => {
    const decision = routeTask(
      'ajustar o middleware de logs que escreve o timestamp errado',
      adapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      {
        multiScore: false,
        missionUseCounts: new Map([['glm', 1]]),
        globalUseCounts: new Map<string, number>(),
      },
    );
    expect(decision!.specialty).not.toBe('security');
    expect(decision!.adapterId).toBe('mimo-code');
    expect(decision!.reason).toContain('rotação');
  });

  it('benchmark medido preserva a ordem — a rotação não promove assento fresco', () => {
    const bugBenchmark: SpecialtyBenchmark = {
      schemaVersion: 1,
      source: 'nexus-benchmark/2026-10-03',
      specialties: {
        bug: [
          { adapterId: 'glm', model: 'glm-5.3', score: 92 },
          { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-pro', score: 88 },
        ],
      },
    };
    const decision = routeBug(
      { glm: 9, 'mimo-code': 0, muse: 0 },
      { glm: 1 },
      { specialtyBenchmark: bugBenchmark },
    );
    expect(decision!.policySource).toBe('benchmark');
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).not.toContain('rotação');
    expect(decision!.reason).not.toContain('fair-share');
  });
});
