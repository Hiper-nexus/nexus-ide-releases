import {
  contextualPanelStateSchema,
  type ContextualPanelState,
  type ContextualTab,
} from './contextual-panel';

/**
 * Pure persistence for ContextualPanel tab/width/visible per workspace.
 * Storage is injected so unit tests drive the real helpers without browser.
 */

export const CONTEXTUAL_PANEL_STORAGE_PREFIX = 'nexus.contextualPanel.v1:';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function contextualPanelStorageKey(workspaceId: string): string {
  const id = workspaceId.trim();
  if (!id) throw new Error('workspaceId required for panel persistence');
  return `${CONTEXTUAL_PANEL_STORAGE_PREFIX}${id}`;
}

/** Load persisted panel UI state for a workspace; null if missing/corrupt. */
export function loadContextualPanelState(
  workspaceId: string,
  storage: KeyValueStorage,
): Partial<ContextualPanelState> | null {
  try {
    const raw = storage.getItem(contextualPanelStorageKey(workspaceId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // Merge with defaults via schema so partials are valid.
    const merged = contextualPanelStateSchema.parse({
      ...parsed,
      workspaceId,
    });
    return {
      activeTab: merged.activeTab,
      widthPx: merged.widthPx,
      visible: merged.visible,
      workspaceId: merged.workspaceId,
    };
  } catch {
    return null;
  }
}

/** Persist tab/width/visible for a workspace (fail-soft on quota). */
export function saveContextualPanelState(
  workspaceId: string,
  state: Pick<ContextualPanelState, 'activeTab' | 'widthPx' | 'visible'>,
  storage: KeyValueStorage,
): void {
  try {
    const payload = {
      activeTab: state.activeTab as ContextualTab,
      widthPx: state.widthPx,
      visible: state.visible,
      workspaceId,
    };
    // Validate before write.
    contextualPanelStateSchema.parse(payload);
    storage.setItem(
      contextualPanelStorageKey(workspaceId),
      JSON.stringify(payload),
    );
  } catch {
    /* private mode / quota — fail soft */
  }
}

export function clearContextualPanelState(
  workspaceId: string,
  storage: KeyValueStorage,
): void {
  try {
    storage.removeItem(contextualPanelStorageKey(workspaceId));
  } catch {
    /* ignore */
  }
}

/** Browser localStorage adapter; null outside browser. */
export function browserLocalStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
