import { describe, expect, it } from "vitest";
import {
  contextualPanelStateSchema,
  CONTEXTUAL_TABS,
  CONTEXTUAL_TAB_COPY,
  DEFAULT_CONTEXTUAL_PANEL,
} from "./contextual-panel";

describe("contextual panel contracts", () => {
  it("includes Browser/Editor/Git/Skills/Mission/Handoff/Search (+ memory)", () => {
    expect(CONTEXTUAL_TABS).toEqual(
      expect.arrayContaining([
        "browser",
        "editor",
        "git",
        "skills",
        "mission",
        "handoff",
        "search",
        "memory",
      ]),
    );
  });

  it("rejects undersized width and defaults without granting permissions", () => {
    // Fail-closed: invalid width is rejected (UI clamps before parse).
    expect(() =>
      contextualPanelStateSchema.parse({ widthPx: 50, workspaceId: "/ws/a" }),
    ).toThrow();
    const ok = contextualPanelStateSchema.parse({
      widthPx: 360,
      workspaceId: "/ws/a",
    });
    expect(ok.widthPx).toBe(360);
    expect(DEFAULT_CONTEXTUAL_PANEL.visible).toBe(false);
    // Empty copy documents no implicit permission grants
    for (const tab of CONTEXTUAL_TABS) {
      expect(CONTEXTUAL_TAB_COPY[tab].empty.length).toBeGreaterThan(10);
      expect(CONTEXTUAL_TAB_COPY[tab].loading.length).toBeGreaterThan(3);
    }
  });

  it("rejects invalid tab ids (fail closed)", () => {
    expect(() =>
      contextualPanelStateSchema.parse({ activeTab: "admin-root" }),
    ).toThrow();
  });

  it("accepts workspaceId in schema (persist helpers tested in contextual-panel-persist.test)", () => {
    const s = contextualPanelStateSchema.parse({
      workspaceId: "checkout-abc",
      activeTab: "skills",
      widthPx: 400,
    });
    expect(s.workspaceId).toBe("checkout-abc");
    expect(s.activeTab).toBe("skills");
  });
});
