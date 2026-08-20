import { describe, expect, it } from 'vitest';
import {
  defaultFreeAgentChoice,
  isFreeAgentChoiceContract,
  requiresRouteReservation,
  squadBindingViolationError,
} from './free-agent-choice';

describe('free agent choice — leitura do contrato', () => {
  it('lê freeAgentChoice do contrato de intenção da missão', () => {
    expect(isFreeAgentChoiceContract({ freeAgentChoice: true })).toBe(true);
    expect(isFreeAgentChoiceContract({ freeAgentChoice: false })).toBe(false);
    expect(isFreeAgentChoiceContract({})).toBe(false);
    expect(isFreeAgentChoiceContract(null)).toBe(false);
    expect(isFreeAgentChoiceContract(undefined)).toBe(false);
  });
});

describe('gate (b) squad_binding — bypass de modo livre', () => {
  const roster = new Set(['codex', 'claude']);

  it('SEM modo livre: recusa CLI fora do roster do squad selado', () => {
    const error = squadBindingViolationError({
      hasNamedAgent: false,
      missionSquadId: 'squad-1',
      rosterClis: roster,
      adapterId: 'gemini',
      freeAgentChoice: false,
    });
    expect(error).toContain('squad_binding_violation');
    expect(error).toContain('gemini');
  });

  it('SEM modo livre: aceita CLI do roster', () => {
    expect(
      squadBindingViolationError({
        hasNamedAgent: false,
        missionSquadId: 'squad-1',
        rosterClis: roster,
        adapterId: 'codex',
        freeAgentChoice: false,
      }),
    ).toBeNull();
  });

  it('COM modo livre: qualquer CLI passa (sem squad_binding)', () => {
    expect(
      squadBindingViolationError({
        hasNamedAgent: false,
        missionSquadId: 'squad-1',
        rosterClis: roster,
        adapterId: 'gemini',
        freeAgentChoice: true,
      }),
    ).toBeNull();
  });

  it('agente nomeado do roster nunca é gateado por este gate', () => {
    expect(
      squadBindingViolationError({
        hasNamedAgent: true,
        missionSquadId: 'squad-1',
        rosterClis: roster,
        adapterId: 'gemini',
        freeAgentChoice: false,
      }),
    ).toBeNull();
  });

  it('roster irresolúvel (vazio) faz fail-open', () => {
    expect(
      squadBindingViolationError({
        hasNamedAgent: false,
        missionSquadId: 'squad-1',
        rosterClis: new Set<string>(),
        adapterId: 'gemini',
        freeAgentChoice: false,
      }),
    ).toBeNull();
  });
});

describe('gate (c) route_reservation — bypass de modo livre', () => {
  it('SEM modo livre: missão running sem rota sticky exige reserva', () => {
    expect(
      requiresRouteReservation({
        missionRunning: true,
        rosterRouteAuthorized: false,
        freeAgentChoice: false,
      }),
    ).toBe(true);
  });

  it('COM modo livre: missão running dispensa reserva', () => {
    expect(
      requiresRouteReservation({
        missionRunning: true,
        rosterRouteAuthorized: false,
        freeAgentChoice: true,
      }),
    ).toBe(false);
  });

  it('rota sticky de roster nunca exige reserva', () => {
    expect(
      requiresRouteReservation({
        missionRunning: true,
        rosterRouteAuthorized: true,
        freeAgentChoice: false,
      }),
    ).toBe(false);
  });

  it('missão não-running nunca exige reserva', () => {
    expect(
      requiresRouteReservation({
        missionRunning: false,
        rosterRouteAuthorized: false,
        freeAgentChoice: false,
      }),
    ).toBe(false);
  });
});

describe('defaultFreeAgentChoice', () => {
  it('Autopiloto: missão nova nasce em modo livre por default', () => {
    expect(
      defaultFreeAgentChoice({
        requested: undefined,
        operatorChoicePolicy: true,
        petStudio: false,
      }),
    ).toBe(true);
  });

  it('Hardened: modo livre continua opt-in explícito', () => {
    expect(
      defaultFreeAgentChoice({
        requested: undefined,
        operatorChoicePolicy: false,
        petStudio: false,
      }),
    ).toBe(false);
    expect(
      defaultFreeAgentChoice({
        requested: true,
        operatorChoicePolicy: false,
        petStudio: false,
      }),
    ).toBe(true);
  });

  it('escolha explícita do fluxo vence o default nas duas direções', () => {
    expect(
      defaultFreeAgentChoice({
        requested: false,
        operatorChoicePolicy: true,
        petStudio: false,
      }),
    ).toBe(false);
  });

  it('Pet Studio só entra em modo livre por escolha explícita', () => {
    expect(
      defaultFreeAgentChoice({
        requested: undefined,
        operatorChoicePolicy: true,
        petStudio: true,
      }),
    ).toBe(false);
  });
});
