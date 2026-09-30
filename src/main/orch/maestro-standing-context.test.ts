import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { maestroStandingContext, maestroStandingDoctrineFor } from './maestro-standing-context';
import { MAESTRO_STANDING_DOCTRINE } from './orchestrator-doctrine';

const mission = { id: 'm', title: 'Inbox do HiperGO', description: 'corrigir os achados da revisão' } as Mission;
const found = () => mission;
const maestro = { role: 'orchestrator' as const, missionId: 'm' };

describe('doutrina permanente do Maestro (F-701)', () => {
  it('orquestrador de missão que delega recebe a doutrina', () => {
    expect(maestroStandingDoctrineFor(maestro, found)).toBe(MAESTRO_STANDING_DOCTRINE);
  });

  it('worker, operador e orquestrador sem missão não recebem; a missão nem é lida', () => {
    const never = () => {
      throw new Error('não deveria ler a missão');
    };
    expect(maestroStandingDoctrineFor({ role: 'worker', missionId: 'm' }, never)).toBeNull();
    expect(maestroStandingDoctrineFor({ role: 'user' }, never)).toBeNull();
    expect(maestroStandingDoctrineFor({ role: 'orchestrator' }, never)).toBeNull();
  });

  it('missão ilegível ou sumida: nada, sem lançar', () => {
    expect(maestroStandingDoctrineFor(maestro, () => null)).toBeNull();
    expect(maestroStandingDoctrineFor(maestro, () => {
      throw new Error('store fechado');
    })).toBeNull();
  });

  it('canal: instructions do MCP para toda CLI, hook só para o Codex', () => {
    expect(maestroStandingContext({ ...maestro, providerId: 'claude' }, 'mcp', found)).toBe(MAESTRO_STANDING_DOCTRINE);
    expect(maestroStandingContext({ ...maestro, providerId: 'claude' }, 'hook', found)).toBeNull();
    expect(maestroStandingContext({ ...maestro, providerId: 'codex' }, 'mcp', found)).toBeNull();
    expect(maestroStandingContext({ ...maestro, providerId: 'codex' }, 'hook', found)).toBe(MAESTRO_STANDING_DOCTRINE);
  });
});
