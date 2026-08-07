import { describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import { classifyWorkKind, decideDesignAuthority } from "../../shared/mission-work-kind";
import type { Mission, Squad } from "../../shared/orch-types";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { plannedTaskId } from "./task-store";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import { planGuidedWorkGraph } from "./guided-mission-work-graph";
import {
  ensureGuidedMissionPlan,
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
} from "./guided-mission-planner";
import { harness, mission, squad } from "./guided-mission-planner-test-harness";

/**
 * H4 — THE DEADLOCK, AND THE INVARIANT THAT MUST HOLD FOREVER.
 *
 * Measured before the fix: `"trocar a cor do botão de aprovar"` classifies
 * `visual` with LOW confidence. `buildDesignContractBootstrap` therefore wrote
 * NO contract, while `planGuidedWorkGraph` published `visual` anyway and the
 * sealed executor contract ordered the worker to "send handoff blocked with
 * `design_contract_missing`". No contract, and an order to block for the lack
 * of one — a deadlock on the most trivial task the product can be given.
 *
 * The invariant these tests pin: WHOEVER DEMANDS A DESIGN CONTRACT IS WHOEVER
 * CREATES ONE. Both ends call `decideDesignAuthority`, so `workKind === visual`
 * in the graph is true exactly when that predicate grants authority.
 */

/** Visual craft/surface evidence, but too weak to author authority. */
const LOW_CONFIDENCE_VISUAL_GOAL = "Trocar a cor do botão de aprovar da fila";
/** Uncontested interface evidence: authority is granted. */
const HIGH_CONFIDENCE_VISUAL_GOAL =
  "Redesenhar a interface do dashboard com um design system consistente";

function missionWithGoal(goal: string, liveSquad: Squad = squad): Mission {
  const contract = compileIntentContract({
    goal,
    acceptanceCriteria: ["O comportamento aprovado fica provado por evidência"],
    intentVersion: 3,
    source: "typed",
    lane: "standard",
  });
  return mission({
    squadId: liveSquad.id,
    description: goal,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 10,
      squadRevisionHash: snapshotSquadAuthority(liveSquad).hash,
    },
  });
}

function sealDetails(goal: string): ReadonlyMap<string, string> {
  const currentMission = missionWithGoal(goal);
  // Design-contract clauses on QA require the Hardened multi-stage seal.
  const h = harness({
    currentMission,
    liveSquad: squad,
    squadCliPolicy: "governed",
  });
  expect(ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps)).toMatchObject(
    { applicable: true, sealed: true },
  );
  const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
  return new Map(
    rows.map((row) => [
      row.plannerId,
      row.detail,
    ]),
  );
}

const agent = (id: string) => ({ id });

function graphFor(goal: string) {
  return planGuidedWorkGraph({
    goal,
    advisors: [agent("scout")],
    reviewers: [agent("rev-a")],
    isReadOnlyCapable: () => true,
  });
}

