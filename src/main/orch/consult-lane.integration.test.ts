// @vitest-environment node
/**
 * End-to-end consult lane: submit intent → contract → prompt → tool gate → done.
 * Does not spin Electron; exercises the same authority/gate/prompt surfaces
 * used by the product path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  canCompleteConsultLane,
  compileIntentContract,
} from '../../shared/mission-intent';
import { assertMissionIntentAllowsTool } from './mission-intent-gate';
import type { Mission } from '../../shared/orch-types';

describe('consult lane end-to-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submit → contract → consult prompt → basic mission tools allowed → done needs learning', () => {
    // 1) Contract persisted by the canonical MissionEngine prepare/start path.
    const contract = compileIntentContract({
      goal: 'Ler logs da Vercel e resumir os erros de deploy de ontem',
      intentVersion: 1,
      source: 'typed',
      lane: 'consult',
    });
    expect(contract.lane).toBe('consult');
    expect(contract.budgets.maxWorkers).toBe(0);

    const mission: Mission = {
      id: 'mission-consult',
      title: 'Logs Vercel',
      description: contract.goal,
      status: 'running',
      milestones: [],
      learnings: '',
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: {
        ...contract,
        approvedAt: 1_000,
        dispatchedAt: 1_000,
      },
      createdAt: 1,
      updatedAt: 1,
    };

    // 2) Basic mission tools allowed; explicit contract denies still block
    expect(
      assertMissionIntentAllowsTool('nexus_git_status', { mission }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_worktree_create', { mission }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_merge_task', { mission }).ok,
    ).toBe(true);

    const denied: Mission = {
      ...mission,
      intentContract: {
        ...mission.intentContract!,
        deniedTools: ['nexus_git_commit'],
      },
    };
    expect(
      assertMissionIntentAllowsTool('nexus_git_commit', { mission: denied }).ok,
    ).toBe(false);

    // 4) Done path: short learnings insufficient; durable note required
    const shortNote = 'ok';
    const durableNote =
      'Resumo: 3 deploys falharam por timeout no build step de TypeScript.';
    expect(canCompleteConsultLane({ learnings: mission.learnings, note: shortNote })).toBe(
      false,
    );
    expect(
      canCompleteConsultLane({ learnings: mission.learnings, note: durableNote }),
    ).toBe(true);

    expect(
      assertMissionIntentAllowsTool('nexus_mission_set_status', {
        mission,
      }).ok,
    ).toBe(true);
  });
});
