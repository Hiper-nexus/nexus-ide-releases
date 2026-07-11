import { describe, expect, it } from 'vitest';
import {
  loadPinnedWorkspacePaths,
  savePinnedWorkspacePaths,
  togglePinnedWorkspacePath,
} from './workspace-rail-prefs';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    data,
  };
}

describe('workspace-rail-prefs', () => {
  it('toggles pins', () => {
    const store = fakeStorage();
    expect(togglePinnedWorkspacePath('/a', store)).toEqual(['/a']);
    expect(togglePinnedWorkspacePath('/b', store)).toEqual(['/b', '/a']);
    expect(togglePinnedWorkspacePath('/a', store)).toEqual(['/b']);
    expect(loadPinnedWorkspacePaths(store)).toEqual(['/b']);
  });

  it('persists and loads', () => {
    const store = fakeStorage();
    savePinnedWorkspacePaths(['/x', '/y'], store);
    expect(loadPinnedWorkspacePaths(store)).toEqual(['/x', '/y']);
  });
});
