// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { materializeSquadMission } from './mission-launcher';

const input = {
  paneId: 'pane-orch',
  title: 'Pet Hatch',
  squadId: 'pet-squad',
  orchestratorPane: {
    paneId: 'pane-orch',
    adapterId: 'claude',
    agentName: 'Maestro',
  },
};

describe('materializeSquadMission', () => {
  it('falha explicitamente se o PTY não existir e não cria missão fantasma', async () => {
    const createMission = vi.fn();
    const updateMission = vi.fn();
    await expect(
      materializeSquadMission(input, {
        waitForSession: async () => null,
        createMission,
        updateMission,
      }),
    ).rejects.toThrow('terminal do orquestrador não iniciou');
    expect(createMission).not.toHaveBeenCalled();
    expect(updateMission).not.toHaveBeenCalled();
  });

  it('só confirma após persistir a missão vinculada ao pane concreto', async () => {
    const runningMission = {
      id: 'mission-pet',
      title: 'Pet Hatch',
      description: '',
      status: 'running' as const,
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 1,
    };
    const createMission = vi.fn(async () => runningMission);
    const updateMission = vi.fn();
    const result = await materializeSquadMission(input, {
      waitForSession: async () => 'session-1',
      createMission,
      updateMission,
    });

    expect(result).toEqual({ sessionId: 'session-1', mission: runningMission });
    expect(createMission).toHaveBeenCalledWith({
      title: 'Pet Hatch',
      squadId: 'pet-squad',
      orchestratorPane: input.orchestratorPane,
    });
    expect(updateMission).not.toHaveBeenCalled();
  });
});
