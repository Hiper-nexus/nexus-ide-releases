import { describe, expect, it } from "vitest";
import {
  compileIntentContract,
  isDocumentWritablePath,
} from "../../shared/mission-intent";
import type { Mission, Squad, SquadAgent } from "../../shared/orch-types";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { snapshotTaskPlanRoster, plannedTaskId } from "./task-store";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import { assertRosterCompleteGuidedV2Receipt } from "./guided-mission-plan-authority";
import {
  documentOwnershipFence,
  planGuidedWorkGraph,
} from "./guided-mission-work-graph";
import {
  ensureGuidedMissionPlan,
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
} from "./guided-mission-planner";
import {
  GUIDED_MISSION_REGRESSION_TASK_ID,
  GUIDED_MISSION_REPRODUCTION_TASK_ID,
} from "./guided-task-kind";
import { harness, mission, squad } from "./guided-mission-planner-test-harness";

const BUG_GOAL =
  "Corrigir o bug do login que quebra a sessão quando o token expira";
const FEATURE_GOAL =
  "Implementar a exportação de relatórios em CSV para o painel de vendas";
const DOC_GOAL =
  "Escrever o ADR de decisão sobre a fila de merge na documentação do projeto";
const VISUAL_GOAL =
  "Redesenhar a interface do dashboard com um design system consistente";
/**
 * No token of the product vocabulary fires here — the classifier answers
 * `unknown`, which must land on the generic path and never on a guess.
 */
const UNKNOWN_GOAL =
  "Estabelecer a cadência semanal de sincronia entre os times envolvidos";

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

interface SealedNode {
  readonly plannerId: string;
  readonly taskId: string;
  readonly agentRef: string;
  readonly detail: string;
  readonly executionMode: string | undefined;
  readonly domains: readonly string[];
  readonly files: readonly string[];
  readonly dependsOn: readonly string[];
  readonly parallelEligible: boolean | undefined;
}

function sealGraph(
  goal: string,
  liveSquad: Squad = squad,
): {
  readonly nodes: readonly SealedNode[];
  readonly byPlannerId: ReadonlyMap<string, SealedNode>;
} {
  const currentMission = missionWithGoal(goal, liveSquad);
  const h = harness({ currentMission, liveSquad });
  const result = ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps);
  expect(result).toMatchObject({ applicable: true, sealed: true });
  const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
  const nodes = rows.map((row): SealedNode => {
    const meta = decodeTaskScheduleDetail(row.detail).meta;
    return {
      plannerId: row.plannerId,
      taskId: plannedTaskId(currentMission.id, 3, row.plannerId),
      agentRef: row.agentRef,
      detail: row.detail,
      executionMode: meta?.executionMode,
      domains: meta?.ownership.domains ?? [],
      files: meta?.ownership.files ?? [],
      dependsOn: meta?.dependsOn ?? [],
      parallelEligible: meta?.parallelEligible,
    };
  });
  return {
    nodes,
    byPlannerId: new Map(nodes.map((node) => [node.plannerId, node])),
  };
}

/** Feeds the sealed rows back through the immutable recovery contract. */
function recoverFromReceipt(goal: string, liveSquad: Squad = squad) {
  const currentMission = missionWithGoal(goal, liveSquad);
  const h = harness({ currentMission, liveSquad });
  ensureGuidedMissionPlan(h.suite, currentMission.id, h.deps);
  const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
  const rosterHash = snapshotTaskPlanRoster(liveSquad.agents).hash;
  const planned = rows.map((row, index) => {
    const taskId = plannedTaskId(currentMission.id, 3, row.plannerId);
    return {
      plannerId: row.plannerId,
      taskId,
      missionId: currentMission.id,
      intentVersion: 3,
      squadId: liveSquad.id,
      rosterHash,
      agentRef: row.agentRef,
      agentCategory: row.agentCategory,
      agent: liveSquad.agents.find((agent) => agent.id === row.agentRef)!,
      plannedTitle: row.title,
      plannedDetail: row.detail,
      task: {
        id: taskId,
        missionId: currentMission.id,
        title: row.title,
        detail: row.detail,
        status: "pending" as const,
        createdAt: index + 1,
        updatedAt: index + 1,
      },
    };
  });
  return assertRosterCompleteGuidedV2Receipt(
    planned as never,
    liveSquad,
  );
}

