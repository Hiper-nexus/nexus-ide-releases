import { describe, expect, it } from "vitest";
import { pickReusableSquad, type ReusableSquadLike } from "./squad-reuse";
import { buildSquadRuntimeCliPolicy } from "./squad-runtime-policy";

function squad(
  id: string,
  createdAt: number,
  clis: string[],
  builtin = false,
): ReusableSquadLike {
  const categories = ["orchestrator", "executor", "reviewer"] as const;
  return {
    id,
    builtin,
    createdAt: String(createdAt),
    agents: clis.map((cli, index) => ({
      cli,
      category: categories[index] ?? "reviewer",
    })),
  };
}

const routable = new Set(["claude", "kimi", "agy", "codex"]);
const verified = new Set(["claude", "codex"]);

describe("pickReusableSquad", () => {
  it("reusa o squad de usuário mais recente com roster standard roteável", () => {
    const older = squad("meu-time-antigo", 1_000, ["claude", "kimi", "kimi"]);
    const newer = squad("meu-time-novo", 2_000, ["claude", "agy", "codex"]);
    expect(pickReusableSquad([older, newer], routable, verified)?.id).toBe(
      "meu-time-novo",
    );
  });

  it("ignora squads builtin (gerenciados pelo app)", () => {
    const builtin = squad(
      "nexus-full",
      5_000,
      ["claude", "codex", "kimi"],
      true,
    );
    const user = squad("meu-time", 1_000, ["claude", "kimi", "kimi"]);
    expect(pickReusableSquad([builtin, user], routable, verified)?.id).toBe(
      "meu-time",
    );
  });

  it("ignora fallbacks agênticos auto-gerados", () => {
    const fallback = squad("agentic-fallback-1784118710650", 9_000, [
      "claude",
      "codex",
      "kimi",
    ]);
    const user = squad("meu-time", 1_000, ["claude", "kimi", "kimi"]);
    expect(pickReusableSquad([fallback, user], routable, verified)?.id).toBe(
      "meu-time",
    );
  });

  it("ignora snapshots efêmeros de missão", () => {
    const runtimeSnapshot = squad(
      "mission-runtime-54f7a204-46fc-42ef-9a9c-8714465dcb52",
      9_000,
      ["claude", "codex", "kimi"],
    );
    const user = squad("meu-time", 1_000, ["claude", "kimi", "kimi"]);

    expect(
      pickReusableSquad([runtimeSnapshot, user], routable, verified)?.id,
    ).toBe("meu-time");
    expect(
      pickReusableSquad([runtimeSnapshot], routable, verified),
    ).toBeNull();
  });

  it("ignora TODOS os squads auto-gerados: agentic-<nome> e custom-<workspace>", () => {
    const agenticLlm = squad("agentic-time-web-1784118999999", 9_000, [
      "claude",
      "codex",
      "kimi",
    ]);
    const customWs = squad("custom-nexus-ide", 8_000, [
      "claude",
      "codex",
      "kimi",
    ]);
    const user = squad("meu-time", 1_000, ["claude", "kimi", "kimi"]);
    expect(
      pickReusableSquad([agenticLlm, customWs, user], routable, verified)?.id,
    ).toBe("meu-time");
    expect(
      pickReusableSquad([agenticLlm, customWs], routable, verified),
    ).toBeNull();
  });

  it("ignora qualquer squad com CLI fora do conjunto roteável", () => {
    const withMissing = squad("time-glm", 9_000, ["claude", "glm", "kimi"]);
    const healthy = squad("meu-time", 1_000, ["claude", "kimi", "kimi"]);
    expect(
      pickReusableSquad([withMissing, healthy], routable, verified)?.id,
    ).toBe("meu-time");
  });

  it.each([
    [
      "executor",
      [
        { cli: "claude", category: "orchestrator" },
        { cli: "kimi", category: "reviewer" },
      ],
    ],
    [
      "reviewer",
      [
        { cli: "claude", category: "orchestrator" },
        { cli: "codex", category: "executor" },
      ],
    ],
    [
      "worker não-Claude",
      [
        { cli: "claude", category: "orchestrator" },
        { cli: "claude", category: "executor" },
        { cli: "claude", category: "reviewer" },
      ],
    ],
  ])("ignora squad sem %s roteável", (_label, agents) => {
    const invalid: ReusableSquadLike = {
      id: "incompleto",
      builtin: false,
      createdAt: "9000",
      agents,
    };
    expect(pickReusableSquad([invalid], routable, verified)).toBeNull();
  });

  it("ignora squad com roster vazio", () => {
    const empty = squad("vazio", 9_000, []);
    expect(pickReusableSquad([empty], routable, verified)).toBeNull();
  });

  it("ordena corretamente com createdAt ISO string", () => {
    const epochOld = squad("epoch-antigo", 1_000, ["claude", "codex", "kimi"]);
    const isoNewer: ReusableSquadLike = {
      ...squad("iso-novo", 0, ["claude", "kimi", "agy"]),
      createdAt: "2026-07-11T00:00:00.000Z",
    };
    expect(
      pickReusableSquad([epochOld, isoNewer], routable, verified)?.id,
    ).toBe("iso-novo");
    expect(
      pickReusableSquad([isoNewer, epochOld], routable, verified)?.id,
    ).toBe("iso-novo");
  });

  it("ISO antigo perde para epoch-ms recente", () => {
    const isoOld: ReusableSquadLike = {
      ...squad("iso-2001", 0, ["claude", "codex", "kimi"]),
      createdAt: "2001-01-01T00:00:00.000Z",
    };
    const epochNewer = squad("epoch-2026", 1_784_118_710_650, [
      "claude",
      "kimi",
      "agy",
    ]);
    expect(
      pickReusableSquad([isoOld, epochNewer], routable, verified)?.id,
    ).toBe("epoch-2026");
  });

  it("não reusa automaticamente squad cujo Maestro é experimental", () => {
    const experimental = squad("time-kimi", 9_000, ["kimi", "codex", "codex"]);
    const safe = squad("time-codex", 1_000, ["codex", "kimi", "agy"]);

    expect(
      pickReusableSquad([experimental, safe], routable, verified)?.id,
    ).toBe("time-codex");
    expect(pickReusableSquad([experimental], routable, verified)).toBeNull();
  });

  it("não trata o primeiro worker como Maestro em roster legado inválido", () => {
    const workerOnly: ReusableSquadLike = {
      id: "sem-maestro",
      builtin: false,
      createdAt: "9000",
      agents: [
        { cli: "codex", category: "executor" },
        { cli: "kimi", category: "reviewer" },
      ],
    };

    expect(pickReusableSquad([workerOnly], routable, verified)).toBeNull();
  });

  it("não reusa OpenCode sem sandbox nativo, mesmo com modelo free roteável", () => {
    const policy = buildSquadRuntimeCliPolicy(
      [
        {
          adapterId: "claude",
          enabled: true,
          installed: true,
          adapterLoaded: true,
          guidedHandoffCapable: true,
          autonomousWorkspaceWriteCapable: false,
          authStrategy: "subscription",
          defaultModel: "claude-sonnet",
        },
        {
          adapterId: "opencode",
          enabled: true,
          installed: true,
          adapterLoaded: true,
          guidedHandoffCapable: true,
          autonomousWorkspaceWriteCapable: false,
          authStrategy: "login-needed",
          defaultModel: "openrouter/openai/gpt-5",
          models: [
            "openrouter/openai/gpt-5",
            "opencode/big-pickle",
          ],
        },
      ],
      () => true,
    );
    const external: ReusableSquadLike = {
      id: "time-opencode-externo",
      builtin: false,
      createdAt: "9000",
      agents: [
        {
          cli: "claude",
          category: "orchestrator",
          model: "claude-sonnet",
        },
        {
          cli: "opencode",
          category: "executor",
          model: "openrouter/openai/gpt-5",
        },
        {
          cli: "opencode",
          category: "reviewer",
          model: "opencode/big-pickle",
        },
      ],
    };
    const free: ReusableSquadLike = {
      ...external,
      id: "time-opencode-free",
      createdAt: "1000",
      agents: external.agents.map((agent) =>
        agent.cli === "opencode"
          ? { ...agent, model: "opencode/big-pickle" }
          : agent,
      ),
    };

    expect(policy.routableCliIds.has("opencode")).toBe(true);
    expect(policy.routableWorkerCliIds.has("opencode")).toBe(false);
    expect(
      pickReusableSquad([external, free], policy, new Set(["claude"])),
    ).toBeNull();
    expect(
      pickReusableSquad([external], policy, new Set(["claude"])),
    ).toBeNull();
  });
});
