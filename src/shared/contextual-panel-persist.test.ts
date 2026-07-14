import { describe, expect, it } from 'vitest';
import {
  clearContextualPanelState,
  contextualPanelStorageKey,
  loadContextualPanelState,
  saveContextualPanelState,
  type KeyValueStorage,
} from './contextual-panel-persist';

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('contextual panel persistence (real helpers)', () => {
  it('round-trips activeTab, widthPx, visible per workspaceId', () => {
    const storage = memoryStorage();
    saveContextualPanelState(
      'ws-alpha',
      { activeTab: 'skills', widthPx: 420, visible: false },
      storage,
    );
    const loaded = loadContextualPanelState('ws-alpha', storage);
    expect(loaded).toMatchObject({
      activeTab: 'skills',
      widthPx: 420,
      visible: false,
      workspaceId: 'ws-alpha',
    });
    // Different workspace is isolated.
    expect(loadContextualPanelState('ws-beta', storage)).toBeNull();
  });

  it('keys storage by workspaceId', () => {
    expect(contextualPanelStorageKey('checkout-1')).toBe(
      'nexus.contextualPanel.v1:checkout-1',
    );
    expect(() => contextualPanelStorageKey('')).toThrow(/workspaceId/);
  });

  it('returns null on corrupt payload and does not throw', () => {
    const storage = memoryStorage();
    storage.setItem(contextualPanelStorageKey('ws'), '{not-json');
    expect(loadContextualPanelState('ws', storage)).toBeNull();
  });

  it('clear removes the workspace key', () => {
    const storage = memoryStorage();
    saveContextualPanelState(
      'ws',
      { activeTab: 'editor', widthPx: 300, visible: true },
      storage,
    );
    clearContextualPanelState('ws', storage);
    expect(loadContextualPanelState('ws', storage)).toBeNull();
  });

  it('overwrites previous tab for same workspace on save', () => {
    const storage = memoryStorage();
    saveContextualPanelState(
      'ws',
      { activeTab: 'git', widthPx: 280, visible: true },
      storage,
    );
    saveContextualPanelState(
      'ws',
      { activeTab: 'search', widthPx: 500, visible: true },
      storage,
    );
    expect(loadContextualPanelState('ws', storage)?.activeTab).toBe('search');
    expect(loadContextualPanelState('ws', storage)?.widthPx).toBe(500);
  });
});
