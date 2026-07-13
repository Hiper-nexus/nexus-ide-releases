import type { Squad } from './orch-types';

/** Stable id for the built-in, single-agent pet creation squad. */
export const PET_STUDIO_SQUAD_ID = 'nexus-pet-studio';

/**
 * Shared seed also lets an already-running renderer self-heal the catalog
 * without restarting its main process.
 */
export const PET_STUDIO_SQUAD: Squad = {
  id: PET_STUDIO_SQUAD_ID,
  name: 'Pet Studio',
  createdAt: '1704067200000',
  builtin: true,
  orchestratorInstructions:
    '# Pet Studio\n' +
    'Você é o único criador visual desta missão. Use a imagem fornecida ' +
    'como fonte canônica, carregue a skill hatch-pet pelo nome e conclua ' +
    'tudo nesta sessão Codex. Gere, valide e empacote o pet final; não ' +
    'delegue nem pare em prompts ou imagens intermediárias.',
  agents: [
    {
      id: 'pet-maker',
      agentName: 'Pet Maker',
      category: 'orchestrator',
      cli: 'codex',
      effort: 'high',
      // Empty is intentional: the gate still exposes the one universal
      // handoff tool, while every generic Nexus workflow tool stays hidden.
      allowedTools: [],
      allowedSkills: ['hatch-pet'],
    },
  ],
};
