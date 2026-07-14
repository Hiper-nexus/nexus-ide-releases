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
import { buildIntentDispatchKickoffPrompt } from '../../renderer/orch/mission-launcher';
import { assertMissionIntentAllowsTool } from './mission-intent-gate';
import type { Mission, Squad } from '../../shared/orch-types';

const squad = {
  id: 'navalha',
  name: 'NavalhaGO',
  orchestratorInstructions: 'Coordene a missão.',
  agents: [
    {
      id: 'orch',
      agentName: 'Orch',
      category: 'orchestrator' as const,
      cli: 'claude',
    },
  ],
  createdAt: '1',
  builtin: false,
} satisfies Squad;

describe('consult lane end-to-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submit → contract → consult prompt → mutable tools denied → done needs learning', () => {
    // 1) Contract as produced by submitMissionIntent(lane=consult)
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

    // 2) Kickoff prompt is the consult contract, not PREVC code path
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: mission.id,
      goal: contract.goal,
      acceptanceCriteria: contract.acceptanceCriteria,
      risk: contract.risk,
      maxWorkers: contract.budgets.maxWorkers,
      lane: contract.lane,
    });
    expect(prompt).toContain('lane=consult');
    expect(prompt).toMatch(/somente leitura/i);
    expect(prompt).not.toContain('nexus_mission_freeze_contract');
    expect(prompt).not.toContain('nexus_merge_task');

    // 3) Mutable tools rejected; reads allowed
    expect(
      assertMissionIntentAllowsTool('nexus_git_status', { mission }).ok,
    ).toBe(true);
    expect(
      assertMissionIntentAllowsTool('nexus_worktree_create', { mission }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_pane_spawn', { mission }).ok,
    ).toBe(false);
    expect(
      assertMissionIntentAllowsTool('nexus_merge_task', { mission }).ok,
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
        args: { status: 'done', note: durableNote },
      }).ok,
    ).toBe(true);
  });
});
