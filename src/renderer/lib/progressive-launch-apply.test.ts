import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const addShellPane = vi.fn();
const hide = vi.fn();
const openForMission = vi.fn();
const toggleBoard = vi.fn();
const openPanel = vi.fn();
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

vi.mock('../state/home-store', () => ({
  useHomeStore: {
    getState: () => ({ hide }),
  },
}));

vi.mock('../state/mission-wizard-store', () => ({
  useMissionWizardStore: {
    getState: () => ({ openForMission }),
  },
}));

vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({
      boardOpen: false,
      toggleBoard,
      openPanel,
    }),
  },
}));

import {
  applyProgressiveLaunchIfPending,
  stashProgressiveLaunch,
  clearProgressiveLaunch,
} from './progressive-launch';

const map = new Map<string, string>();

beforeEach(() => {
  map.clear();
  paneCount = 1;
  addShellPane.mockClear();
  hide.mockClear();
  openForMission.mockClear();
  toggleBoard.mockClear();
  openPanel.mockClear();
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
  it('open-without-AI expands panes and never opens mission wizard', () => {
    stashProgressiveLaunch({
      mode: 'terminal-only',
      paneCount: 4,
      agentDistribution: 'none',
      openWithoutAi: true,
    });
    expect(applyProgressiveLaunchIfPending()).toBe(true);
    expect(addShellPane).toHaveBeenCalled();
    expect(openForMission).not.toHaveBeenCalled();
  });

  it('missions with AI opens wizard; with openWithoutAi does not', () => {
    stashProgressiveLaunch({
      mode: 'missions',
      paneCount: 1,
      agentDistribution: 'one-of-each',
      openWithoutAi: false,
    });
    applyProgressiveLaunchIfPending();
    expect(openForMission).toHaveBeenCalled();

    openForMission.mockClear();
    stashProgressiveLaunch({
      mode: 'missions',
      paneCount: 1,
      agentDistribution: 'none',
      openWithoutAi: true,
    });
    applyProgressiveLaunchIfPending();
    expect(openForMission).not.toHaveBeenCalled();
  });

  it('no-op when nothing stashed', () => {
    expect(applyProgressiveLaunchIfPending()).toBe(false);
  });
});