describe("H4: the design obligation never outruns the design contract", () => {
  it("reproduces the measured deadlock input as low-confidence visual work", () => {
    const decision = decideDesignAuthority(LOW_CONFIDENCE_VISUAL_GOAL);
    // The classification itself is unchanged — this goal IS about a visual
    // surface. What changed is that a hint no longer creates an obligation.
    expect(decision.verdict.kind).toBe("visual");
    expect(decision.required).toBe(false);
  });

  it("does NOT order the worker to block on a contract nobody would create", () => {
    const details = sealDetails(LOW_CONFIDENCE_VISUAL_GOAL);
    const implementation = details.get(GUIDED_MISSION_PLANNER_TASK_ID)!;
    const gate = details.get(GUIDED_MISSION_QA_TASK_ID)!;

    expect(implementation).not.toContain("design_contract_missing");
    expect(gate).not.toContain("design_contract_missing");
    expect(implementation).not.toContain(
      "Antes de escrever a primeira linha de estilo",
    );
  });

  it("still demands the contract when the same predicate grants authority", () => {
    expect(decideDesignAuthority(HIGH_CONFIDENCE_VISUAL_GOAL).required).toBe(
      true,
    );
    const details = sealDetails(HIGH_CONFIDENCE_VISUAL_GOAL);
    expect(details.get(GUIDED_MISSION_PLANNER_TASK_ID)!).toContain(
      "design_contract_missing",
    );
    expect(details.get(GUIDED_MISSION_QA_TASK_ID)!).toContain(
      "design_contract_missing",
    );
  });

  it("publishes `unknown` — the documented generic path — instead of guessing", () => {
    const graph = graphFor(LOW_CONFIDENCE_VISUAL_GOAL);
    expect(graph.workKind).toBe("unknown");
    // Nothing about the classification is hidden: the verdict travels whole,
    // so the UI and the logs can still say "this looked visual, weakly".
    expect(graph.verdict.kind).toBe("visual");
    expect(graph.verdict.confidence).toBe("low");
    expect(graph.reason).toContain("SEM cláusula de contrato de design");
    // Shape is untouched: this is a contract decision, not a graph decision.
    expect(graph.reproduction).toBeNull();
    expect(graph.advisors.map((a) => a.id)).toEqual(["scout"]);
    expect(graph.reviewers.map((a) => a.id)).toEqual(["rev-a"]);
  });

  it("keeps both ends on ONE predicate across every goal shape", () => {
    const goals = [
      LOW_CONFIDENCE_VISUAL_GOAL,
      HIGH_CONFIDENCE_VISUAL_GOAL,
      "Corrigir o bug do login que quebra a sessão quando o token expira",
      "Escrever o ADR de decisão sobre a fila de merge na documentação",
      "Implementar o endpoint de sincronização no servidor",
      "Melhorar a performance do dashboard de métricas",
      "Ajustar o espaçamento do menu lateral",
      "Estabelecer a cadência semanal de sincronia entre os times",
    ];
    for (const goal of goals) {
      const required = decideDesignAuthority(goal).required;
      // If and only if. A `visual` workKind in the graph is the ONLY thing
      // that injects the `design_contract_missing` clause, so this equivalence
      // is the deadlock's absence, stated mechanically.
      expect(graphFor(goal).workKind === "visual").toBe(required);
    }
  });

  it("never downgrades a kind whose clause the executor can satisfy alone", () => {
    // bug/doc clauses ask for a reproduction, a regression or a document —
    // all inside the mission. Only `visual` demands authority that lives
    // outside it, so only `visual` is gated on the design predicate.
    const bug = graphFor(
      "Corrigir o bug do login que quebra a sessão quando o token expira",
    );
    expect(bug.workKind).toBe("bug");
    expect(bug.reproduction?.id).toBe("scout");
    const doc = graphFor(
      "Escrever o ADR de decisão sobre a fila de merge na documentação",
    );
    expect(doc.workKind).toBe("doc");
  });
});

describe("the sealed receipt still recovers the plan", () => {
  it("seals the same four nodes for a downgraded visual goal", () => {
    const currentMission = missionWithGoal(LOW_CONFIDENCE_VISUAL_GOAL);
    const h = harness({
      currentMission,
      liveSquad: squad,
      squadCliPolicy: "governed",
    });
    ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps);
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    expect(rows).toHaveLength(4);
    const taskIds = new Set<string>();
    for (const row of rows) {
      // Every sealed row still decodes: the downgrade changes contract text,
      // never the scheduler metadata the receipt recovers the graph from.
      expect(
        decodeTaskScheduleDetail(row.detail).meta?.executionMode,
      ).toBeTruthy();
      taskIds.add(plannedTaskId(currentMission.id, 3, row.plannerId));
    }
    expect(taskIds.size).toBe(4);
  });
});

// REGRESSAO (mesma familia do H4, achada pelo agente do H4 e fechada depois):
// `doc` nao adiciona so uma clausula ao prompt — ele aplica a CERCA de
// ownership, que torna o codigo fisicamente inalcancavel. Um veredito fraco
// produzindo restricao irreversivel e o mesmo defeito do deadlock visual, na
// outra ponta: a missao nao trava, ela fica IMPOSSIVEL de cumprir.
describe("cerca de documentacao exige veredito forte", () => {
  it("objetivo misto (feature + PRD) nao trava a metade de codigo", () => {
    const verdict = classifyWorkKind("criar a feature de billing e escrever o PRD");
    expect(verdict.kind).toBe("doc");
    expect(verdict.confidence).toBe("low");

    const graph = graphFor("criar a feature de billing e escrever o PRD");
    expect(graph.workKind).toBe("unknown");
    // O veredito completo continua disponivel para explicar a decisao.
    expect(graph.verdict.kind).toBe("doc");
  });

  it("doc inequivoco continua cercado", () => {
    const verdict = classifyWorkKind("escrever o ADR do modulo de pagamentos");
    expect(verdict.kind).toBe("doc");
    expect(verdict.confidence).toBe("high");
    expect(graphFor("escrever o ADR do modulo de pagamentos").workKind).toBe("doc");
  });
});
