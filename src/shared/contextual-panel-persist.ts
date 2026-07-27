import {
  contextualPanelStateSchema,
  type ContextualPanelState,
  type ContextualTab,
} from "./contextual-panel";

/**
 * Pure persistence for ContextualPanel tab/width/visible per workspace.
 * Storage is injected so unit tests drive the real helpers without browser.
 */

export const CONTEXTUAL_PANEL_STORAGE_PREFIX = "nexus.contextualPanel.v2:";
export const LEGACY_CONTEXTUAL_PANEL_STORAGE_PREFIX =
  "nexus.contextualPanel.v1:";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageKey(
  prefix: string,
  workspaceId: string,
): string {
  const id = workspaceId.trim();
  if (!id) throw new Error("workspaceId required for panel persistence");
  return `${prefix}${id}`;
}

export function contextualPanelStorageKey(workspaceId: string): string {
  return storageKey(CONTEXTUAL_PANEL_STORAGE_PREFIX, workspaceId);
}

function parseStoredState(
  raw: string | null,
  workspaceId: string,
): ContextualPanelState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return contextualPanelStateSchema.parse({
      ...parsed,
      workspaceId,
    });
  } catch {
    return null;
  }
}

function persistedFields(
  state: ContextualPanelState,
): Partial<ContextualPanelState> {
  return {
    activeTab: state.activeTab,
    widthPx: state.widthPx,
    visible: state.visible,
    workspaceId: state.workspaceId,
  };
}

/**
 * Load panel UI state for a workspace.
 *
 * v1 kept the drawer permanently open by default. Its one-time migration keeps
 * the user's tab and width, closes the drawer for the new canvas-first shell,
 * and writes v2 so later explicit visibility choices remain durable.
 */
export function loadContextualPanelState(
  workspaceId: string,
  storage: KeyValueStorage,
): Partial<ContextualPanelState> | null {
  try {
    const currentKey = contextualPanelStorageKey(workspaceId);
    const current = parseStoredState(storage.getItem(currentKey), workspaceId);
    if (current) return persistedFields(current);

    const legacyKey = storageKey(
      LEGACY_CONTEXTUAL_PANEL_STORAGE_PREFIX,
      workspaceId,
    );
    const legacy = parseStoredState(storage.getItem(legacyKey), workspaceId);
    if (!legacy) return null;

    const migrated = contextualPanelStateSchema.parse({
      ...legacy,
      visible: false,
      workspaceId,
    });
    try {
      storage.setItem(currentKey, JSON.stringify(migrated));
      storage.removeItem(legacyKey);
    } catch {
      // Storage may be read-only/private. The in-memory migration still works.
    }
    return persistedFields(migrated);
  } catch {
    return null;
  }
}

/** Persist tab/width/visible for a workspace (fail-soft on quota). */
export function saveContextualPanelState(
  workspaceId: string,
  state: Pick<ContextualPanelState, "activeTab" | "widthPx" | "visible">,
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
    storage.removeItem(
      storageKey(LEGACY_CONTEXTUAL_PANEL_STORAGE_PREFIX, workspaceId),
    );
  } catch {
    /* ignore */
  }
}

/** Browser localStorage adapter; null outside browser. */
export function browserLocalStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}
