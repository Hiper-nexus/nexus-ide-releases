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
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
      writable: true,
    });
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

  it("keeps only relevant tabs and supports roving keyboard navigation", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ContextualPanel
          storage={null}
          initial={{ visible: true, activeTab: "mission" }}
          relevantTabs={["mission", "editor", "git", "search"]}
          children={{
            mission: <span>Missão</span>,
            editor: <span>Editor</span>,
            git: <span>Git</span>,
            search: <span>Busca</span>,
          }}
        />,
      );
    });

    const tabs = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Missão",
      "Editor",
      "Git",
      "Busca",
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);

    tabs[0]?.focus();
    act(() => {
      tabs[0]?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      );
    });
    expect(document.activeElement).toBe(tabs[1]);
    expect(host.querySelector('[data-testid="ctx-tab-editor"]')).toBeTruthy();

    act(() => {
      tabs[1]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(tabs[3]);
    expect(host.querySelector('[data-testid="ctx-tab-search"]')).toBeTruthy();

    act(() => {
      tabs[3]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(tabs[0]);
    expect(host.querySelector('[data-testid="ctx-tab-mission"]')).toBeTruthy();
    act(() => root.unmount());
  });

  it("exposes the splitter range and resizes it from the keyboard", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ContextualPanel
          storage={null}
          initial={{ visible: true, widthPx: 360 }}
        />,
      );
    });

    const panel = host.querySelector<HTMLElement>('[data-testid="contextual-panel"]');
    const splitter = host.querySelector<HTMLElement>('[role="separator"]');
    expect(splitter?.tabIndex).toBe(0);
    expect(splitter?.getAttribute("aria-valuemin")).toBe("200");
    expect(splitter?.getAttribute("aria-valuemax")).toBe("900");
    expect(splitter?.getAttribute("aria-valuenow")).toBe("360");

    act(() => {
      splitter?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
        }),
      );
    });
    expect(panel?.style.width).toBe("376px");
    expect(splitter?.getAttribute("aria-valuenow")).toBe("376");

    act(() => {
      splitter?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(panel?.style.width).toBe("200px");

    act(() => {
      splitter?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(panel?.style.width).toBe("900px");
    act(() => root.unmount());
  });

  it("becomes an overlay drawer on a narrow window instead of crushing the canvas", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 640,
      writable: true,
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ContextualPanel
          storage={null}
          initial={{ visible: true, widthPx: 900 }}
        />,
      );
    });

    const panel = host.querySelector<HTMLElement>(
      '[data-testid="contextual-panel"]',
    );
    const splitter = host.querySelector<HTMLElement>('[role="separator"]');
    expect(panel?.dataset.presentation).toBe("drawer");
    expect(panel?.style.width).toBe("624px");
    expect(splitter?.getAttribute("aria-valuemax")).toBe("624");
    act(() => root.unmount());
  });
});
