import { describe, expect, it } from "vitest";
import {
  clearContextualPanelState,
  contextualPanelStorageKey,
  LEGACY_CONTEXTUAL_PANEL_STORAGE_PREFIX,
  loadContextualPanelState,
  saveContextualPanelState,
  type KeyValueStorage,
} from "./contextual-panel-persist";

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

describe("contextual panel persistence (real helpers)", () => {
  it("round-trips activeTab, widthPx, visible per workspaceId", () => {
    const storage = memoryStorage();
    saveContextualPanelState(
      "ws-alpha",
      { activeTab: "skills", widthPx: 420, visible: false },
      storage,
    );
    const loaded = loadContextualPanelState("ws-alpha", storage);
    expect(loaded).toMatchObject({
      activeTab: "skills",
      widthPx: 420,
      visible: false,
      workspaceId: "ws-alpha",
    });
    // Different workspace is isolated.
    expect(loadContextualPanelState("ws-beta", storage)).toBeNull();
  });

  it("keys storage by workspaceId", () => {
    expect(contextualPanelStorageKey("checkout-1")).toBe(
      "nexus.contextualPanel.v2:checkout-1",
    );
    expect(() => contextualPanelStorageKey("")).toThrow(/workspaceId/);
  });

  it("migrates v1 without losing the tab or width and starts canvas-first", () => {
    const storage = memoryStorage();
    const legacyKey = `${LEGACY_CONTEXTUAL_PANEL_STORAGE_PREFIX}ws-legacy`;
    storage.setItem(
      legacyKey,
      JSON.stringify({
        activeTab: "skills",
        widthPx: 476,
        visible: true,
        workspaceId: "ws-legacy",
      }),
    );

    expect(loadContextualPanelState("ws-legacy", storage)).toMatchObject({
      activeTab: "skills",
      widthPx: 476,
      visible: false,
      workspaceId: "ws-legacy",
    });
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(
      JSON.parse(
        storage.getItem(contextualPanelStorageKey("ws-legacy")) ?? "{}",
      ),
    ).toMatchObject({
      activeTab: "skills",
      widthPx: 476,
      visible: false,
    });
  });

  it("keeps explicit v2 visibility instead of repeating the v1 reset", () => {
    const storage = memoryStorage();
    storage.setItem(
      `${LEGACY_CONTEXTUAL_PANEL_STORAGE_PREFIX}ws-current`,
      JSON.stringify({
        activeTab: "skills",
        widthPx: 476,
        visible: true,
        workspaceId: "ws-current",
      }),
    );
    saveContextualPanelState(
      "ws-current",
      { activeTab: "git", widthPx: 520, visible: true },
      storage,
    );

    expect(loadContextualPanelState("ws-current", storage)).toMatchObject({
      activeTab: "git",
      widthPx: 520,
      visible: true,
    });
  });

  it("returns null on corrupt payload and does not throw", () => {
    const storage = memoryStorage();
    storage.setItem(contextualPanelStorageKey("ws"), "{not-json");
    expect(loadContextualPanelState("ws", storage)).toBeNull();
  });

  it("clear removes the workspace key", () => {
    const storage = memoryStorage();
    const legacyKey = `${LEGACY_CONTEXTUAL_PANEL_STORAGE_PREFIX}ws`;
    storage.setItem(legacyKey, "{}");
    saveContextualPanelState(
      "ws",
      { activeTab: "editor", widthPx: 300, visible: true },
      storage,
    );
    clearContextualPanelState("ws", storage);
    expect(loadContextualPanelState("ws", storage)).toBeNull();
    expect(storage.getItem(legacyKey)).toBeNull();
  });

  it("overwrites previous tab for same workspace on save", () => {
    const storage = memoryStorage();
    saveContextualPanelState(
      "ws",
      { activeTab: "git", widthPx: 280, visible: true },
      storage,
    );
    saveContextualPanelState(
      "ws",
      { activeTab: "search", widthPx: 500, visible: true },
      storage,
    );
    expect(loadContextualPanelState("ws", storage)?.activeTab).toBe("search");
    expect(loadContextualPanelState("ws", storage)?.widthPx).toBe(500);
  });
});
