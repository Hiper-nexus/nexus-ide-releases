/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneModel } from "../../shared/types";
import {
  PANE_SKILL_DRAG_TYPE,
  serializeSkillDragPayload,
} from "../lib/pane-interactions";
import { useOrchStore } from "../state/orch-store";
import { PaneInteractionSurface } from "./PaneInteractionSurface";

const { getPaneSessionId, submitLivePanePrompt } = vi.hoisted(() => ({
  getPaneSessionId: vi.fn<(paneId: string) => string | null>(
    () => "session-worker",
  ),
  submitLivePanePrompt: vi.fn<
    (pane: { readonly id: string }, prompt: string) => Promise<boolean>
  >(async () => true),
}));

vi.mock("../terminal/terminal-host", () => ({
  getPaneSessionId,
  getScrollbackExcerpt: vi.fn(() => ""),
}));

vi.mock("../terminal/submit-live-pane-prompt", () => ({
  submitLivePanePrompt,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workerPane: PaneModel = {
  id: "pane-worker",
  kind: "cli-agent",
  title: "Reviewer",
  role: "worker",
  agentName: "Reviewer",
  missionId: "mission-1",
};

function mount(element: ReactElement): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

function dropSkill(target: Element, name = "code-review") {
  const transfer = {
    types: [PANE_SKILL_DRAG_TYPE],
    dropEffect: "none",
    getData: vi.fn(() =>
      serializeSkillDragPayload({ id: `skill-${name}`, name }),
    ),
  };
  for (const type of ["dragenter", "drop"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    act(() => target.dispatchEvent(event));
  }
}

describe("PaneInteractionSurface skill drop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      squads: [
        {
          id: "squad-1",
          name: "Safe squad",
          createdAt: "1",
          builtin: false,
          orchestratorInstructions: "",
          agents: [
            {
              id: "reviewer",
              agentName: "Reviewer",
              category: "reviewer",
              cli: "codex",
              allowedSkills: ["code-review"],
            },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("submits a bounded skill request to an allowed live agent", async () => {
    const { host, root } = mount(
      <PaneInteractionSurface pane={workerPane} className="pane">
        <span>terminal</span>
      </PaneInteractionSurface>,
    );

    dropSkill(host.firstElementChild!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getPaneSessionId).toHaveBeenCalledWith("pane-worker");
    expect(submitLivePanePrompt).toHaveBeenCalledWith(
      workerPane,
      expect.stringContaining("skill `code-review`"),
    );
    act(() => root.unmount());
  });

  it("does not write to PTY when the roster denies the skill", () => {
    useOrchStore.setState((state) => ({
      squads: state.squads.map((squad) => ({
        ...squad,
        agents: squad.agents.map((agent) => ({
          ...agent,
          allowedSkills: [],
        })),
      })),
    }));
    const { host, root } = mount(
      <PaneInteractionSurface pane={workerPane} className="pane">
        <span>terminal</span>
      </PaneInteractionSurface>,
    );

    dropSkill(host.firstElementChild!);

    expect(getPaneSessionId).not.toHaveBeenCalled();
    expect(submitLivePanePrompt).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