function reviewer(id: string, agentName: string): SquadAgent {
  return { id, agentName, category: "reviewer", cli: "codex", effort: "high" };
}

/**
 * Orchestrator + one executor + the QA gate + three independent reviewers.
 * Enough bodies for the reviews to fan out, and — on a bug — enough left over
 * after reproduction/regression are re-roled for a review to survive.
 */
const multiReviewerSquad: Squad = {
  ...squad,
  id: "agentic-multi-reviewer",
  agents: [
    squad.agents[0]!,
    squad.agents[2]!,
    { ...squad.agents[3]! },
    reviewer("security", "Revisor de segurança"),
    reviewer("ux", "UX e validação visual"),
    reviewer("perf", "Revisor de performance"),
  ],
};

describe("work kind decides the sealed graph shape", () => {
  it("a bug goal seals reproduction BEFORE and regression AFTER the fix", () => {
    const { nodes, byPlannerId } = sealGraph(BUG_GOAL);

    const reproduction = byPlannerId.get(GUIDED_MISSION_REPRODUCTION_TASK_ID);
    const implementation = byPlannerId.get(GUIDED_MISSION_PLANNER_TASK_ID);
    const regression = byPlannerId.get(GUIDED_MISSION_REGRESSION_TASK_ID);
    const gate = byPlannerId.get(GUIDED_MISSION_QA_TASK_ID);
    if (!reproduction || !implementation || !regression || !gate) {
      throw new Error(
        `bug graph incompleto: ${nodes.map((n) => n.plannerId).join(", ")}`,
      );
    }

    // Reproduction is a root and the implementation waits on it.
    expect(reproduction.dependsOn).toEqual([]);
    expect(implementation.dependsOn).toEqual([reproduction.taskId]);
    // Regression runs on the integrated HEAD, after the single writer.
    expect(regression.dependsOn).toEqual([implementation.taskId]);
    expect(gate.dependsOn).toEqual([regression.taskId]);

    // Both bug stages are read-only: a defect repair stays single-writer.
    expect(reproduction.executionMode).toBe("read_only");
    expect(regression.executionMode).toBe("read_only");
    expect(reproduction.files).toEqual([]);
    expect(regression.files).toEqual([]);
    expect(
      nodes.filter((node) => node.executionMode === "isolated_worktree"),
    ).toHaveLength(2); // implementation + corrective quality gate only
    expect(implementation.executionMode).toBe("isolated_worktree");

    // The acceptance criterion the owner asked for, verbatim in the contract.
    expect(implementation.detail).toContain("FALHAR no HEAD atual");
    expect(regression.detail).toContain(
      "FALHA no HEAD anterior à correção e PASSA no HEAD integrado",
    );
    expect(gate.detail).toContain("passar nos dois HEADs");
  });

  it("a feature goal seals today's graph: no reproduction, no regression", () => {
    const { nodes, byPlannerId } = sealGraph(FEATURE_GOAL);

    expect(byPlannerId.has(GUIDED_MISSION_REPRODUCTION_TASK_ID)).toBe(false);
    expect(byPlannerId.has(GUIDED_MISSION_REGRESSION_TASK_ID)).toBe(false);
    const implementation = byPlannerId.get(GUIDED_MISSION_PLANNER_TASK_ID)!;
    // Implementation is still a root: tip discovery never gates delivery.
    expect(implementation.dependsOn).toEqual([]);
    expect(implementation.domains).toContain("guided-implementation");
    // Advisory + implementation + independent review + quality gate.
    expect(nodes).toHaveLength(4);
    expect(
      nodes.filter((node) => node.domains.includes("guided-advisory")),
    ).toHaveLength(1);
    expect(implementation.detail).not.toContain("Contrato de correção");
  });

  it("an unknown goal takes the generic path and never guesses a shape", () => {
    const { byPlannerId } = sealGraph(UNKNOWN_GOAL);

    expect(byPlannerId.has(GUIDED_MISSION_REPRODUCTION_TASK_ID)).toBe(false);
    expect(byPlannerId.has(GUIDED_MISSION_REGRESSION_TASK_ID)).toBe(false);
    const implementation = byPlannerId.get(GUIDED_MISSION_PLANNER_TASK_ID)!;
    expect(implementation.dependsOn).toEqual([]);
    expect(implementation.detail).not.toContain("Contrato de correção");
    expect(implementation.detail).not.toContain("Contrato de design");
    expect(implementation.detail).not.toContain("Contrato de entrega de documentação");
  });

  it("a doc goal cannot reach code: ownership is fenced to documents", () => {
    const { byPlannerId } = sealGraph(DOC_GOAL);

    const implementation = byPlannerId.get(GUIDED_MISSION_PLANNER_TASK_ID)!;
    expect(implementation.files.length).toBeGreaterThan(0);
    expect(implementation.files).not.toContain("src");
    expect(implementation.files).not.toContain("package.json");
    expect(implementation.files.every((file) => file !== "tests")).toBe(true);
    expect(implementation.detail).toContain(
      "O artefato desta missão é o documento, não código",
    );
    const gate = byPlannerId.get(GUIDED_MISSION_QA_TASK_ID)!;
    expect(gate.detail).toContain(
      "Não exija build, typecheck ou suíte de testes de código",
    );
  });

  it("a visual goal keeps today's graph but demands a design contract first", () => {
    const { nodes, byPlannerId } = sealGraph(VISUAL_GOAL);

    expect(byPlannerId.has(GUIDED_MISSION_REPRODUCTION_TASK_ID)).toBe(false);
    expect(nodes).toHaveLength(4);
    const implementation = byPlannerId.get(GUIDED_MISSION_PLANNER_TASK_ID)!;
    expect(implementation.detail).toContain(
      "Antes de escrever a primeira linha de estilo, CSS ou token",
    );
    // The actionable failure, not a vague warning.
    expect(implementation.detail).toContain("design_contract_missing");
    expect(byPlannerId.get(GUIDED_MISSION_QA_TASK_ID)!.detail).toContain(
      "design_contract_missing",
    );
  });
});

