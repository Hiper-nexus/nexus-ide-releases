/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import {
  applyProgressiveLaunchIfPending,
  clearProgressiveLaunch,
  stashProgressiveLaunch,
} from './progressive-launch';

function petEntryContext(): unknown {
  const state: unknown = useMissionSetupStore.getState();
  if (!state || typeof state !== 'object' || !('entryContext' in state)) {
    return null;
  }
  return state.entryContext;
}

describe('progressive launch replacing Pet Review', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useMissionSetupStore.setState({
      workspacePath: '/workspace',
      draft: {
        objective: 'Criar o pet governado.',
        title: 'Criar pet cat-source',
        contextPaths: [],
        roster: PET_STUDIO_SQUAD.agents.map((agent) => ({ ...agent })),
        advanced: { lane: 'standard' },
        step: 'review',
        revision: 4,
      },
      persistence: { status: 'idle' },
      workspaceDrafts: {},
      entryContext: {
        kind: 'pet-studio',
        origin: 'settings-appearance',
        objective: 'Criar o pet governado.',
        title: 'Criar pet cat-source',
        roster: PET_STUDIO_SQUAD.agents,
        profile: {
          kind: 'pet-studio',
          referenceImagePath:
            '/workspace/.nexus/attachments/pet-studio/cat-source.png',
        },
        step: 'review',
        revision: 4,
      },
    } as never);
    useProductNavigationStore.setState({
      destination: { kind: 'mission-setup' },
      settingsReturnDestination: { kind: 'terminal' },
    });
  });

  afterEach(() => {
    clearProgressiveLaunch();
    useMissionSetupStore.setState({ entryContext: null } as never);
  });

  it('invalidates Pet authority before a pending ordinary Missions launch opens Setup', () => {
    stashProgressiveLaunch({
      mode: 'missions',
      paneCount: 1,
      agentDistribution: 'one-of-each',
      openWithoutAi: false,
    });

    expect(applyProgressiveLaunchIfPending()).toBe(true);

    expect(petEntryContext()).toBeNull();
    expect(useProductNavigationStore.getState()).toMatchObject({
      destination: { kind: 'mission-setup' },
      settingsReturnDestination: null,
    });
  });
});
