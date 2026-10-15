import { describe, expect, it } from 'vitest';
import {
  loadArchivedMissionIds,
  loadCollapsedSections,
  loadPinnedMissionIds,
  savePinnedMissionIds,
  setMissionArchived,
  togglePinnedMissionId,
  loadCollapsedWorkspacePaths,
  loadRecentWorkspacesOpen,
  saveCollapsedWorkspacePaths,
  saveRecentWorkspacesOpen,
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

describe('archived missions (view-only, per workspace)', () => {
  function memoryStore() {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it('arquiva e desarquiva por workspace, sem vazar entre pastas', () => {
    const store = memoryStore();
    expect(setMissionArchived('/w/a', 'm1', true, store)).toEqual(['m1']);
    expect(loadArchivedMissionIds('/w/a', store)).toEqual(['m1']);
    expect(loadArchivedMissionIds('/w/b', store)).toEqual([]);

    setMissionArchived('/w/b', 'm2', true, store);
    expect(loadArchivedMissionIds('/w/a', store)).toEqual(['m1']);
    expect(loadArchivedMissionIds('/w/b', store)).toEqual(['m2']);

    expect(setMissionArchived('/w/a', 'm1', false, store)).toEqual([]);
    expect(loadArchivedMissionIds('/w/a', store)).toEqual([]);
    expect(loadArchivedMissionIds('/w/b', store)).toEqual(['m2']);
  });

  it('arquivar duas vezes não duplica e sem workspace é no-op', () => {
    const store = memoryStore();
    setMissionArchived('/w/a', 'm1', true, store);
    expect(setMissionArchived('/w/a', 'm1', true, store)).toEqual(['m1']);
    expect(setMissionArchived(null, 'm1', true, store)).toEqual([]);
  });

  it('seções sem trabalho vivo nascem fechadas', () => {
    expect(loadCollapsedSections(memoryStore())).toEqual([
      'stopped',
      'done',
      'archived',
    ]);
  });

  it('lembra quais projetos a pessoa recolheu no rail, e nada mais', () => {
    const store = new Map<string, string>();
    const like = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadCollapsedWorkspacePaths(like)).toEqual([]);
    saveCollapsedWorkspacePaths(['/ws/a', '/ws/a', '/ws/b'], like);
    expect(loadCollapsedWorkspacePaths(like)).toEqual(['/ws/a', '/ws/b']);
    like.setItem('nexus.activityRail.collapsedWorkspaces', '{not json');
    expect(loadCollapsedWorkspacePaths(like)).toEqual([]);
    expect(loadCollapsedWorkspacePaths(null)).toEqual([]);
  });

  it('Recentes: sem escolha salva é null (a tela decide o padrão) e a escolha vale nos dois sentidos', () => {
    const store = new Map<string, string>();
    const like = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadRecentWorkspacesOpen(like)).toBeNull();
    saveRecentWorkspacesOpen(true, like);
    expect(loadRecentWorkspacesOpen(like)).toBe(true);
    saveRecentWorkspacesOpen(false, like);
    // Recolher de propósito é uma escolha: não volta a ser "sem escolha".
    expect(loadRecentWorkspacesOpen(like)).toBe(false);
    like.setItem('nexus.activityRail.recentWorkspacesOpen', 'qualquer-coisa');
    expect(loadRecentWorkspacesOpen(like)).toBeNull();
    expect(loadRecentWorkspacesOpen(null)).toBeNull();
    expect(() => saveRecentWorkspacesOpen(true, null)).not.toThrow();
  });

  it('Recentes: storage que lança nunca quebra o rail', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadRecentWorkspacesOpen(broken)).toBeNull();
    expect(() => saveRecentWorkspacesOpen(false, broken)).not.toThrow();
  });
});
