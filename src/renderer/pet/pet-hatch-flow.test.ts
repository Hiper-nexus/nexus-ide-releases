// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { hatchPetIntent, launchPetHatchMission } from './pet-hatch-flow';

describe('launchPetHatchMission', () => {
  it('usa o Pet Studio fixo em um único Codex e aguarda o launcher confirmar', async () => {
    const launchSquad = vi.fn(async () => ({ ok: true, paneId: 'pane-1' }));
    const result = await launchPetHatchMission('/ws/cat.png', {
      workspacePath: () => '/ws',
      listAdapters: async () => [],
      saveSquad: async () => ({ ok: true }),
      launchSquad,
    });

    expect(result).toMatchObject({ ok: true, paneId: 'pane-1' });
    expect(result.squad?.orchestratorInstructions).not.toContain('/ws/cat.png');
    expect(result.squad?.agents).toHaveLength(1);
    expect(result.squad?.agents[0]).toMatchObject({
      cli: 'codex',
      allowedTools: [
        'load_workspace_dependencies',
        'nexus_media_providers',
        'nexus_image_generate',
      ],
      allowedSkills: ['nexus-pet-studio'],
    });
    expect(launchSquad).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nexus-pet-studio' }),
      [],
      {
        profile: 'pet-studio',
        adapterId: 'codex',
        missionTitle: 'Criar mascote cat',
        missionGoal: hatchPetIntent('/ws/cat.png'),
      },
    );
  });

  it('propaga a falha real do terminal em vez de fechar com falso sucesso', async () => {
    const result = await launchPetHatchMission('/ws/cat.png', {
      workspacePath: () => '/ws',
      listAdapters: async () => [],
      saveSquad: async () => ({ ok: true }),
      launchSquad: async () => ({
        ok: false,
        error: 'A missão não foi iniciada: terminal não materializou',
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: 'A missão não foi iniciada: terminal não materializou',
    });
  });

  it('repara e usa o built-in canônico em toda execução', async () => {
    const saveSquad = vi.fn(async () => ({ ok: true }));
    const launchSquad = vi.fn(async () => ({ ok: true, paneId: 'pane-lazy' }));
    const result = await launchPetHatchMission('/ws/cat.png', {
      workspacePath: () => '/ws',
      listAdapters: async () => [],
      saveSquad,
      launchSquad,
    });

    expect(result).toMatchObject({ ok: true, paneId: 'pane-lazy' });
    expect(saveSquad).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'nexus-pet-studio',
        builtin: true,
        agents: [
          expect.objectContaining({
            allowedTools: [
              'load_workspace_dependencies',
              'nexus_media_providers',
              'nexus_image_generate',
            ],
          }),
        ],
      }),
    );
    expect(launchSquad).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'nexus-pet-studio',
        agents: [
          expect.objectContaining({
            id: 'pet-maker',
            cli: 'codex',
            allowedTools: [
              'load_workspace_dependencies',
              'nexus_media_providers',
              'nexus_image_generate',
            ],
          }),
        ],
      }),
      [],
      {
        profile: 'pet-studio',
        adapterId: 'codex',
        missionTitle: 'Criar mascote cat',
        missionGoal: hatchPetIntent('/ws/cat.png'),
      },
    );
  });
});
