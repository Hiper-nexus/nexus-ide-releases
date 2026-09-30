/** @vitest-environment jsdom */
import { WorkspaceInertContext } from "../state/access-store";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneModel } from "../../shared/types";
import { useContextualPanelNavStore } from "../state/contextual-panel-nav-store";
import { useOrchStore } from "../state/orch-store";
import { useProductNavigationStore } from "../state/product-navigation-store";
import { useToastStore } from "../state/toast-store";
import { PaneContextMenu } from "./PaneContextMenu";

const { submitLivePanePrompt } = vi.hoisted(() => ({
  submitLivePanePrompt: vi.fn<
    (
      pane: { readonly id: string },
      prompt: string,
    ) => Promise<boolean>
  >(async () => true),
}));

const { getPaneSessionId, getScrollbackExcerpt } = vi.hoisted(() => ({
  getPaneSessionId: vi.fn<(paneId: string) => string | null>(
    () => "session-worker",
  ),
  getScrollbackExcerpt: vi.fn<(paneId: string, max?: number) => string>(
    () => "resultado validado\nok",
  ),
}));

vi.mock("../terminal/submit-live-pane-prompt", () => ({
  submitLivePanePrompt,
}));

vi.mock("../terminal/terminal-host", () => ({
  getPaneSessionId,
  getScrollbackExcerpt,
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

function mount(blocked = false): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <WorkspaceInertContext.Provider value={blocked}><PaneContextMenu
        pane={pane}
        point={{ x: 24, y: 36 }}
        onClose={vi.fn()}
      /></WorkspaceInertContext.Provider>,
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
    useProductNavigationStore.setState({
      destination: { kind: "terminal" },
      settingsReturnDestination: null,
    });
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
    });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("asks the worker to submit a real handoff instead of fabricating one", async () => {
    const { root } = mount();
    await act(async () => button("Solicitar handoff").click());

    expect(submitLivePanePrompt).toHaveBeenCalledTimes(1);
    expect(submitLivePanePrompt.mock.calls[0]?.[0]).toMatchObject({
      id: "pane-worker",
      kind: "cli-agent",
      missionId: "mission-1",
    });
    expect(submitLivePanePrompt.mock.calls[0]?.[1]).toContain(
      "nexus_handoff_submit",
    );
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      "Handoff solicitado",
    ]);
    act(() => root.unmount());
  });

  it("does not toast success when the operator lane refuses the handoff", async () => {
    submitLivePanePrompt.mockResolvedValueOnce(false);
    const { root } = mount();
    await act(async () => button("Solicitar handoff").click());

    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      "Handoff não solicitado",
    ]);
    act(() => root.unmount());
  });

  it("does not toast success when the operator lane throws", async () => {
    submitLivePanePrompt.mockRejectedValueOnce(new Error("lane down"));
    const { root } = mount();
    await act(async () => button("Solicitar handoff").click());

    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      "Handoff não solicitado",
    ]);
    act(() => root.unmount());
  });

  it("plans worktree and opens its canonical mission board without running git", async () => {
    const { root } = mount();
    try {
      const worktree = button("Planejar worktree");
      expect(worktree.textContent).toContain("Cole no orquestrador");
      expect(worktree.textContent).not.toContain("cria o checkout");

      await act(async () => worktree.click());

      const clipboard = vi.mocked(navigator.clipboard.writeText);
      expect(clipboard).toHaveBeenCalledWith(
        expect.stringContaining("nexus_task plan"),
      );
      expect(clipboard.mock.calls[0]?.[0]).not.toMatch(
        /\bgit\s+worktree\s+add\b/,
      );
      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: "mission",
        missionId: "mission-1",
        surface: "board",
      });
      expect(submitLivePanePrompt).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
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

it('keeps an already-open context menu inert when license access is blocked', () => {
  const { root } = mount(true);
  expect(document.querySelector('[role="menu"]')?.closest('[inert]')).not.toBeNull();
  act(() => root.unmount());
});
