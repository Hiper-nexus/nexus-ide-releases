import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  JUDGE_FRONTIER_LANE,
  routeTask,
  type AdapterAvailability,
} from './task-router';

// F-233 (regra do operador, 01/10): revisão/auditoria/veredito só com modelos
// de ponta — GLM/MiMo davam "veredito APROVAR" em revisão de código. A lane
// de julgamento reutiliza a mecânica da lane visual; sem assento disponível,
// `judgeUnavailable` devolve o julgamento ao Maestro.
const frontierAdapters: AdapterAvailability[] = [
  {
    id: 'claude',
    installed: true,
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  },
  {
    id: 'codex',
    installed: true,
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
  },
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'mimo-code', installed: true, models: ['xiaomi/mimo-v2.6-flash'] },
];

const cheapAdapters: AdapterAvailability[] = [
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'mimo-code', installed: true, models: ['xiaomi/mimo-v2.6-flash'] },
];

const ctx = () => ({ multiScore: false });

describe('lane de julgamento (F-233: só modelos de ponta julgam)', () => {
  it('revisão com claude reservado cai no Codex Sol 6.1 da lane', () => {
    const decision = routeTask(
      'Revisão de segurança do commit 464f658e',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      true, // claude reservado ao Maestro
      undefined,
      ctx(),
    );
    expect(decision).not.toBeNull();
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-6.1-sol');
    expect(decision!.reason).toContain('lane de julgamento');
    expect(decision!.judgeUnavailable).toBeUndefined();
  });

  it('sinal novo "auditoria" também entra na lane (somente leitura)', () => {
    const decision = routeTask(
      'Auditoria somente leitura do módulo de licença',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      true,
      undefined,
      ctx(),
    );
    expect(decision!.reason).toContain('lane de julgamento');
    // Mesma lane: com claude reservado, o primeiro assento livre é o Sol 6.1.
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-6.1-sol');
  });

  it('Fable lidera a lane quando o claude não está reservado', () => {
    const decision = routeTask(
      'Revise o diff do worker e dê o veredito',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      ctx(),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-fable-5-1');
    expect(decision!.reason).toContain('lane de julgamento');
  });

  it('sem nenhum frontier instalado: judgeUnavailable e o Maestro julga', () => {
    const decision = routeTask(
      'Revise o código do commit e aprove ou rejeite',
      cheapAdapters,
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      ctx(),
    );
    expect(decision).not.toBeNull();
    expect(['glm', 'mimo-code']).toContain(decision!.adapterId);
    expect(decision!.judgeUnavailable).toBe(true);
    expect(decision!.reason).toContain('sem juiz frontier');
    expect(decision!.reason).not.toContain('lane de julgamento');
  });

  it('menção explícita de modelo vence a lane de julgamento', () => {
    const decision = routeTask(
      'Revise o diff — julgue com o glm-5.3',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      ctx(),
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.model).toBe('glm-5.3');
    expect(decision!.reason).not.toContain('lane de julgamento');
  });

  it('lane lista exatamente os cinco assentos de topo', () => {
    expect([...JUDGE_FRONTIER_LANE]).toEqual([
      { adapterId: 'claude', model: 'claude-fable-5-1' },
      { adapterId: 'claude', model: 'claude-opus-5-5' },
      { adapterId: 'claude', model: 'claude-sonnet-5-5' },
      { adapterId: 'codex', model: 'gpt-6.1-sol' },
      { adapterId: 'codex', model: 'gpt-6-astra' },
    ]);
  });
});