describe("independent reviews run concurrently when genuinely independent", () => {
  it("every read-only reviewer depends on the integrated HEAD, not on a peer", () => {
    const { nodes, byPlannerId } = sealGraph(FEATURE_GOAL, multiReviewerSquad);

    const implementation = byPlannerId.get(GUIDED_MISSION_PLANNER_TASK_ID)!;
    const reviews = nodes.filter((node) =>
      node.domains.includes("guided-independent-review"),
    );
    expect(reviews).toHaveLength(3);
    for (const review of reviews) {
      expect(review.dependsOn).toEqual([implementation.taskId]);
      expect(review.executionMode).toBe("read_only");
      // Parallel-eligible and non-exclusive: no sequential-only fence.
      expect(review.parallelEligible).toBe(true);
      expect(review.domains).not.toContain("sequential-only");
    }

    // The gate joins the whole frontier instead of a single chain tail.
    const gate = byPlannerId.get(GUIDED_MISSION_QA_TASK_ID)!;
    expect([...gate.dependsOn].sort()).toEqual(
      reviews.map((review) => review.taskId).sort(),
    );
  });

  it("bug reviews fan out from the regression proof, not from the fix", () => {
    const { nodes, byPlannerId } = sealGraph(BUG_GOAL, multiReviewerSquad);

    const regression = byPlannerId.get(GUIDED_MISSION_REGRESSION_TASK_ID)!;
    const reviews = nodes.filter((node) =>
      node.domains.includes("guided-independent-review"),
    );
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      expect(review.dependsOn).toEqual([regression.taskId]);
    }
  });
});

