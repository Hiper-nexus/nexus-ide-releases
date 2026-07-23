/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneModel } from "../../shared/types";
import { useContextualPanelNavStore } from "../state/contextual-panel-nav-store";
import { useOrchStore } from "../state/orch-store";
import { PaneContextMenu } from "./PaneContextMenu";

const { submitPromptToPane, getPaneSessionId, getScrollbackExcerpt } =
  vi.hoisted(() => ({
    submitPromptToPane: vi.fn<(paneId: string, prompt: string) => boolean>(
      () => true,
    ),
    getPaneSessionId: vi.fn<(paneId: string) => string | null>(
      () => "session-worker",
    ),
    getScrollbackExcerpt: vi.fn<(paneId: string, max?: number) => string>(
      () => "resultado validado\nok",
    ),
  }));

vi.mock("../terminal/terminal-host", () => ({
  getPaneSessionId,
  getScrollbackExcerpt,
  submitPromptToPane,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const pane: PaneModel = {
  id: "pane-worker",
  kind: "cli-agent",
  title: "Reviewer",
  role: "worker",
  agentName: "Reviewer",
  missionId: "mission-1",
};

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <PaneContextMenu
        pane={pane}
        point={{ x: 24, y: 36 }}
        onClose={vi.fn()}
      />,
    );
  });
  return { host, root };
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

describe("PaneContextMenu authority routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    useContextualPanelNavStore.setState({ requestedTab: null, requestId: 0 });
    useOrchStore.setState({
      missions: [
        {
          id: "mission-1",
          title: "Ship",
          description: "Ship safely",
          status: "running",
          squadId: "squad-1",
          milestones: [],
          learnings: "",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      panelOpen: false,
      panelTab: "missions",
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("asks the worker to submit a real handoff instead of fabricating one", () => {
    const { root } = mount();
    act(() => button("Solicitar handoff").click());

    expect(submitPromptToPane).toHaveBeenCalledTimes(1);
    expect(submitPromptToPane.mock.calls[0]?.[0]).toBe("pane-worker");
    expect(submitPromptToPane.mock.calls[0]?.[1]).toContain(
      "nexus_handoff_submit",
    );
    act(() => root.unmount());
  });

  it("plans worktree through the mission dispatcher without running git", async () => {
    const { root } = mount();
    await act(async () => button("Planejar worktree").click());

    const clipboard = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    expect(clipboard).toHaveBeenCalledWith(
      expect.stringContaining("nexus_task plan"),
    );
    expect(clipboard.mock.calls[0]?.[0]).not.toMatch(
      /\bgit\s+worktree\s+add\b/,
    );
    expect(useOrchStore.getState()).toMatchObject({
      panelOpen: true,
      panelTab: "missions",
    });
    expect(submitPromptToPane).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("opens Git through the contextual panel and copies bounded pane output", async () => {
    const first = mount();
    act(() => button("Abrir painel Git").click());
    expect(useContextualPanelNavStore.getState().requestedTab).toBe("git");
    act(() => first.root.unmount());

    const second = mount();
    await act(async () => button("Copiar saída").click());
    expect(getScrollbackExcerpt).toHaveBeenCalledWith("pane-worker", 12_000);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "resultado validado\nok",
    );
    act(() => second.root.unmount());
  });

  it("moves focus through menu items with arrow keys", () => {
    const { root } = mount();
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);
    act(() => root.unmount());
  });
});
