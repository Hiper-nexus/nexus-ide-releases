/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamificationSnapshot } from '../../shared/gamification-types';
import { setActiveWorkspacePath } from './active-workspace';
import {
  EMPTY_GAMIFICATION_SNAPSHOT,
  useGamificationStore,
} from './gamification-store';

function snapshot(
  rootRealPath: string,
  powerLevel: number,
): GamificationSnapshot {
  return {
    ...EMPTY_GAMIFICATION_SNAPSHOT,
    projectId: rootRealPath === '/workspace/a' ? 'project-a' : 'project-b',
    checkoutId: 'main',
    rootRealPath,
    powerLevel,
  };
}

beforeEach(() => {
  setActiveWorkspacePath(null);
  useGamificationStore.setState({
    snapshot: EMPTY_GAMIFICATION_SNAPSHOT,
    sober: false,
    profileOpen: false,
  });
});

afterEach(() => {
  setActiveWorkspacePath(null);
  vi.restoreAllMocks();
});

describe('renderer gamification project isolation', () => {
  it('rejects a snapshot from a workspace that is no longer active', () => {
    setActiveWorkspacePath('/workspace/a');
    useGamificationStore.getState().receive(snapshot('/workspace/a', 8_000));
    expect(useGamificationStore.getState().snapshot.powerLevel).toBe(8_000);

    setActiveWorkspacePath('/workspace/b');
    useGamificationStore.getState().reset();
    useGamificationStore.getState().receive(snapshot('/workspace/a', 9_500));
    expect(useGamificationStore.getState().snapshot.powerLevel).toBe(0);

    useGamificationStore.getState().receive(snapshot('/workspace/b', 1_500));
    expect(useGamificationStore.getState().snapshot).toEqual(
      expect.objectContaining({
        projectId: 'project-b',
        rootRealPath: '/workspace/b',
        powerLevel: 1_500,
      }),
    );
  });

  it('drops a hydrate response when workspace changes while IPC is pending', async () => {
    let resolveSnapshot: ((value: GamificationSnapshot) => void) | undefined;
    const pendingSnapshot = new Promise<GamificationSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        gamification: {
          snapshot: vi.fn(() => pendingSnapshot),
          onChanged: vi.fn(() => vi.fn()),
        },
        settings: {
          orchGet: vi.fn(async () => ({ soberMode: false })),
        },
      },
    });
    setActiveWorkspacePath('/workspace/a');

    const hydration = useGamificationStore.getState().hydrate();
    setActiveWorkspacePath('/workspace/b');
    useGamificationStore.getState().reset();
    resolveSnapshot?.(snapshot('/workspace/a', 8_000));
    await hydration;

    expect(useGamificationStore.getState().snapshot).toBe(
      EMPTY_GAMIFICATION_SNAPSHOT,
    );
  });
});