describe("every new shape stays recoverable from the immutable receipt", () => {
  it("recovers the bug graph without re-reading the goal", () => {
    const recovered = recoverFromReceipt(BUG_GOAL);
    expect(recovered.implementation.plannerId).toBe(
      GUIDED_MISSION_PLANNER_TASK_ID,
    );
    expect(recovered.qualityGate.plannerId).toBe(GUIDED_MISSION_QA_TASK_ID);
    expect(recovered.ordered.map((entry) => entry.plannerId)).toEqual([
      GUIDED_MISSION_REPRODUCTION_TASK_ID,
      GUIDED_MISSION_PLANNER_TASK_ID,
      GUIDED_MISSION_REGRESSION_TASK_ID,
      GUIDED_MISSION_QA_TASK_ID,
    ]);
  });

  it("recovers the concurrent-review graph", () => {
    const recovered = recoverFromReceipt(FEATURE_GOAL, multiReviewerSquad);
    expect(recovered.implementation.plannerId).toBe(
      GUIDED_MISSION_PLANNER_TASK_ID,
    );
    // executor + 3 concurrent reviews + gate.
    expect(recovered.ordered).toHaveLength(5);
  });

  it("recovers the bug graph that still has an independent review", () => {
    const recovered = recoverFromReceipt(BUG_GOAL, multiReviewerSquad);
    expect(recovered.ordered.map((entry) => entry.plannerId)).toEqual([
      GUIDED_MISSION_REPRODUCTION_TASK_ID,
      GUIDED_MISSION_PLANNER_TASK_ID,
      GUIDED_MISSION_REGRESSION_TASK_ID,
      "guided-review-1-perf",
      GUIDED_MISSION_QA_TASK_ID,
    ]);
  });

  it("recovers the generic feature graph", () => {
    const recovered = recoverFromReceipt(FEATURE_GOAL);
    expect(recovered.ordered.map((entry) => entry.plannerId)).toEqual([
      "guided-advisory-1-frontend",
      GUIDED_MISSION_PLANNER_TASK_ID,
      "guided-review-1-reviewer",
      GUIDED_MISSION_QA_TASK_ID,
    ]);
  });
});

describe("planGuidedWorkGraph", () => {
  const agent = (id: string) => ({ id });

  it("never takes a body that cannot hold a read-only lane", () => {
    const shape = planGuidedWorkGraph({
      goal: BUG_GOAL,
      advisors: [agent("writer-only")],
      reviewers: [agent("writer-only-2")],
      isReadOnlyCapable: () => false,
    });
    expect(shape.workKind).toBe("bug");
    expect(shape.reproduction).toBeNull();
    expect(shape.regression).toBeNull();
    // The obligation moves into the contract instead of disappearing.
    expect(shape.reproductionInContractOnly).toBe(true);
    expect(shape.regressionInContractOnly).toBe(true);
  });

  it("prefers an advisor body for reproduction so a reviewer stays free", () => {
    const shape = planGuidedWorkGraph({
      goal: BUG_GOAL,
      advisors: [agent("scout")],
      reviewers: [agent("rev-a"), agent("rev-b")],
      isReadOnlyCapable: () => true,
    });
    expect(shape.reproduction?.id).toBe("scout");
    expect(shape.regression?.id).toBe("rev-a");
    expect(shape.reviewers.map((item) => item.id)).toEqual(["rev-b"]);
    expect(shape.advisors).toEqual([]);
  });

  it("leaves every non-bug kind on the generic shape", () => {
    for (const goal of [FEATURE_GOAL, DOC_GOAL, VISUAL_GOAL, UNKNOWN_GOAL]) {
      const shape = planGuidedWorkGraph({
        goal,
        advisors: [agent("scout")],
        reviewers: [agent("rev-a")],
        isReadOnlyCapable: () => true,
      });
      expect(shape.reproduction).toBeNull();
      expect(shape.regression).toBeNull();
      expect(shape.advisors.map((item) => item.id)).toEqual(["scout"]);
      expect(shape.reviewers.map((item) => item.id)).toEqual(["rev-a"]);
    }
  });
});

describe("documentOwnershipFence", () => {
  it("keeps documentation paths and drops code", () => {
    expect(
      documentOwnershipFence([
        "src",
        "package.json",
        "docs",
        "README.md",
        "tests",
        "docs/adr/0007-merge-queue.md",
      ]),
    ).toEqual(["docs", "docs/adr/0007-merge-queue.md", "README.md"]);
  });

  it("always owns a documentation surface, even in a repo without docs", () => {
    expect(documentOwnershipFence(["src", "package.json"])).toEqual(["docs"]);
  });

  it("never lets a code path survive the fence", () => {
    const fenced = documentOwnershipFence([
      "src/app.ts",
      "src",
      "tests",
      "package.json",
      "vite.config.ts",
      "notes.md",
    ]);
    expect(fenced).toEqual(["docs", "notes.md"]);
    expect(fenced.every((file) => isDocumentWritablePath(file))).toBe(true);
  });
});
