import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { Mission, Squad } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import { snapshotSquadAuthority } from './squad-authority-snapshot';

const h = vi.hoisted(() => ({ mission: null as Mission | null, squads: [] as Squad[] }));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ missions: { get: () => h.mission } }),
}));
vi.mock('./squad-store', async (original) => ({
  ...(await original<typeof import('./squad-store')>()),
  listSquads: () => h.squads,
}));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null }) }),
}));

import { resolveCurrentMissionSpawnAuthoritySeal } from './pane-registry';

const squad: Squad = {
  id: 'sq', name: 'Squad', createdAt: '1', builtin: false, orchestratorInstructions: '',
  agents: [{ id: 'o', agentName: 'Maestro', category: 'orchestrator', cli: 'codex' }],
};

function mission(overrides: Partial<Mission['intentContract']> = {}, squadId?: string): Mission {
  const contract = compileIntentContract({ goal: 'Missão livre', intentVersion: 1 });
  return {
    id: 'm-free', title: 'Livre', description: '', status: 'running', squadId,
    milestones: [], learnings: '', intentState: 'executing', intentVersion: 1,
    intentContract: { ...contract, approvedAt: 10, dispatchedAt: 11, ...overrides },
    createdAt: 1, updatedAt: 2,
  };
}

beforeEach(() => { h.squads = [squad]; });

describe('selo de spawn da missão (pane-registry)', () => {
  it('missão livre sem squad ganha selo e spawna', () => {
    h.mission = mission({ freeAgentChoice: true });
    expect(resolveCurrentMissionSpawnAuthoritySeal(testProjectScope(), 'm-free')).toMatchObject({ intentVersion: 1 });
  });

  it('missão com squad continua exigindo o squad aprovado', () => {
    h.mission = mission({ freeAgentChoice: true, squadRevisionHash: snapshotSquadAuthority(squad).hash }, 'sq');
    expect(resolveCurrentMissionSpawnAuthoritySeal(testProjectScope(), 'm-free').squadRevisionHash)
      .toBe(snapshotSquadAuthority(squad).hash);
    h.squads = [];
    expect(() => resolveCurrentMissionSpawnAuthoritySeal(testProjectScope(), 'm-free')).toThrow(/seal is unavailable/);
  });

  it('missão sem squad fora do modo livre segue sem selo', () => {
    h.mission = mission();
    expect(() => resolveCurrentMissionSpawnAuthoritySeal(testProjectScope(), 'm-free')).toThrow(/seal is unavailable/);
  });
});
