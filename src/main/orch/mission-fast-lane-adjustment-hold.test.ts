/**
 * Regressão: clicar "Pedir um ajuste" religava o Maestro e ele saía rodando
 * sozinho — first-wave automática + kickoff completo de delegação — antes de
 * o operador dizer QUAL ajuste quer. Reabrir é religar digitável e esperar.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { MISSION_OPERATOR_APPROVED_MARKER } from '../../shared/mission-recovery-policy';
import { testProjectScope } from './__tests__/scope-fixture';

const harness = vi.hoisted(() => ({
  mission: null as Mission | null,
  getSquad: vi.fn(() => null),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: () => null,
  listAgentSessions: () => [],
  orchTerminateSession: async () => true,
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [],
  wasOrchestratorOperatorDismissed: () => false,
  clearOperatorDismissedPanes: () => {},
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => harness.mission,
      list: () => (harness.mission ? [harness.mission] : []),
      update: () => harness.mission,
    },
    tasks: { list: () => [] },
  }),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({}),
}));

vi.mock('./squad-store', () => ({
  getSquad: (...args: unknown[]) =>
    (harness.getSquad as (...a: unknown[]) => unknown)(...args),
}));

import {
  ADJUSTMENT_WAIT_FIRST,
  buildRespawnPrompt,
  dispatchFastLaneFirstWave,
} from './mission-fast-lane';

const scope = testProjectScope();

function runningMission(description: string, id: string): Mission {
  return {
    id,
    title: 'Prova',
    description,
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
  } as Mission;
}

const ADJUSTING = `Refazer a tela.\n\n<!-- nexus:awaiting-adjustment:123 -->`;

describe('buildRespawnPrompt — Maestro religado para ajuste espera', () => {
  it('aguardando ajuste: espera PRIMEIRO, vence a delegação, base preservada', () => {
    const prompt = buildRespawnPrompt({
      basePrompt: 'BASE-DO-KICKOFF',
      awaitingAdjustment: true,
      note: 'nota de continuidade',
    });

    expect(prompt.startsWith(ADJUSTMENT_WAIT_FIRST)).toBe(true);
    expect(prompt).toMatch(/NÃO spawne workers/);
    expect(prompt).toMatch(/vence as instruções de delegação/);
    expect(prompt).toContain('BASE-DO-KICKOFF');
    expect(prompt).toContain('nota de continuidade');
  });

  it('sem ajuste: montagem legada idêntica (base + continuidade)', () => {
    expect(
      buildRespawnPrompt({ basePrompt: 'BASE', awaitingAdjustment: false }),
    ).toBe('BASE');
    expect(
      buildRespawnPrompt({
        basePrompt: 'BASE',
        awaitingAdjustment: false,
        note: 'n',
      }),
    ).toBe('BASE\n## CONTINUIDADE\nVocê foi religado automaticamente. n Consulte nexus_handoff_list e o estado da missão antes de agir.');
  });
});

describe('dispatchFastLaneFirstWave — hold do "Pedir um ajuste"', () => {
  it('com marcador awaiting-adjustment NÃO dispara workers sozinho', async () => {
    harness.mission = runningMission(ADJUSTING, 'mission-adjust');
    harness.getSquad.mockClear();

    const seats = await dispatchFastLaneFirstWave(scope, 'mission-adjust');

    expect(seats).toBe(0);
    // Nem chega a planejar o leque: short-circuit antes do squad.
    expect(harness.getSquad).not.toHaveBeenCalled();
  });

  it('sem marcador segue o caminho normal (chega ao squad)', async () => {
    harness.mission = runningMission('Refazer a tela.', 'mission-normal');
    harness.getSquad.mockClear();

    const seats = await dispatchFastLaneFirstWave(scope, 'mission-normal');

    expect(seats).toBe(0); // sem squad registrado, nada para sentar
    expect(harness.getSquad).toHaveBeenCalled();
  });

  it('marcador de aprovação ("Marcar como feito") NÃO é hold de ajuste', async () => {
    harness.mission = runningMission(
      `Entrega revisada.\n\n${MISSION_OPERATOR_APPROVED_MARKER}`,
      'mission-approved',
    );
    harness.getSquad.mockClear();

    const seats = await dispatchFastLaneFirstWave(scope, 'mission-approved');

    expect(seats).toBe(0);
    expect(harness.getSquad).toHaveBeenCalled();
  });
});
