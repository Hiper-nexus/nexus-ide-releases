// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIntentDispatchKickoffPrompt,
  initialGoalForArmedMission,
  launchSquadMission,
  materializeSquadMission,
  squadLaunchDedupeKey,
} from './mission-launcher';
import type { Squad } from '../../shared/orch-types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const squad = {
  id: 'navalha',
  name: 'NavalhaGO',
  orchestratorInstructions: 'Aplique o padrão de engenharia do NavalhaGO.',
  agents: [
    {
      id: 'orch',
      agentName: 'Orch',
      category: 'orchestrator' as const,
      cli: 'claude',
    },
    {
      id: 'qa',
      agentName: 'QA sênior',
      category: 'reviewer' as const,
      cli: 'codex',
    },
  ],
  createdAt: '1',
  builtin: false,
} satisfies Squad;

describe('intent-first kickoff packing', () => {
  it('keeps the goal scoped while preserving the Nexus autopilot protocol', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-1',
      goal: 'Corrigir o formulário de login',
      acceptanceCriteria: ['Login funciona'],
      risk: 'sensitive',
      maxWorkers: 2,
    });
    expect(prompt).toContain('Corrigir o formulário de login');
    expect(prompt).toContain('missionId=mission-1');
    expect(prompt).toContain('Aplique o padrão de engenharia do NavalhaGO.');
    expect(prompt).toContain('QA sênior (reviewer');
    expect(prompt).toContain('PILOTO AUTOMÁTICO');
    expect(prompt).toContain('nexus_mission_freeze_contract');
    expect(prompt).toContain('nexus_merge_task');
    expect(prompt).toContain('PREVC');
    expect(prompt).toMatch(/revis[aã]o independente/i);
    expect(prompt).toMatch(/mem[oó]ria dur[aá]vel/i);
    expect(prompt).toMatch(/context_doctor.*sob demanda/i);
  });
});

describe('intent-first launch continuity', () => {
  it('keeps the designed objective when an agentic squad becomes armed', () => {
    expect(
      initialGoalForArmedMission({
        isAgentic: true,
        designedIntent: '  Corrigir o login  ',
      }),
    ).toBe('Corrigir o login');
    expect(
      initialGoalForArmedMission({
        isAgentic: false,
        designedIntent: 'Corrigir o login',
      }),
    ).toBe('');
  });

  it('does not deduplicate different approved missions for the same squad', () => {
    expect(squadLaunchDedupeKey('/repo', 'navalha', 'mission-1')).not.toBe(
      squadLaunchDedupeKey('/repo', 'navalha', 'mission-2'),
    );
    expect(squadLaunchDedupeKey('/repo', 'navalha')).toBe(
      squadLaunchDedupeKey('/repo', 'navalha'),
    );
  });
});

describe('materializeSquadMission with existingMissionId', () => {
  const input = {
    paneId: 'pane-orch',
    title: 'NavalhaGO',
    squadId: 'navalha',
    existingMissionId: 'mission-armed',
    orchestratorPane: {
      paneId: 'pane-orch',
      adapterId: 'claude',
      agentName: 'Maestro',
    },
  };

  it('binds the armed mission instead of creating a new one', async () => {
    const mission = {
      id: 'mission-armed',
      title: 'NavalhaGO',
      description: 'goal',
      status: 'running' as const,
      milestones: [],
      learnings: '',
      intentState: 'dispatched' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const createMission = vi.fn();
    const updateMission = vi.fn();
    const bindMission = vi.fn(async () => mission);
    const result = await materializeSquadMission(input, {
      waitForSession: async () => 'session-1',
      createMission,
      bindMission,
      updateMission,
    });
    expect(result).toEqual({ sessionId: 'session-1', mission });
    expect(bindMission).toHaveBeenCalledWith({
      missionId: 'mission-armed',
      title: 'NavalhaGO',
      squadId: 'navalha',
      orchestratorPane: input.orchestratorPane,
    });
    expect(createMission).not.toHaveBeenCalled();
    expect(updateMission).not.toHaveBeenCalled();
  });
});

vi.mock('../state/home-store', () => ({
  useHomeStore: {
    getState: () => ({ hide: vi.fn() }),
  },
}));

describe('intent-first arming dependencies', () => {
  it('arms without loading accounts or quota providers', async () => {
    const accountsList = vi.fn(async () => {
      throw new Error('accounts unavailable');
    });
    const quotaSnapshot = vi.fn(async () => {
      throw new Error('quota unavailable');
    });
    const armMission = vi.fn(async () => ({ id: 'mission-armed' }));
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({ intentFirstMissionRuntimeV1: true })),
        },
        accounts: { list: accountsList },
        quota: { snapshot: quotaSnapshot },
        orch: { armMission },
      },
    });
    await expect(launchSquadMission(squad, [])).resolves.toMatchObject({
      ok: true,
      armed: true,
      missionId: 'mission-armed',
    });
    expect(armMission).toHaveBeenCalledOnce();
    expect(accountsList).not.toHaveBeenCalled();
    expect(quotaSnapshot).not.toHaveBeenCalled();
  });
});
