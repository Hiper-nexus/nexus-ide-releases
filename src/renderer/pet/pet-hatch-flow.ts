import type { Squad } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
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
 * Objetivo do worker visual. A skill é referenciada pelo nome e materializada
 * pelo main no perfil governado; nenhum HOME real vira destino do worker.
 */
export function hatchPetIntent(imagePath: string): string {
  const slug = petSlugFromImagePath(imagePath);
  return [
    `Crie um mascote Codex de corpo inteiro a partir da imagem de referência em \`${imagePath}\`.`,
    'Use a imagem como fonte canônica da identidade; preserve os traços mais reconhecíveis sem fazer um retrato literal.',
    'Estilo 3D toy premium, formas arredondadas, proporções compactas e detalhes legíveis em 192×208.',
    'Pose única centralizada, corpo inteiro e com margem sobre fundo magenta puro #FF00FF; sem cenário, texto, logotipo, borda, sombra, reflexo ou magenta no personagem.',
    'Carregue a skill nexus-pet-studio pelo nome e execute o workflow governado v2 completo, incluindo geração Nexus, montagem no workspace e QA.',
    `Use o id ${slug}. Grave o pacote somente no output de artifacts/nexus-pet-studio/<missionId> informado pelo kickoff; nunca escreva em ~/.codex/pets. Informe os caminhos de spritesheet.webp e pet.json para o Nexus validar e instalar.`,
  ].join('\n');
}

export interface PetHatchPreparationResult {
  ok: boolean;
  error?: string;
}

export interface PetHatchPreparationDeps {
  saveSquad(squad: Squad): Promise<{ ok: boolean; error?: string }>;
  workspacePath(): string | null;
}

const runtimeDeps: PetHatchPreparationDeps = {
  saveSquad: (squad) => window.nexus.orch.saveSquad(squad),
  workspacePath: () => useWorkspaceStore.getState().current?.path ?? null,
};

let preparationGeneration = 0;

/**
 * Persists the app-owned squad, seeds one ephemeral exact Review, and changes
 * only product navigation. Mission preparation/start remain Review-owned.
 */
export async function preparePetHatchMission(
  imagePath: string,
  deps: PetHatchPreparationDeps = runtimeDeps,
): Promise<PetHatchPreparationResult> {
  const generation = ++preparationGeneration;
  const setup = useMissionSetupStore.getState();
  setup.clearEntryContext();
  const workspacePath = deps.workspacePath();
  if (!workspacePath) {
    return { ok: false, error: 'Abra um workspace antes de criar o pet.' };
  }
  setup.setWorkspace(workspacePath);
  const entryAuthorityRevision =
    useMissionSetupStore.getState().entryAuthorityRevision;
  try {
    const saved = await deps.saveSquad(PET_STUDIO_SQUAD);
    if (!saved.ok) {
      return {
        ok: false,
        error:
          saved.error ??
          'Não consegui preparar o squad nativo Pet Studio.',
      };
    }
    const currentSetup = useMissionSetupStore.getState();
    if (
      generation !== preparationGeneration ||
      deps.workspacePath() !== workspacePath ||
      currentSetup.entryAuthorityRevision !== entryAuthorityRevision
    ) {
      return {
        ok: false,
        error: 'A imagem selecionada ficou desatualizada. Selecione-a novamente.',
      };
    }

    const slug = petSlugFromImagePath(imagePath);
    const entryContext = currentSetup.beginPetStudioReview({
      objective: hatchPetIntent(imagePath),
      title: `Criar pet ${slug}`,
      referenceImagePath: imagePath,
    });
    if (!entryContext) {
      return {
        ok: false,
        error: 'A imagem não pertence aos anexos governados deste workspace.',
      };
    }
    useProductNavigationStore.getState().openPetReviewFromSettings();
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'Falha inesperada ao preparar a revisão do pet.',
    };
  }
}
