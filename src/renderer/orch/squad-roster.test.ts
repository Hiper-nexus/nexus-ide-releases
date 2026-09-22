import { describe, expect, it } from "vitest";
import type { SquadAgent } from "../../shared/orch-types";
import { balanceSquadRosterCli, workerCliPool } from "./squad-roster";
function adapter(
  id: string,
  installed = true,
  enabled = true,
  autonomousWorkspaceWriteCapable = id === "codex",
  taskHandoffCapable = true,
) {
  return {
    id,
    installed,
    enabled,
    autonomousWorkspaceWriteCapable,
    taskHandoffCapable,
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
  it("uses only enabled installed workers with a qualified workspace-write sandbox in Hardened", () => {
    expect(
      workerCliPool(
        [
          adapter("claude"),
          adapter("kimi"),
          adapter("codex"),
          adapter("agy", true, false),
          adapter("grok", false),
        ],
        "governed",
      ),
    ).toEqual(["codex"]);
  });

  it("never invents an uninstalled worker fallback in Hardened", () => {
    expect(
      workerCliPool(
        [
          adapter("claude"),
          adapter("codex", false),
          adapter("agy", false),
        ],
        "governed",
      ),
    ).toEqual([]);
  });

  it("treats an absent qualification as unsafe in Hardened across rolling versions", () => {
    expect(
      workerCliPool(
        [
          {
            id: "codex",
            installed: true,
            enabled: true,
          },
          adapter("agy", true, true, false),
        ],
        "governed",
      ),
    ).toEqual([]);
  });

  it("uses every handoff-capable CLI in operator-choice without requiring a governed writer brand", () => {
    expect(
      workerCliPool(
        [
          adapter("kimi", true, true, false, true),
          adapter("custom-cli", true, true, false, true),
          adapter("codex", true, true, true, false),
        ],
        "operator-choice",
      ),
    ).toEqual(["kimi", "custom-cli"]);
  });

  it("defaults the pool to Autopilot (handoff-capable), not Hardened writers", () => {
    expect(
      workerCliPool([
        adapter("claude"),
        adapter("kimi"),
        adapter("codex"),
      ]),
    ).toEqual(["codex", "kimi", "claude"]);
  });

  it("prioritizes reliable handoff CLIs (codex, glm) over kimi and deepseek in worker pool", () => {
    expect(
      workerCliPool([
        adapter("kimi"),
        adapter("glm"),
        adapter("deepseek"),
        adapter("codex"),
      ]),
    ).toEqual(["codex", "glm", "kimi", "deepseek"]);
  });
});

