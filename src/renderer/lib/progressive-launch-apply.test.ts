import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const addShellPane = vi.fn();
let paneCount = 1;

vi.mock('./split-tree', () => ({
  listPanes: () => Array.from({ length: paneCount }, (_, i) => ({ id: `p${i}` })),
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: {},
      addShellPane: () => {
        addShellPane();
        paneCount += 1;
      },
    }),
  },
}));

import {
  applyProgressiveLaunchIfPending,
  stashProgressiveLaunch,
  clearProgressiveLaunch,
} from './progressive-launch';
import { useProductNavigationStore } from '../state/product-navigation-store';

const map = new Map<string, string>();

beforeEach(() => {
  map.clear();
  paneCount = 1;
  addShellPane.mockClear();
  useProductNavigationStore.setState({
    destination: { kind: 'launcher' },
    settingsReturnDestination: null,
  });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  });
});

afterEach(() => {
  clearProgressiveLaunch();
  vi.unstubAllGlobals();
});

describe('applyProgressiveLaunchIfPending', () => {
  it('open-without-AI expands panes and opens the Terminal destination', () => {
    stashProgressiveLaunch({
      mode: 'terminal-only',
      paneCount: 4,
      agentDistribution: 'none',
      openWithoutAi: true,
    });

    expect(applyProgressiveLaunchIfPending()).toBe(true);
    expect(addShellPane).toHaveBeenCalled();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
  });

  it('opens canonical Mission Setup for missions with AI', () => {
    stashProgressiveLaunch({
      mode: 'missions',
      paneCount: 1,
      agentDistribution: 'one-of-each',
      openWithoutAi: false,
    });

    expect(applyProgressiveLaunchIfPending()).toBe(true);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
  });

  it.each([
    [
      'swarm',
      {
        mode: 'swarm' as const,
        paneCount: 4 as const,
        agentDistribution: 'split-evenly' as const,
        openWithoutAi: false,
      },
      { kind: 'mission-setup' },
    ],
    [
      'board',
      {
        mode: 'board' as const,
        paneCount: 1 as const,
        agentDistribution: 'none' as const,
        openWithoutAi: false,
      },
      { kind: 'task-board' },
    ],
    [
      'terminal-only',
      {
        mode: 'terminal-only' as const,
        paneCount: 2 as const,
        agentDistribution: 'none' as const,
        openWithoutAi: true,
      },
      { kind: 'terminal' },
    ],
  ])('maps progressive mode %s to its product destination', (_label, plan, expected) => {
    stashProgressiveLaunch(plan);

    expect(applyProgressiveLaunchIfPending()).toBe(true);
    expect(useProductNavigationStore.getState().destination).toEqual(expected);
  });

  it('no-op when nothing stashed', () => {
    expect(applyProgressiveLaunchIfPending()).toBe(false);
  });
});
