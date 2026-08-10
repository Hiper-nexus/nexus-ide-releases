import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import * as petHatchFlow from './pet-hatch-flow';

interface PetEntryContext {
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
}

interface PetHatchPreparationDeps {
  workspacePath(): string | null;
  saveSquad(squad: typeof PET_STUDIO_SQUAD): Promise<{
    ok: boolean;
    error?: string;
  }>;
}

type PreparePetHatchMission = (
  imagePath: string,
  deps: PetHatchPreparationDeps,
) => Promise<{ ok: boolean; error?: string }>;

const preparePetHatchMission = (
  petHatchFlow as unknown as {
    preparePetHatchMission: PreparePetHatchMission;
  }
).preparePetHatchMission;

const workspacePath = '/workspace';
const firstImage =
  '/workspace/.nexus/attachments/pet-studio/cat-source.png';
const secondImage =
  '/workspace/.nexus/attachments/pet-studio/dog-source.png';

function isPetEntryContext(value: unknown): value is PetEntryContext {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'pet-studio' &&
    'origin' in value &&
    value.origin === 'settings-appearance' &&
    'revision' in value &&
    typeof value.revision === 'number' &&
    'profile' in value &&
    value.profile !== null &&
    typeof value.profile === 'object' &&
    'referenceImagePath' in value.profile &&
    typeof value.profile.referenceImagePath === 'string'
  );
}

function currentPetContext(): PetEntryContext | null {
  const state: unknown = useMissionSetupStore.getState();
  if (!state || typeof state !== 'object' || !('entryContext' in state)) {
    return null;
  }
  if (state.entryContext === null) return null;
  if (!isPetEntryContext(state.entryContext)) {
    throw new TypeError('Mission Setup exposed an invalid Pet entry context');
  }
  return state.entryContext;
}

describe('Pet hatch preparation', () => {
  beforeEach(() => {
    useMissionSetupStore.setState({
      workspacePath,
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
    useProductNavigationStore.setState({
      destination: { kind: 'terminal' },
      settingsReturnDestination: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists the fixed built-in and atomically opens an ephemeral exact Review without starting', async () => {
    const saveSquad = vi.fn(async () => ({ ok: true }));
    const prepare = vi.fn();
    const start = vi.fn();
    vi.stubGlobal('window', {
      nexus: { mission: { prepare, start } },
    });
    const navigation = useProductNavigationStore.getState();
    navigation.openSettings('appearance');

    await expect(
      preparePetHatchMission(firstImage, {
        workspacePath: () => workspacePath,
        saveSquad,
      }),
    ).resolves.toEqual({ ok: true });

    expect(saveSquad).toHaveBeenCalledWith(PET_STUDIO_SQUAD);
    expect(currentPetContext()).toEqual({
      kind: 'pet-studio',
      origin: 'settings-appearance',
      objective: expect.stringContaining('nexus-pet-studio'),
      title: 'Criar pet cat-source',
      roster: PET_STUDIO_SQUAD.agents,
      profile: {
        kind: 'pet-studio',
        referenceImagePath: firstImage,
      },
      step: 'review',
      revision: expect.any(Number),
    });
    expect(useMissionSetupStore.getState().draft).toMatchObject({
      title: 'Criar pet cat-source',
      roster: PET_STUDIO_SQUAD.agents,
      step: 'review',
    });
    expect(useProductNavigationStore.getState()).toMatchObject({
      destination: { kind: 'mission-setup' },
      settingsReturnDestination: { kind: 'terminal' },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('reselection replaces the image and advances authority so an earlier review is stale', async () => {
    const saveSquad = vi.fn(async () => ({ ok: true }));
    const deps = {
      workspacePath: () => workspacePath,
      saveSquad,
    };

    await preparePetHatchMission(firstImage, deps);
    const first = currentPetContext();
    await preparePetHatchMission(secondImage, deps);
    const second = currentPetContext();

    expect(second).toMatchObject({
      profile: {
        kind: 'pet-studio',
        referenceImagePath: secondImage,
      },
    });
    expect(second?.revision).toBeGreaterThan(first?.revision ?? -1);
    expect(useMissionSetupStore.getState().draft.revision).toBe(
      second?.revision,
    );
  });

  it.each([
    [
      'explicit cancellation',
      () => useMissionSetupStore.getState().clearEntryContext(),
      { kind: 'settings', section: 'appearance' },
    ],
    [
      'a rail departure',
      () => useProductNavigationStore.getState().openTerminal(),
      { kind: 'terminal' },
    ],
    [
      'an ordinary Mission Setup seeder',
      () => useProductNavigationStore.getState().openMissionSetup(),
      { kind: 'mission-setup' },
    ],
  ] as const)(
    'rejects a late squad save after %s without reseeding or stealing navigation',
    async (_label, leave, expectedDestination) => {
      let resolveSave:
        | ((result: { ok: boolean; error?: string }) => void)
        | undefined;
      const saveSquad = vi.fn(
        () =>
          new Promise<{ ok: boolean; error?: string }>((resolve) => {
            resolveSave = resolve;
          }),
      );
      useProductNavigationStore.getState().openSettings('appearance');

      const pending = preparePetHatchMission(firstImage, {
        workspacePath: () => workspacePath,
        saveSquad,
      });
      expect(saveSquad).toHaveBeenCalledOnce();

      leave();
      resolveSave?.({ ok: true });

      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(currentPetContext()).toBeNull();
      expect(useProductNavigationStore.getState().destination).toEqual(
        expectedDestination,
      );
    },
  );

  it('does not seed Review when the built-in cannot be saved or no workspace is active', async () => {
    const saveFailure = vi.fn(async () => ({
      ok: false,
      error: 'squad save failed',
    }));

    await expect(
      preparePetHatchMission(firstImage, {
        workspacePath: () => workspacePath,
        saveSquad: saveFailure,
      }),
    ).resolves.toEqual({ ok: false, error: 'squad save failed' });
    expect(currentPetContext()).toBeNull();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });

    await expect(
      preparePetHatchMission(firstImage, {
        workspacePath: () => null,
        saveSquad: vi.fn(async () => ({ ok: true })),
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(currentPetContext()).toBeNull();
  });
});