describe("balanceSquadRosterCli", () => {
  it("preserves an installed Maestro CLI and advisory-lane reviewer/scout workers", () => {
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "codex"),
        agent("search", "scout"),
        agent("code", "executor"),
        agent("architect", "architect"),
        agent("qa", "reviewer"),
      ],
      [adapter("claude"), adapter("codex"), adapter("agy"), adapter("grok")],
      "codex",
      { squadCliPolicy: "governed" },
    );

    // Never rewrite a sealed/reviewed Maestro (e.g. release-gate codex) to the
    // legacy Claude default just because Claude is also installed. Reviewer e
    // scout na advisory lane (Fases 0/1) são preservados; executor/architect
    // sem escrita confinada seguem retargetados para Codex.
    expect(balanced.map((item) => item.cli)).toEqual([
      "codex",
      "claude",
      "codex",
      "codex",
      "claude",
    ]);
    expect(balanced[0].model).toBe("codex-model");
    expect(balanced[1].model).toBe("claude-model");
    expect(balanced[4].model).toBe("claude-model");
    expect([balanced[2].model, balanced[3].model]).toEqual([
      "gpt-6-sol",
      "gpt-6-sol",
    ]);
  });

  it("preserves advisory reviewer/scout workers on MCP-only CLIs", () => {
    const grokAdapter = {
      ...adapter("grok"),
      capabilities: { autonomousReadOnly: true },
    };
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "codex"),
        agent("e2e-advisor-kimi", "scout", "kimi"),
        agent("e2e-advisor-grok", "reviewer", "grok"),
        agent("e2e-executor", "executor", "codex"),
      ],
      [
        adapter("codex"),
        adapter("kimi"),
        grokAdapter,
        adapter("agy"),
      ],
    );

    // Advisors read_only (rota Nexus MCP) e read-only mecânico (grok Seatbelt)
    // não são reescritos para Codex.
    expect(balanced.map((item) => item.cli)).toEqual([
      "codex",
      "kimi",
      "grok",
      "codex",
    ]);
  });

  it("preserves sealed advisor CLIs even when detection is false", () => {
    // Root cause of product-wizard observer-invalid with heavy advisor skips:
    // advisory CLIs momentarily undetected → silent rewrite → binding null.
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "codex"),
        agent("e2e-advisor-kimi", "scout", "kimi"),
        agent("e2e-advisor-grok", "reviewer", "grok"),
        agent("e2e-executor", "executor", "codex"),
      ],
      [adapter("codex")],
    );

    expect(balanced.map((item) => item.cli)).toEqual([
      "codex",
      "kimi",
      "grok",
      "codex",
    ]);
  });

  it("preserves every CLI when preserveExactCliAssignments is set", () => {
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "codex"),
        agent("e2e-advisor-kimi", "scout", "kimi"),
        agent("e2e-executor", "executor", "claude"),
      ],
      [adapter("codex")],
      "codex",
      { preserveExactCliAssignments: true },
    );

    expect(balanced.map((item) => item.cli)).toEqual([
      "codex",
      "kimi",
      "claude",
    ]);
  });

  it("rewrites a claude advisor to Codex when the roster orchestrator is Claude", () => {
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "claude"),
        agent("e2e-advisor-claude", "reviewer", "claude"),
      ],
      [adapter("claude"), adapter("codex")],
      "claude",
      { squadCliPolicy: "governed" },
    );

    // reserveClaude: com orquestrador Claude, nenhum worker Claude é preservado.
    expect(balanced.map((item) => item.cli)).toEqual(["claude", "codex"]);
  });

  it("fills an empty Maestro from the automatic verified route", () => {
    const balanced = balanceSquadRosterCli(
      [agent("orch", "orchestrator", "", "")],
      [adapter("claude"), adapter("codex")],
      "codex",
    );
    expect(balanced[0]).toMatchObject({ cli: "codex" });
  });

  it("allows the configured non-Claude Maestro CLI to execute worker tasks too", () => {
    const balanced = balanceSquadRosterCli(
      [
        agent("orch", "orchestrator", "codex", "gpt-5.4"),
        agent("worker", "executor", "claude"),
      ],
      [adapter("claude"), adapter("codex"), adapter("agy")],
      "codex",
      { squadCliPolicy: "governed" },
    );

    expect(balanced[0]).toMatchObject({
      cli: "codex",
      model: "gpt-5.6-luna",
    });
    expect(balanced[1].cli).toBe("codex");
  });

  it("migrates a retired worker model when the selected CLI does not change", () => {
    const [balanced] = balanceSquadRosterCli(
      [agent("frontend", "executor", "codex", "gpt-5.5")],
      [adapter("codex")],
    );

    expect(balanced.cli).toBe("codex");
    expect(balanced.model).toBe("gpt-5.6-luna");
  });

  it("uses the original worker CLI when no alternative exists", () => {
    const [balanced] = balanceSquadRosterCli(
      [agent("only", "executor", "claude", "claude-sonnet-5")],
      [adapter("claude")],
    );

    expect(balanced.cli).toBe("claude");
    expect(balanced.model).toBe("claude-sonnet-5");
  });

  it("preserves a Kimi executor selected by the operator", () => {
    const balanced = balanceSquadRosterCli(
      [
        agent("maestro", "orchestrator", "custom-cli"),
        agent("executor", "executor", "kimi"),
      ],
      [
        adapter("custom-cli", true, true, false, true),
        adapter("kimi", true, true, false, true),
      ],
      "custom-cli",
      { squadCliPolicy: "operator-choice" },
    );

    expect(balanced.map((item) => item.cli)).toEqual([
      "custom-cli",
      "kimi",
    ]);
  });
});
