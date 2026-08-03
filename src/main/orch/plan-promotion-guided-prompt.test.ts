import { describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { Handoff, Mission } from "../../shared/orch-types";
import { buildGuidedMissionTaskDetail } from "./guided-mission-planner";
import { buildMissionSchedulerTaskPrompt } from "./mission-scheduler-production";
import { selectPhysicalPlanHandoff } from "./plan-promotion-authority";
import { buildCanonicalMissionKickoffPrompt } from "./mission-kickoff";
import { BUILTIN_SQUADS } from "./builtin-squads";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { NEXUS_STORY_IMPLEMENTATION_SQUAD_ID } from "../../shared/builtin-squad-ids";

function planMission(): Mission {
  const contract = compileIntentContract({
    goal: "Construir autenticação segura conforme o PRD",
    acceptanceCriteria: ["Sessões rotacionam tokens", "Testes passam"],
    intentVersion: 1,
    lane: "plan",
  });
  return {
    id: "mission-plan",
    title: "Autenticação",
    description: contract.goal,
    status: "running",
    squadId: "guided-squad",
    milestones: [],
    learnings: "",
    orchestratorSessionId: "plan-session-v1",
    intentState: "executing",
    intentVersion: 1,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 10,
    },
    createdAt: 1,
    updatedAt: 10,
  };
}

function physicalHandoff(): Handoff {
  return {
    id: "handoff-plan-v1",
    missionId: "mission-plan",
    sessionId: "plan-session-v1",
    fromAgent: "Maestro",
    authorityOrigin: "agent",
    mcpProvenance: {
      receiptId: "receipt-plan-v1",
      toolCallId: "tool-plan-v1",
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      missionId: "mission-plan",
      sessionId: "plan-session-v1",
      authoritySha256: "a".repeat(64),
      issuedAt: 20,
    },
    status: "success",
    claimTrust: "untrusted",
    summary:
      "# PRD de autenticação\n\nUse sessões curtas, refresh rotativo e revogação por família.",
    artifacts: [
      {
        path: "plan.md",
        sections: ["ameaças", "dados", "rollout"],
      },
    ],
    evidenceIds: [],
    evidenceTrust: "unverified",
    delivered: true,
    deliveryState: "consumed",
    submittedAt: 21,
    acknowledgedAt: 22,
    consumedAt: 23,
    createdAt: 20,
  };
}

describe("plan promotion → guided task prompt", () => {
  it("carries the exact physical PRD, artifacts and digest without redelivery", () => {
    const plan = planMission();
    const handoff = physicalHandoff();
    const promotedPlan = selectPhysicalPlanHandoff({
      mission: plan,
      handoffs: {
        list: () => [handoff],
        get: () => handoff,
      },
    });
    const standard: Mission = {
      ...plan,
      status: "pending",
      orchestratorSessionId: undefined,
      intentState: "ready_to_start",
      intentVersion: 2,
      intentContract: {
        ...plan.intentContract!,
        lane: "standard",
        intentVersion: 2,
        dispatchedAt: undefined,
        promotedPlan,
      },
    };
    const detail = buildGuidedMissionTaskDetail(standard);
    const prompt = buildMissionSchedulerTaskPrompt(
      {
        id: "guided-execution",
        title: "Implementar o PRD promovido",
        detail,
        status: "pending",
        dependsOn: [],
        ownership: {
          files: ["src"],
          symbols: [],
          domains: ["guided-implementation"],
        },
        merged: false,
      },
      {
        agentName: "Executor",
        category: "executor",
        executionMode: "isolated_worktree",
      },
    );

    expect(prompt).toContain(handoff.summary);
    expect(prompt).toContain(JSON.stringify(promotedPlan.artifacts));
    expect(prompt).toContain(promotedPlan.digest);
    expect(prompt).toContain(promotedPlan.summarySha256);
    expect(prompt).toContain(promotedPlan.artifactsSha256);
  });

  it("feeds the promoted physical package to the real story delivery squad without replanning", () => {
    const plan = planMission();
    const handoff = physicalHandoff();
    const promotedPlan = selectPhysicalPlanHandoff({
      mission: plan,
      handoffs: {
        list: () => [handoff],
        get: () => handoff,
      },
    });
    const deliverySquad = BUILTIN_SQUADS.find(
      (squad) => squad.id === NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
    );
    if (!deliverySquad) throw new Error("missing story delivery squad");
    const standard: Mission = {
      ...plan,
      squadId: deliverySquad.id,
      status: "running",
      orchestratorSessionId: "delivery-session-v2",
      intentState: "dispatched",
      intentVersion: 2,
      intentContract: {
        ...plan.intentContract!,
        lane: "standard",
        intentVersion: 2,
        squadRevisionHash: snapshotSquadAuthority(deliverySquad).hash,
        dispatchedAt: 30,
        promotedPlan,
      },
    };

    const kickoff = buildCanonicalMissionKickoffPrompt(
      standard,
      deliverySquad,
    );

    expect(kickoff).toContain("PRD/plano físico aprovado na promoção");
    expect(kickoff).toContain(handoff.summary);
    expect(kickoff).toContain('### Artifacts (1)');
    expect(kickoff).toContain('plan.md');
    expect(kickoff).not.toContain(JSON.stringify(promotedPlan.artifacts));
    expect(kickoff).toContain(promotedPlan.digest);
    expect(kickoff).toContain(promotedPlan.summarySha256);
    expect(kickoff).toContain(promotedPlan.artifactsSha256);
    expect(kickoff).toMatch(
      /não repita discovery, entrevista, PRD, arquitetura ou shard de stories/i,
    );
    expect(kickoff).toMatch(/comece pela primeira story executável/i);
  });

  it("fails closed when the expected handoff lacks physical provenance", () => {
    const plan = planMission();
    const invalid = { ...physicalHandoff(), mcpProvenance: undefined };
    expect(() =>
      selectPhysicalPlanHandoff({
        mission: plan,
        handoffs: {
          list: () => [invalid],
          get: () => invalid,
        },
      }),
    ).toThrow(/provenance física/i);
  });

  it("requires one main-reviewable build artifact for UI delivery", () => {
    const plan = planMission();
    const uiMission: Mission = {
      ...plan,
      intentContract: compileIntentContract({
        goal: "Melhorar a interface React e a acessibilidade do dashboard",
        acceptanceCriteria: ["Build visual pronto para revisão"],
        intentVersion: 1,
        lane: "standard",
      }),
    };

    expect(buildGuidedMissionTaskDetail(uiMission)).toMatch(
      /exatamente uma UI estática renderizável.*dist\/.*\.vite\/renderer/i,
    );
    expect(buildGuidedMissionTaskDetail(uiMission)).toMatch(
      /processo principal do Nexus.*leitura \+ screenshot/i,
    );
  });

  it("refuses a persisted plan whose exact summary no longer matches its digest", () => {
    const plan = planMission();
    const handoff = physicalHandoff();
    const promotedPlan = selectPhysicalPlanHandoff({
      mission: plan,
      handoffs: {
        list: () => [handoff],
        get: () => handoff,
      },
    });
    const standard: Mission = {
      ...plan,
      status: "pending",
      orchestratorSessionId: undefined,
      intentState: "ready_to_start",
      intentVersion: 2,
      intentContract: {
        ...plan.intentContract!,
        lane: "standard",
        intentVersion: 2,
        promotedPlan: {
          ...promotedPlan,
          summary: `${promotedPlan.summary}\nconteúdo não aprovado`,
        },
      },
    };
    expect(() => buildGuidedMissionTaskDetail(standard)).toThrow(
      /promoted_plan_corrupt/i,
    );
  });
});
