import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  stashProgressiveLaunch,
  takeProgressiveLaunch,
} from './progressive-launch';

const map = new Map<string, string>();

beforeEach(() => {
  map.clear();
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
  vi.unstubAllGlobals();
});

describe('progressive launch stash', () => {
  it('round-trips a plan through sessionStorage', () => {
    stashProgressiveLaunch({
      mode: 'terminal-only',
      paneCount: 4,
      agentDistribution: 'none',
      openWithoutAi: true,
      recentWorkspacePath: '/tmp/proj',
    });
    const plan = takeProgressiveLaunch();
    expect(plan).toMatchObject({
      mode: 'terminal-only',
      paneCount: 4,
      openWithoutAi: true,
      recentWorkspacePath: '/tmp/proj',
    });
    // Second take is empty (consumed once).
    expect(takeProgressiveLaunch()).toBeNull();
  });

  it('returns null on corrupt payload', () => {
    sessionStorage.setItem('nexus.progressiveLaunch.v1', '{not-json');
    expect(takeProgressiveLaunch()).toBeNull();
  });
});
