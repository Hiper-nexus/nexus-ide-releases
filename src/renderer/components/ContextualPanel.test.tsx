/** @vitest-environment jsdom */
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONTEXTUAL_PANEL,
  type ContextualPanelState,
} from "../../shared/contextual-panel";
import type { KeyValueStorage } from "../../shared/contextual-panel-persist";
import { useContextualPanelNavStore } from "../state/contextual-panel-nav-store";
import {
  ContextualPanel,
  type ContextualPanelFocusTarget,
} from "./ContextualPanel";
import { AppShell } from "./product/AppShell";

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

  it("reports visibility so AppShell can own the secondary inspector slot", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onStateChange = vi.fn();
    act(() => {
      root.render(
        <ContextualPanel
          workspaceId="/tmp/nexus"
          storage={null}
          initial={{ visible: false }}
          onStateChange={onStateChange}
        />,
      );
    });

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "/tmp/nexus",
        visible: false,
      }),
    );

    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Abrir painel de contexto"]',
        )
        ?.click();
    });

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "/tmp/nexus",
        visible: true,
      }),
    );
    act(() => root.unmount());
  });
  it("normalizes retired tabs and supports roving keyboard navigation", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ContextualPanel
          storage={null}
          initial={{ visible: true, activeTab: "browser" }}
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

    act(() => useContextualPanelNavStore.getState().openTab("browser"));
    expect(host.querySelector('[data-testid="ctx-tab-mission"]')).toBeTruthy();
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].some(
        (tab) => tab.textContent === "Browser",
      ),
    ).toBe(false);

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
    expect(splitter?.getAttribute("aria-valuemin")).toBe("300");
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
    expect(panel?.style.width).toBe("300px");

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

describe("ContextualPanel leaving the AppShell inspector", () => {
  const WORKSPACE = "/tmp/nexus";
  let frames: FrameRequestCallback[] = [];
  let root: Root | null = null;
  /** Listeners vivos na janela, por tipo — o que o operador sente ao teclar. */
  let windowListeners: Map<string, Set<EventListenerOrEventListenerObject>>;

  function memoryStorage(): KeyValueStorage & { setItem: ReturnType<typeof vi.fn> } {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: (key) => {
        values.delete(key);
      },
    };
  }

  /** Mesmo reparenting do App: cabeçalho quando oculto, inspector quando visível. */
  function ReparentingShell({
    storage,
    onStateChange,
  }: {
    storage: KeyValueStorage;
    onStateChange: (state: ContextualPanelState) => void;
  }) {
    const [panelState, setPanelState] = useState<ContextualPanelState>({
      ...DEFAULT_CONTEXTUAL_PANEL,
      workspaceId: WORKSPACE,
      visible: true,
    });
    const [focusTarget, setFocusTarget] =
      useState<ContextualPanelFocusTarget | null>(null);
    const handleStateChange = useCallback(
      (next: ContextualPanelState) => {
        onStateChange(next);
        setPanelState(next);
      },
      [onStateChange],
    );
    const panel = (
      <ContextualPanel
        key={WORKSPACE}
        workspaceId={WORKSPACE}
        storage={storage}
        initial={panelState}
        placement={panelState.visible ? "inspector" : "header"}
        focusTarget={focusTarget}
        onFocusTargetChange={setFocusTarget}
        onStateChange={handleStateChange}
        relevantTabs={["mission", "git"]}
        children={{ mission: <span>Missão</span> }}
      />
    );
    return (
      <AppShell
        rail={<span>Rail</span>}
        header={!panelState.visible ? panel : null}
        content={<p>Terminal</p>}
        inspector={panelState.visible ? panel : undefined}
        inspectorScopeKey={`${WORKSPACE}\nterminal\ncontextual-panel`}
      />
    );
  }

  function activeListeners(type: string): number {
    return windowListeners.get(type)?.size ?? 0;
  }

  beforeEach(() => {
    frames = [];
    windowListeners = new Map();
    useContextualPanelNavStore.setState({ requestedTab: null, requestId: 0 });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
      writable: true,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation(
      (type, listener, options) => {
        if (listener) {
          const set = windowListeners.get(type) ?? new Set();
          set.add(listener);
          windowListeners.set(type, set);
        }
        add(type, listener, options);
      },
    );
    vi.spyOn(window, "removeEventListener").mockImplementation(
      (type, listener, options) => {
        if (listener) windowListeners.get(type)?.delete(listener);
        remove(type, listener, options);
      },
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the exiting copy as a drawing: one live listener, one panel id, one write per Alt+]", () => {
    const storage = memoryStorage();
    const onStateChange = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <ReparentingShell storage={storage} onStateChange={onStateChange} />,
      ),
    );
    // Dois quadros pintados: a partir daqui fechar anima a saída.
    for (let frame = 0; frame < 2; frame += 1) {
      act(() => {
        for (const callback of frames.splice(0)) callback(0);
      });
    }

    act(() => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Ocultar painel"]')
        ?.click();
    });

    const exiting = host.querySelector<HTMLElement>("aside.product-inspector");
    expect(exiting?.dataset.state).toBe("closing");
    // Ainda desenhado durante a saída, mas sem a identidade do painel vivo.
    expect(exiting?.querySelector(".ctx-panel")).not.toBeNull();
    expect(
      host.querySelectorAll('[data-testid="contextual-panel"]'),
    ).toHaveLength(0);
    expect(exiting?.querySelector('[data-testid^="ctx-tab-"]')).toBeNull();
    expect(
      host.querySelector('header [aria-label="Abrir painel de contexto"]'),
    ).not.toBeNull();
    expect(activeListeners("keydown")).toBe(1);
    expect(activeListeners("resize")).toBe(1);

    storage.setItem.mockClear();
    onStateChange.mockClear();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "]",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ visible: true }),
    );
    expect(
      host.querySelectorAll('[data-testid="contextual-panel"]'),
    ).toHaveLength(1);
    expect(
      host.querySelector<HTMLElement>("aside.product-inspector")?.dataset.state,
    ).toBe("open");
    expect(activeListeners("keydown")).toBe(1);
  });
});
