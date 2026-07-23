import { describe, expect, it } from "vitest";
import type { Mission, Squad } from "../../shared/orch-types";
import type { PaneModel } from "../../shared/types";
import {
  PANE_SKILL_DRAG_TYPE,
  buildHandoffRequestPrompt,
  buildSkillInvocationPrompt,
  buildWorktreePlanningPrompt,
  parseSkillDragPayload,
  resolveSkillDropPolicy,
  serializeSkillDragPayload,
} from "./pane-interactions";

const workerPane: PaneModel = {
  id: "pane-worker",
  kind: "cli-agent",
  title: "Reviewer",
  role: "worker",
  agentName: "Reviewer",
  missionId: "mission-1",
};

const mission: Mission = {
  id: "mission-1",
  title: "Ship",
  description: "Ship safely",
  status: "running",
  squadId: "squad-1",
  milestones: [],
  learnings: "",
  createdAt: 1,
  updatedAt: 1,
};

function squad(allowedSkills: string[] | null): Squad {
  return {
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
        allowedSkills,
      },
    ],
  };
}

describe("pane interaction contracts", () => {
  it("round-trips a bounded Nexus-only skill drag payload", () => {
    const encoded = serializeSkillDragPayload({
      id: "skill-code-review",
      name: "code-review",
    });

    expect(PANE_SKILL_DRAG_TYPE).toBe("application/x-nexus-skill+json");
    expect(parseSkillDragPayload(encoded)).toEqual({
      version: 1,
      id: "skill-code-review",
      name: "code-review",
    });
    expect(
      parseSkillDragPayload('{"version":1,"name":"x\\nrm -rf /"}'),
    ).toBeNull();
    expect(parseSkillDragPayload("not-json")).toBeNull();
  });

  it("fails closed against the visible mission roster and honors explicit allowlists", () => {
    expect(
      resolveSkillDropPolicy({
        pane: workerPane,
        skillName: "code-review",
        missions: [mission],
        squads: [squad(["code-review"])],
      }),
    ).toEqual({ allowed: true });

    expect(
      resolveSkillDropPolicy({
        pane: workerPane,
        skillName: "security-best-practices",
        missions: [mission],
        squads: [squad(["code-review"])],
      }),
    ).toEqual({
      allowed: false,
      reason: "A skill não pertence à allowlist deste agente.",
    });

    expect(
      resolveSkillDropPolicy({
        pane: workerPane,
        skillName: "code-review",
        missions: [],
        squads: [],
      }),
    ).toEqual({
      allowed: false,
      reason: "O roster autorizado da missão ainda não está disponível.",
    });
  });

  it("never turns a skill drop into a shell command or grants new authority", () => {
    const shell: PaneModel = {
      id: "shell-1",
      kind: "shell",
      title: "Shell",
    };
    expect(
      resolveSkillDropPolicy({
        pane: shell,
        skillName: "code-review",
        missions: [],
        squads: [],
      }),
    ).toEqual({
      allowed: false,
      reason: "Skills só podem ser enviadas a panes de agente.",
    });

    const prompt = buildSkillInvocationPrompt("code-review");
    expect(prompt).toContain("skill `code-review`");
    expect(prompt).toContain("não amplia");
    expect(prompt).not.toContain("rm -rf");
  });

  it("routes handoff and worktree through durable mission authority", () => {
    const handoff = buildHandoffRequestPrompt(workerPane);
    expect(handoff).toContain("nexus_handoff_submit");
    expect(handoff).toContain("missão mission-1");
    expect(handoff).not.toContain("nexus_pane_write");

    const worktree = buildWorktreePlanningPrompt(workerPane);
    expect(worktree).toContain("nexus_task plan");
    expect(worktree).toContain("isolated_worktree");
    expect(worktree).toContain("dispatcher main");
    expect(worktree).not.toMatch(/\bgit\s+worktree\s+add\b/);
  });
});
