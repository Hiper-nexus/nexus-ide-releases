import { describe, expect, it } from 'vitest';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { BUILTIN_SQUADS } from './builtin-squads';

describe('built-in Pet Studio squad', () => {
  it('stays a fixed, minimal single-Codex image pipeline', () => {
    const petStudio = BUILTIN_SQUADS.find(
      (squad) => squad.id === PET_STUDIO_SQUAD_ID,
    );

    expect(petStudio).toBeDefined();
    expect(petStudio?.agents).toEqual([
      expect.objectContaining({
        id: 'pet-maker',
        category: 'orchestrator',
        cli: 'codex',
        allowedTools: ['load_workspace_dependencies'],
        allowedSkills: ['hatch-pet'],
      }),
    ]);
    expect(petStudio?.orchestratorInstructions).toContain('não delegue');
    expect(petStudio?.orchestratorInstructions).not.toContain(
      '## Comunicação com o usuário',
    );
  });

  it('leaves the generic orchestration guidance on development squads', () => {
    const fullStack = BUILTIN_SQUADS.find(
      (squad) => squad.id === 'nexus-fullstack',
    );
    expect(fullStack?.orchestratorInstructions).toContain(
      '## Comunicação com o usuário',
    );
  });
});
