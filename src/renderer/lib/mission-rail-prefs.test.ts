import { describe, expect, it } from 'vitest';
import {
  loadPinnedMissionIds,
  savePinnedMissionIds,
  togglePinnedMissionId,
} from './mission-rail-prefs';

function memoryStore(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    getItem(key: string) {
      return data[key] ?? null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    removeItem(key: string) {
      delete data[key];
    },
    data,
  };
}

describe('mission rail pins per workspace', () => {
  it('keeps pins isolated between workspace paths', () => {
    const store = memoryStore();
    savePinnedMissionIds('/a', ['m1', 'm2'], store);
    savePinnedMissionIds('/b', ['m9'], store);

    expect(loadPinnedMissionIds('/a', store)).toEqual(['m1', 'm2']);
    expect(loadPinnedMissionIds('/b', store)).toEqual(['m9']);
    expect(loadPinnedMissionIds('/c', store)).toEqual([]);
    expect(loadPinnedMissionIds(null, store)).toEqual([]);
  });

  it('toggles pins only for the active workspace', () => {
    const store = memoryStore();
    expect(togglePinnedMissionId('/proj', 'mission-1', store)).toEqual([
      'mission-1',
    ]);
    expect(togglePinnedMissionId('/proj', 'mission-2', store)).toEqual([
      'mission-2',
      'mission-1',
    ]);
    expect(togglePinnedMissionId('/proj', 'mission-1', store)).toEqual([
      'mission-2',
    ]);
    expect(loadPinnedMissionIds('/other', store)).toEqual([]);
  });
});
