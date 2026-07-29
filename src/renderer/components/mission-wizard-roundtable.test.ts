import { describe, expect, it } from "vitest";
import type { SquadAgent } from "../../shared/orch-types";
import { deriveMissionWizardRoundtableState } from "./mission-wizard-roundtable";

const orchestrator: SquadAgent = {
  id: "maestro",
  agentName: "Maestro",
  category: "orchestrator",
  cli: "codex",
};

const executor: SquadAgent = {
  id: "executor",
  agentName: "Executor",
  category: "executor",
  cli: "codex",
};

describe("mission wizard roundtable state", () => {
  it("keeps the delivery summary and worker role semantics", () => {
    const state = deriveMissionWizardRoundtableState({
      guided: true,
      missionGoal: "Implemente a correção com testes",
      squad: { name: "Equipe Nexus" },
      roster: [orchestrator, executor],
    });

    expect(state.isTeamReadOnlyFanout).toBe(false);
    expect(state.guidedSummary).toBe(
      "Equipe Nexus · 2 agentes para executar e verificar a missão.",
    );
    expect(state.configurationHint(true)).toMatch(/^Autopiloto:/);
    expect(state.configurationHint(false)).toMatch(/^O Maestro automático/);
    expect(state.workerLaunchContext).toMatch(/worktree isolado/i);
    expect(state.isAdvisorRole("executor")).toBe(false);
    expect(state.isAdvisorRole("reviewer")).toBe(true);
    expect(state.governedQualificationMessage("executor")).toMatch(
      /escrita autônoma confinada/i,
    );
  });

  it("derives read-only fanout copy and advisor semantics from the mission goal", () => {
    const state = deriveMissionWizardRoundtableState({
      guided: true,
      missionGoal:
        "Teste de todos panes, cada um me fala o que faz na missão",
      squad: { name: "Equipe Nexus" },
      roster: [orchestrator, executor],
    });

    expect(state.isTeamReadOnlyFanout).toBe(true);
    expect(state.guidedSummary).toBe(
      "Equipe Nexus · 1 especialista responde em paralelo, somente leitura · Maestro consolida com sua perspectiva.",
    );
    expect(state.configurationHint(true)).toMatch(
      /cada especialista.*responde em paralelo.*Maestro consolida/i,
    );
    expect(state.workerLaunchContext).toMatch(
      /cada especialista responde em paralelo sem editar o projeto/i,
    );
    expect(state.isAdvisorRole("executor")).toBe(true);
    expect(state.governedQualificationMessage("executor")).toMatch(
      /leitura autônoma confinada/i,
    );
  });
});
