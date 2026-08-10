import { beforeEach, describe, expect, it } from 'vitest';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import { useMissionSetupStore } from './mission-setup-store';
import {
  useProductNavigationStore,
  type ProductNavigationStore,
} from './product-navigation-store';

type PetNavigationActions = ProductNavigationStore & {
  openPetReviewFromSettings(): void;
  returnToSettingsSection(section: 'appearance'): void;
};

type PetEntryContext = {
  kind: 'pet-studio';
  origin: 'settings-appearance';
  objective: string;
  title: string;
  roster: typeof PET_STUDIO_SQUAD.agents;
  profile: {
    kind: 'pet-studio';
    referenceImagePath: string;
  };
  step: 'review';
  revision: number;
};


const petContext: PetEntryContext = {
  kind: 'pet-studio',
  origin: 'settings-appearance',
  objective: 'Criar um pet completo a partir da imagem selecionada.',
  title: 'Criar pet cat-source',
  roster: PET_STUDIO_SQUAD.agents,
  profile: {
    kind: 'pet-studio',
    referenceImagePath:
      '/workspace/.nexus/attachments/pet-studio/cat-source.png',
  },
  step: 'review',
  revision: 1,
};

function navigation(): PetNavigationActions {
  return useProductNavigationStore.getState() as PetNavigationActions;
}

function seedPetReview(): void {
  useMissionSetupStore.setState({
    workspacePath: '/workspace',
    draft: {
      objective: petContext.objective,
      title: petContext.title,
      contextPaths: [],
      roster: PET_STUDIO_SQUAD.agents.map((agent) => ({ ...agent })),
      advanced: { lane: 'standard' },
      step: 'review',
      revision: petContext.revision,
    },
    entryContext: structuredClone(petContext),
  } as never);
  useProductNavigationStore.setState({
    destination: { kind: 'mission-setup' },
    settingsReturnDestination: { kind: 'terminal' },
  });
}

function currentPetContext(): unknown {
  const state: unknown = useMissionSetupStore.getState();
  if (!state || typeof state !== 'object' || !('entryContext' in state)) {
    return null;
  }
  return state.entryContext;
}

describe('Pet-specific product navigation', () => {
  beforeEach(() => {
    useProductNavigationStore.setState({
      destination: { kind: 'launcher' },
      settingsReturnDestination: null,
    });
    useMissionSetupStore.setState({
      workspacePath: null,
      draft: {
        objective: '',
        title: '',
        contextPaths: [],
        roster: [],
        advanced: { lane: 'standard' },
        step: 'mission',
        revision: 0,
      },
      persistence: { status: 'idle' },
      workspaceDrafts: {},
      entryContext: null,
    } as never);
  });

  it('preserves Terminal provenance across Settings → Pet Review → Cancel → Settings Back', () => {
    const store = navigation();
    store.openTerminal();
    store.openSettings('appearance');

    store.openPetReviewFromSettings();
    expect(useProductNavigationStore.getState()).toMatchObject({
      destination: { kind: 'mission-setup' },
      settingsReturnDestination: { kind: 'terminal' },
    });

    store.returnToSettingsSection('appearance');
    expect(useProductNavigationStore.getState()).toMatchObject({
      destination: { kind: 'settings', section: 'appearance' },
      settingsReturnDestination: { kind: 'terminal' },
    });

    store.backFromSettings();
    expect(useProductNavigationStore.getState()).toMatchObject({
      destination: { kind: 'terminal' },
      settingsReturnDestination: null,
    });
  });

  it.each([
    ['Launcher', (store: PetNavigationActions) => store.openLauncher()],
    ['Terminal', (store: PetNavigationActions) => store.openTerminal()],
    ['Mission Board', (store: PetNavigationActions) => store.openMission('m-2')],
    ['Task Board', (store: PetNavigationActions) => store.openTaskBoard()],
    ['Memory', (store: PetNavigationActions) => store.openMemory()],
    ['Settings', (store: PetNavigationActions) => store.openSettings('account')],
    ['ordinary New Mission', (store: PetNavigationActions) => store.openMissionSetup()],
  ])('clears Pet authority before a rail route leaves Review for %s', (_name, leave) => {
    seedPetReview();

    leave(navigation());

    expect(currentPetContext()).toBeNull();
  });
});
