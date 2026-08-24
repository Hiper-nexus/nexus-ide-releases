/**
 * Regressão B1 (2026-08-18): o caminho Retomar/retry-kickoff da Via Rápida
 * (`resumeFastLaneMission`) NUNCA pode re-armar uma missão `blocked_user` com
 * pergunta pendente — a única saída autorizada é answer-question. Antes da
 * correção, `resumeTechnical` limpava o bloqueio sem resposta e respawnava o
 * orquestrador (bug de campo).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';

const harness = vi.hoisted(() => ({
  mission: null as Mission | null,
  resumeTechnical: vi.fn(),
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
  }),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    resumeTechnical: harness.resumeTechnical,
  }),
}));

import { resumeFastLaneMission } from './mission-fast-lane';

const scope = testProjectScope();

function blockedUserMission(description: string): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description,
    status: 'blocked',
    intentState: 'blocked_user',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
  } as Mission;
}

describe('resumeFastLaneMission — guarda de blocked_user', () => {
  it('recusa retomar missão com pergunta pendente (sem selo runtime-closed)', async () => {
    harness.mission = blockedUserMission('Pergunta pendente ao operador');
    harness.resumeTechnical.mockClear();

    await expect(
      resumeFastLaneMission(scope, 'mission-1'),
    ).rejects.toThrow(/pergunta do operador exige resposta/);
    expect(harness.resumeTechnical).not.toHaveBeenCalled();
  });
});
