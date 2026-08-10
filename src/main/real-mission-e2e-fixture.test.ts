import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { Squad } from "../shared/orch-types";
import {
  createRealMissionE2ESquadFixture,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../shared/real-mission-e2e";
import {
  prepareSquadSave as prepareProductionSquadSave,
  type PreparedSquadSave,
} from "./orch/squad-store";
import { snapshotSquadAuthority } from "./orch/squad-authority-snapshot";
import {
  isExactRealMissionE2ESquadFixture,
  persistRealMissionE2ESquadFixture,
  resolveCanonicalRealMissionE2ESquadBinding,
} from "./real-mission-e2e-fixture";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureHarness(options?: {
  mutatePersisted?: (squad: Squad) => Squad;
}) {
  let persisted: Squad | null = null;
  const prepareSquadSave = vi.fn((raw: unknown): PreparedSquadSave => {
    const squad = structuredClone(raw) as Squad;
    const canonicalJson = JSON.stringify(squad);
    return {
      squad,
      snapshot: snapshotSquadAuthority(squad),
      canonicalJson,
      canonicalSha256: sha256(canonicalJson),
      expectedTarget: {
        id: squad.id,
        exists: false,
        canonicalSha256: null,
      },
    };
  });
  const applyPreparedSquadSave = vi.fn((candidate: PreparedSquadSave) => {
    const exact = structuredClone(candidate.squad);
    persisted = options?.mutatePersisted?.(exact) ?? exact;
    return exact;
  });
  const getSquad = vi.fn((id: string) =>
    persisted?.id === id ? structuredClone(persisted) : null,
  );

  return {
    deps: {
      prepareSquadSave,
      applyPreparedSquadSave,
      getSquad,
    },
    prepareSquadSave,
    applyPreparedSquadSave,
    getSquad,
  };
}

describe("main-owned real mission squad fixture", () => {
  it("is already in the production schema canonical property order", () => {
    const compiled = createRealMissionE2ESquadFixture();
    const prepared = prepareProductionSquadSave(compiled);

    expect(JSON.stringify(prepared.squad)).toBe(JSON.stringify(compiled));
    expect(isExactRealMissionE2ESquadFixture(prepared.squad)).toBe(true);
  });

  it("persists the compiled fixture and accepts only an exact hash-bound reread", () => {
    const harness = fixtureHarness();

    const persisted = persistRealMissionE2ESquadFixture(harness.deps);

    expect(persisted.id).toBe(REAL_MISSION_E2E_SQUAD_ID);
    expect(harness.prepareSquadSave).toHaveBeenCalledOnce();
    expect(harness.applyPreparedSquadSave).toHaveBeenCalledOnce();
    expect(harness.getSquad).toHaveBeenCalledExactlyOnceWith(
      REAL_MISSION_E2E_SQUAD_ID,
    );
    expect(persisted.agents).toEqual([
      expect.objectContaining({
        id: "e2e-orchestrator",
        category: "orchestrator",
        allowedTools: null,
      }),
      expect.objectContaining({
        id: "e2e-executor",
        category: "executor",
        allowedTools: [],
      }),
      expect.objectContaining({
        id: "e2e-reviewer",
        category: "reviewer",
        allowedTools: [],
      }),
      expect.objectContaining({
        id: "e2e-qa",
        category: "reviewer",
        allowedTools: [],
      }),
      // Fixture 0.28.0: e2e-advisor-grok removed (stall undiagnosable — 9dff542a).
      expect.objectContaining({
        id: "e2e-advisor-kimi",
        category: "scout",
        cli: "kimi",
        allowedTools: [],
      }),
      expect.objectContaining({
        id: "e2e-advisor-agy",
        category: "scout",
        cli: "agy",
        allowedTools: [],
      }),
      expect.objectContaining({
        id: "e2e-advisor-opencode",
        category: "scout",
        cli: "opencode",
        allowedTools: [],
      }),
      expect.objectContaining({
        id: "e2e-advisor-claude",
        category: "scout",
        cli: "claude",
        allowedTools: [],
      }),
      expect.objectContaining({
        id: "e2e-advisor-glm",
        category: "scout",
        cli: "glm",
        allowedTools: [],
      }),
    ]);
  });

  it("persists the claude-orchestrator variant roster from the sealed env", () => {
    vi.stubEnv("NEXUS_REAL_MISSION_ORCHESTRATOR", "claude");
    try {
      const harness = fixtureHarness();

      const persisted = persistRealMissionE2ESquadFixture(harness.deps);

      expect(persisted.agents[0]).toMatchObject({
        id: "e2e-orchestrator",
        category: "orchestrator",
        cli: "claude",
        allowedTools: null,
      });
      // reserveClaude: nenhuma advisor claude no roster da variante.
      expect(
        persisted.agents.some((agent) => agent.id === "e2e-advisor-claude"),
      ).toBe(false);
      expect(
        persisted.agents
          .filter((agent) =>
            ["e2e-executor", "e2e-reviewer", "e2e-qa"].includes(agent.id),
          )
          .every((agent) => agent.cli === "codex"),
      ).toBe(true);
      expect(isExactRealMissionE2ESquadFixture(persisted)).toBe(true);
      // O roster da variante codex não é aceito sob a env claude.
      expect(
        isExactRealMissionE2ESquadFixture(createRealMissionE2ESquadFixture()),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when the persisted reread drifts from the compiled fixture", () => {
    const harness = fixtureHarness({
      mutatePersisted: (squad) => ({
        ...squad,
        agents: squad.agents.map((agent) =>
          agent.id === "e2e-reviewer"
            ? { ...agent, allowedTools: null }
            : agent,
        ),
      }),
    });

    expect(() => persistRealMissionE2ESquadFixture(harness.deps)).toThrow(
      /fixture.*reread|reread.*fixture/i,
    );
  });

  it("fails closed when persistence does not make the fixture readable", () => {
    const harness = fixtureHarness();
    harness.getSquad.mockReturnValueOnce(null);

    expect(() => persistRealMissionE2ESquadFixture(harness.deps)).toThrow(
      /fixture.*reread|reread.*fixture/i,
    );
  });

  it("rejects later drift from the exact authority fixture", () => {
    const harness = fixtureHarness();
    const persisted = persistRealMissionE2ESquadFixture(harness.deps);

    expect(isExactRealMissionE2ESquadFixture(persisted)).toBe(true);
    expect(
      isExactRealMissionE2ESquadFixture({
        ...persisted,
        createdAt: "forged-revision",
      }),
    ).toBe(false);
    expect(
      isExactRealMissionE2ESquadFixture({
        ...persisted,
        orchestratorInstructions: `${persisted.orchestratorInstructions}\nforged`,
      }),
    ).toBe(false);
  });



  it("binds canonical prepare to its actual ephemeral source and exact fixture authority", () => {
    const fixture = createRealMissionE2ESquadFixture();
    const title = "Release gate: missão real empacotada";
    const sourceId =
      "custom-mission-setup-11111111-1111-4111-8111-111111111111";
    const ephemeralSource: Squad = {
      id: sourceId,
      name: `Equipe — ${title}`,
      createdAt: "ignored-by-authority-snapshot",
      builtin: false,
      orchestratorInstructions: [
        "# Missão aprovada no Nexus",
        "Coordene somente o objetivo e os limites persistidos no contrato da missão.",
        "Delegue pelos papéis da equipe e exija evidência antes de concluir.",
        "",
        REAL_MISSION_E2E_GOAL,
      ].join("\n"),
      agents: fixture.agents.map((agent) => ({ ...agent })),
    };
    const runtime: Squad = {
      ...ephemeralSource,
      id: "agentic-runtime-22222222-2222-4222-8222-222222222222",
      createdAt: "runtime",
      runtimeSourceSquadId: sourceId,
      runtimeSourceSquadRevisionHash:
        snapshotSquadAuthority(ephemeralSource).hash,
    };
    const lookup = (id: string) =>
      id === fixture.id ? fixture : id === runtime.id ? runtime : null;

    expect(
      resolveCanonicalRealMissionE2ESquadBinding(
        {
          squadId: runtime.id,
          title,
          objective: REAL_MISSION_E2E_GOAL,
        },
        lookup,
      ),
    ).toEqual({
      squadId: runtime.id,
      fixtureSquadId: fixture.id,
      fixtureSquadRevisionHash: snapshotSquadAuthority(fixture).hash,
      sourceSquadId: sourceId,
      sourceSquadRevisionHash: snapshotSquadAuthority(ephemeralSource).hash,
      squadRevisionHash: snapshotSquadAuthority(runtime).hash,
    });

    expect(
      resolveCanonicalRealMissionE2ESquadBinding(
        {
          squadId: runtime.id,
          title,
          objective: `${REAL_MISSION_E2E_GOAL} forged`,
        },
        lookup,
      ),
    ).toBeNull();
    expect(
      resolveCanonicalRealMissionE2ESquadBinding(
        {
          squadId: runtime.id,
          title,
          objective: REAL_MISSION_E2E_GOAL,
        },
        (id) =>
          id === fixture.id
            ? fixture
            : {
                ...runtime,
                agents: runtime.agents.map((agent, index) =>
                  index === 1 ? { ...agent, model: "forged-model" } : agent,
                ),
              },
      ),
    ).toBeNull();
    expect(
      resolveCanonicalRealMissionE2ESquadBinding(
        {
          squadId: runtime.id,
          title,
          objective: REAL_MISSION_E2E_GOAL,
        },
        (id) =>
          id === fixture.id
            ? fixture
            : {
                ...runtime,
                runtimeSourceSquadRevisionHash: "f".repeat(64),
              },
      ),
    ).toBeNull();
  });
});
