/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useContextualPanelNavStore } from "../state/contextual-panel-nav-store";
import { ContextualPanel } from "./ContextualPanel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ContextualPanel renderer navigation", () => {
  beforeEach(() => {
    useContextualPanelNavStore.setState({ requestedTab: null, requestId: 0 });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens a requested Git tab without changing product authority", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ContextualPanel
          activeTab="mission"
          storage={null}
          initial={{ visible: true }}
          children={{
            mission: <span>Missão</span>,
            git: <span>Git seguro</span>,
          }}
        />,
      );
    });

    expect(host.querySelector('[data-testid="ctx-tab-mission"]')).toBeTruthy();
    act(() => useContextualPanelNavStore.getState().openTab("git"));
    expect(host.querySelector('[data-testid="ctx-tab-git"]')?.textContent).toBe(
      "Git seguro",
    );
    act(() => root.unmount());
  });
});
