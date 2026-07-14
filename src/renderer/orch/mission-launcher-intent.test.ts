// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  buildIntentDispatchKickoffPrompt,
  materializeSquadMission,
} from './mission-launcher';

describe('intent-first kickoff packing', () => {
  it('builds a short goal-scoped prompt without bootstrap playbook', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squadName: 'NavalhaGO',
      missionId: 'mission-1',
      goal: 'Corrigir o formulário de login',
      acceptanceCriteria: ['Login funciona'],
      risk: 'sensitive',
      maxWorkers: 2,
    });
    expect(prompt).toContain('Corrigir o formulário de login');
    expect(prompt).toContain('missionId=mission-1');
    expect(prompt).not.toContain('Pipeline obrigatório');
    expect(prompt).not.toContain('PILOTO AUTOMÁTICO');
    expect(prompt).toContain('NÃO rode nexus_context_doctor só para "aquecer"');
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
