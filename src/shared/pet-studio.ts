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
    'como fonte canônica, carregue a skill nexus-pet-studio pelo nome e ' +
    'conclua tudo nesta sessão Codex. Gere e valide o pacote dentro do ' +
    'workspace; o Nexus fará a instalação final depois do handoff. Não ' +
    'delegue nem pare em prompts ou imagens intermediárias.',
  agents: [
    {
      id: 'pet-maker',
      agentName: 'Pet Maker',
      category: 'orchestrator',
      cli: 'codex',
      effort: 'high',
      // The dedicated maker gets only workspace dependencies plus Nexus-owned
      // media. It never receives the private Codex imagegen/home path.
      allowedTools: [
        'load_workspace_dependencies',
        'nexus_media_providers',
        'nexus_image_generate',
      ],
      allowedSkills: ['nexus-pet-studio'],
    },
  ],
};
