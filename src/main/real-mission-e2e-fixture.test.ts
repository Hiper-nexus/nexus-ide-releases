import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { Squad } from "../shared/orch-types";
import {
  createRealMissionE2ESquadFixture,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../shared/real-mission-e2e";
import { retargetSquadInstructions } from "../shared/mission-identity";
import {
  prepareSquadSave as prepareProductionSquadSave,
  type PreparedSquadSave,
} from "./orch/squad-store";
import { snapshotSquadAuthority } from "./orch/squad-authority-snapshot";
import {
  isExactRealMissionE2ESquadFixture,
  persistRealMissionE2ESquadFixture,
  resolveProductWizardRealMissionE2ESquadBinding,
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
      expect.objectContaining({
        id: "e2e-advisor-grok",
        category: "scout",
        cli: "grok",
        allowedTools: [],
      }),
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

  it("binds only an exact main-lineage product-wizard runtime roster", () => {
    const source = createRealMissionE2ESquadFixture();
    const runtime: Squad = {
      ...source,
      id: "agentic-runtime-11111111-1111-4111-8111-111111111111",
      createdAt: "runtime",
      builtin: false,
      runtimeSourceSquadId: source.id,
      runtimeSourceSquadRevisionHash: snapshotSquadAuthority(source).hash,
      orchestratorInstructions: retargetSquadInstructions(
        source.orchestratorInstructions,
        REAL_MISSION_E2E_GOAL,
      ),
      agents: source.agents.map((agent) => ({
        ...agent,
        model: "gpt-5.5",
      })),
    };
    const lookup = (id: string) =>
      id === source.id ? source : id === runtime.id ? runtime : null;

    expect(
      resolveProductWizardRealMissionE2ESquadBinding(runtime.id, lookup),
    ).toMatchObject({
      squadId: runtime.id,
      sourceSquadId: source.id,
      sourceSquadRevisionHash: snapshotSquadAuthority(source).hash,
      squadRevisionHash: snapshotSquadAuthority(runtime).hash,
    });

    const tampered: Squad = {
      ...runtime,
      agents: runtime.agents.map((agent) =>
        agent.id === "e2e-qa" ? { ...agent, cli: "kimi" } : agent,
      ),
    };
    expect(
      resolveProductWizardRealMissionE2ESquadBinding(
        tampered.id,
        (id) => (id === source.id ? source : tampered),
      ),
    ).toBeNull();
  });
});
