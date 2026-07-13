import type { Squad } from '../../shared/orch-types';
import type { AdapterInfo } from '../../shared/adapter-types';
import {
  PET_STUDIO_SQUAD,
} from '../../shared/pet-studio';
import {
  launchSquadMission,
  type SquadLaunchOptions,
} from '../orch/mission-launcher';
import { useWorkspaceStore } from '../state/workspace-store';

/** Slug legível a partir do nome do arquivo-base. */
export function petSlugFromImagePath(imagePath: string): string {
  const base = imagePath.split(/[\\/]/).pop() ?? 'pet';
  const stem = base
    .replace(/-\d{12,16}(?=\.[^.]+$)/, '')
    .replace(/\.[^.]+$/, '');
  const slug = stem
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'pet';
}

/**
 * Objetivo do worker visual. A skill é referenciada pelo nome: cada CLI deve
 * resolver a instalação no próprio CODEX_HOME/CLAUDE_HOME, sem caminho cruzado.
 */
export function hatchPetIntent(imagePath: string): string {
  const slug = petSlugFromImagePath(imagePath);
  return [
    `Crie um mascote Codex de corpo inteiro a partir da imagem de referência em \`${imagePath}\`.`,
    'Use a imagem como fonte canônica da identidade; preserve os traços mais reconhecíveis sem fazer um retrato literal.',
    'Estilo 3D toy premium, formas arredondadas, proporções compactas e detalhes legíveis em 192×208.',
    'Pose única centralizada, corpo inteiro e com margem sobre fundo magenta puro #FF00FF; sem cenário, texto, logotipo, borda, sombra, reflexo ou magenta no personagem.',
    'Carregue a skill hatch-pet pelo nome e execute o workflow completo do Codex v2, incluindo geração, montagem e QA.',
    `Empacote o resultado aprovado em ~/.codex/pets/${slug}/ e informe os caminhos de spritesheet.webp e pet.json.`,
  ].join('\n');
}

export interface PetHatchLaunchResult {
  ok: boolean;
  paneId?: string;
  squad?: Squad;
  error?: string;
}

interface PetHatchLaunchDeps {
  saveSquad(squad: Squad): Promise<{ ok: boolean; error?: string }>;
  listAdapters(): Promise<AdapterInfo[]>;
  launchSquad(
    squad: Squad,
    adapters: AdapterInfo[],
    options?: SquadLaunchOptions,
  ): Promise<{
    ok: boolean;
    paneId?: string;
    error?: string;
  }>;
  workspacePath(): string | null;
}

const runtimeDeps: PetHatchLaunchDeps = {
  saveSquad: (squad) => window.nexus.orch.saveSquad(squad),
  listAdapters: () => window.nexus.adapters.list(),
  launchSquad: launchSquadMission,
  workspacePath: () => useWorkspaceStore.getState().current?.path ?? null,
};

/** Selecionar a imagem já basta: monta o squad e inicia uma missão real. */
export async function launchPetHatchMission(
  imagePath: string,
  deps: PetHatchLaunchDeps = runtimeDeps,
): Promise<PetHatchLaunchResult> {
  const workspacePath = deps.workspacePath();
  if (!workspacePath) {
    return { ok: false, error: 'Abra um workspace antes de criar o pet.' };
  }

  const intent = hatchPetIntent(imagePath);
  try {
    const [saved, adapters] = await Promise.all([
      // Repair every launch, not only when the id is absent. Old/custom rows
      // using the reserved id must never regain extra agents or Nexus tools.
      deps.saveSquad(PET_STUDIO_SQUAD),
      deps.listAdapters(),
    ]);
    if (!saved.ok) {
      return {
        ok: false,
        error:
          saved.error ??
          'Não consegui preparar o squad nativo Pet Studio.',
      };
    }
    const squad: Squad = {
      ...PET_STUDIO_SQUAD,
      orchestratorInstructions: `${PET_STUDIO_SQUAD.orchestratorInstructions.trim()}\n\n## Briefing desta imagem\n${intent}`,
    };
    const launched = await deps.launchSquad(squad, adapters, {
      profile: 'pet-studio',
      adapterId: 'codex',
    });
    if (!launched.ok) return launched;
    return { ...launched, squad };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'Falha inesperada ao iniciar a criação do pet.',
    };
  }
}
