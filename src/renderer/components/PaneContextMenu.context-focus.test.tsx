/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneModel } from "../../shared/types";
import {
  DEFAULT_CONTEXTUAL_PANEL,
  type ContextualPanelState,
} from "../../shared/contextual-panel";
import { useContextualPanelNavStore } from "../state/contextual-panel-nav-store";
import { useOrchStore } from "../state/orch-store";
import {
  ContextualPanel,
  type ContextualPanelFocusTarget,
} from "./ContextualPanel";
import { PaneContextMenu } from "./PaneContextMenu";

const terminalHost = vi.hoisted(() => ({
  getPaneSessionId: vi.fn(() => "session-worker"),
  getScrollbackExcerpt: vi.fn(() => ""),
}));

vi.mock("../terminal/terminal-host", () => terminalHost);
vi.mock("../terminal/submit-live-pane-prompt", () => ({
  submitLivePanePrompt: vi.fn(async () => true),
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

function Harness() {
  const [menuOpen, setMenuOpen] = useState(true);
  const [panelState, setPanelState] = useState<ContextualPanelState>(
    DEFAULT_CONTEXTUAL_PANEL,
  );
  const [focusTarget, setFocusTarget] =
    useState<ContextualPanelFocusTarget | null>(null);
  const panel = (
    <ContextualPanel
      key="contextual-panel"
      storage={null}
      initial={panelState}
      placement={panelState.visible ? "inspector" : "header"}
      focusTarget={focusTarget}
      onFocusTargetChange={setFocusTarget}
      onStateChange={setPanelState}
      relevantTabs={["mission", "git"]}
      children={{
        mission: <span>Missão</span>,
        git: <span>Alterações Git</span>,
      }}
    />
  );

  return (
    <>
      {menuOpen ? (
        <PaneContextMenu
          pane={pane}
          point={{ x: 24, y: 36 }}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      <header data-panel-slot="header">
        {!panelState.visible ? panel : null}
      </header>
      <aside data-panel-slot="inspector">
        {panelState.visible ? panel : null}
      </aside>
    </>
  );
}

describe("PaneContextMenu contextual focus handoff", () => {
  let root: Root;

  beforeEach(() => {
    useContextualPanelNavStore.setState({
      requestedTab: null,
      requestId: 0,
      focusRequested: false,
    } as never);
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
    } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("focuses Git after keyboard activation and does not replay the request on hide", () => {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    const gitAction = document.activeElement as HTMLButtonElement;
    expect(gitAction.textContent).toContain("Abrir painel Git");

    act(() => gitAction.click());

    const selectedGitTab = document.querySelector<HTMLButtonElement>(
      '[data-panel-slot="inspector"] [role="tab"][aria-selected="true"]',
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(selectedGitTab?.textContent).toBe("Git");
    expect(document.activeElement).toBe(selectedGitTab);

    const hide = document.querySelector<HTMLButtonElement>(
      '[aria-label="Ocultar painel"]',
    );
    act(() => {
      hide?.focus();
      hide?.click();
    });

    const show = document.querySelector<HTMLButtonElement>(
      '[data-panel-slot="header"] [aria-label="Abrir painel de contexto"]',
    );
    expect(
      document.querySelector('[data-panel-slot="inspector"] .ctx-panel'),
    ).toBeNull();
    expect(show).not.toBeNull();
    expect(document.activeElement).toBe(show);
  });
});
