import { describe, expect, it } from "vitest";
import type { SquadAgent } from "../../shared/orch-types";
import { balanceSquadRosterCli, workerCliPool } from "./squad-roster";

function adapter(
  id: string,
  installed = true,
  enabled = true,
  autonomousWorkspaceWriteCapable = id === "codex",
) {
  return {
    id,
    installed,
    enabled,
    autonomousWorkspaceWriteCapable,
  };
}

function agent(
  id: string,
  category: SquadAgent["category"],
  cli = "claude",
  model = `${cli}-model`,
): SquadAgent {
  return {
    id,
    agentName: id,
    category,
    cli,
    model,
    effort: "medium",
    allowedTools: [],
  };
}

describe("workerCliPool", () => {
  it("uses only enabled installed workers with a qualified workspace-write sandbox", () => {
    expect(
      workerCliPool([
        adapter("claude"),
        adapter("kimi"),
        adapter("codex"),
        adapter("agy", true, false),
        adapter("grok", false),
      ]),
    ).toEqual(["codex"]);
  });

  it("never invents an uninstalled worker fallback", () => {
    expect(
      workerCliPool([
        adapter("claude"),
        adapter("codex", false),
        adapter("agy", false),
      ]),
    ).toEqual([]);
  });

  it("treats an absent qualification as unsafe across rolling renderer/main versions", () => {
    expect(
      workerCliPool([
        {
          id: "codex",
          installed: true,
          enabled: true,
        },
        adapter("agy", true, true, false),
      ]),
    ).toEqual([]);
  });
});

describe("balanceSquadRosterCli", () => {
  it("keeps the Maestro on Claude and retargets every worker identity to safe Codex", () => {
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "codex"),
        agent("search", "scout"),
        agent("code", "executor"),
        agent("architect", "architect"),
        agent("qa", "reviewer"),
      ],
      [adapter("claude"), adapter("codex"), adapter("agy"), adapter("grok")],
    );

    expect(balanced.map((item) => item.cli)).toEqual([
      "claude",
      "codex",
      "codex",
      "codex",
      "codex",
    ]);
    expect(balanced[0].model).toBeUndefined();
    expect(balanced.slice(1).map((item) => item.model)).toEqual(
      Array.from({ length: 4 }, () => undefined),
    );
  });

  it("allows the configured non-Claude Maestro CLI to execute worker tasks too", () => {
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "codex", "gpt-5.4"),
        agent("worker", "executor", "claude"),
      ],
      [adapter("claude"), adapter("codex"), adapter("agy")],
      "codex",
    );

    expect(balanced[0]).toMatchObject({
      cli: "codex",
      model: "gpt-5.4",
    });
    expect(balanced[1].cli).toBe("codex");
  });

  it("preserves a worker model when the selected CLI does not change", () => {
    const [balanced] = balanceSquadRosterCli(
      [agent("frontend", "executor", "codex", "gpt-5.5")],
      [adapter("codex")],
    );

    expect(balanced.cli).toBe("codex");
    expect(balanced.model).toBe("gpt-5.5");
  });

  it("uses the original worker CLI when no alternative exists", () => {
    const [balanced] = balanceSquadRosterCli(
      [agent("only", "executor", "claude", "claude-sonnet-5")],
      [adapter("claude")],
    );

    expect(balanced.cli).toBe("claude");
    expect(balanced.model).toBe("claude-sonnet-5");
  });
});
