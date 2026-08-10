import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { MissionContract } from "./context/contract-compiler";
import type { ProjectDomainStoreSuite } from "./orch/project-domain-store-registry";
import type { Mission } from "../shared/orch-types";
import type * as RealMissionE2EFixtureModule from "./real-mission-e2e-fixture";
import { testProjectScope } from "./orch/__tests__/scope-fixture";
import { snapshotSquadAuthority } from "./orch/squad-authority-snapshot";
import {
  createRealMissionE2ESquadFixture,
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../shared/real-mission-e2e";

const mocks = vi.hoisted(() => ({
  workflow: {
    getMissionWorkflow: vi.fn(),
    freezeContract: vi.fn(),
    advance: vi.fn(),
  },
}));

const fixtureMocks = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
}));

vi.mock("./real-mission-e2e-fixture", async (importOriginal) => {
  const actual =
    await importOriginal<typeof RealMissionE2EFixtureModule>();
  return {
    ...actual,
    resolveCanonicalRealMissionE2ESquadBinding: fixtureMocks.resolveBinding,
  };
});

vi.mock("./context/context-workflow-registry", () => ({
  getContextWorkflowService: () => mocks.workflow,
}));

import {
  freezeRealMissionE2EPrevCIfNeeded,
  stageRealMissionE2EContextCorpus,
} from "./real-mission-e2e-prevc";

const originalE2EEnvironment = process.env.NEXUS_REAL_MISSION_E2E;

afterEach(() => {
  mocks.workflow.getMissionWorkflow.mockReset();
  mocks.workflow.freezeContract.mockReset();
  mocks.workflow.advance.mockReset();
  fixtureMocks.resolveBinding.mockReset();
  if (originalE2EEnvironment === undefined) {
    delete process.env.NEXUS_REAL_MISSION_E2E;
  } else {
    process.env.NEXUS_REAL_MISSION_E2E = originalE2EEnvironment;
  }
});

function fixture(missionId: string, rootRealPath = `/workspace/${missionId}`) {
  const scope = testProjectScope({
    checkoutId: `checkout-${missionId}`,
    rootRealPath,
  });
  const fixtureSquadRevisionHash = snapshotSquadAuthority(
    createRealMissionE2ESquadFixture(),
  ).hash;
  const squadId = `agentic-runtime-${missionId}`;
  const squadRevisionHash = "b".repeat(64);
  fixtureMocks.resolveBinding.mockImplementation((input) =>
    input.squadId === squadId &&
    input.title === "Release gate: missão real empacotada" &&
    input.objective === REAL_MISSION_E2E_GOAL
      ? {
          squadId,
          fixtureSquadId: REAL_MISSION_E2E_SQUAD_ID,
          fixtureSquadRevisionHash,
          sourceSquadId:
            "custom-mission-setup-11111111-1111-4111-8111-111111111111",
          sourceSquadRevisionHash: "a".repeat(64),
          squadRevisionHash,
        }
      : null,
  );
  const mission: Mission & {
    projectId: string;
    checkoutId: string;
  } = {
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    id: missionId,
    title: "Release gate: missão real empacotada",
    description: "",
    status: "running" as const,
    squadId,
    milestones: [],
    learnings: "",
    intentState: "executing",
    intentVersion: 1,
    orchestratorSessionId: `orchestrator-${missionId}`,
    intentContract: {
      version: 1 as const,
      source: "typed" as const,
      goal: REAL_MISSION_E2E_GOAL,
      acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
      risk: "normal" as const,
      executionMode: "autopilot" as const,
      lane: "standard" as const,
      contextPolicy: "minimal" as const,
      approvedAt: 10,
      dispatchedAt: 11,
      intentVersion: 1,
      budgets: {
        planningTokens: 1_000,
        executionTokens: 10_000,
        maxWorkers: 3,
      },
      squadRevisionHash,
      orchestratorRuntime: {
        adapterId: "codex",
        readOnly: false as const,
        nativeReadOnly: false as const,
      },
    },
    createdAt: 1,
    updatedAt: 2,
  };
  const contractHash = "c".repeat(64);
  const contextRevision = "d".repeat(64);
  const contract: MissionContract = {
    schemaVersion: 1,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    missionId,
    baseCommit: "a".repeat(40),
    contextRevision,
    goal: REAL_MISSION_E2E_GOAL,
    nonGoals: [],
    acceptanceCriteria: REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.map(
      (statement, index) => ({
        id: `ac-${index + 1}`,
        statement,
        requiredSensorIds: [],
        invariantRefs: [],
        requiredArtifactIds: [],
      }),
    ),
    businessInvariantRefs: [],
    impactedDomains: [],
    impactedSymbols: [],
    requiredSensors: ["typecheck", "unit"],
    requiredArtifacts: [],
    reviewerPolicy: {
      minimumReviewers: 1,
      requireIndependentAuthor: true,
      requireDifferentProvider: false,
      blockingSeverities: ["critical", "high"],
    },
    risk: "medium",
    phase: "planning",
    route: ["planning", "execution"],
    contractHash,
  };
  const workflow = {
    contract: {
      contract,
      author: {
        id: "nexus-real-mission-e2e-prevc",
        sessionId: `main:${missionId}:release-prevc`,
        provider: "nexus-main",
      },
      frozenAt: 12,
    },
    workflow: {
      risk: "medium",
      binding: {
        projectId: scope.projectId,
        checkoutId: scope.checkoutId,
        missionId,
        contractHash,
        contextHash: contextRevision,
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        diffHash: "e".repeat(64),
      },
      route: ["planning", "execution"],
      stage: "execution",
      completedStages: ["planning"],
      reviewers: [],
      revision: 2,
    },
  };
  const missions = {
    get: vi.fn((candidateId: string) =>
      candidateId === missionId ? mission : null,
    ),
    hasCurrentKickoffAcceptance: vi.fn(
      (candidateId: string) => candidateId === missionId,
    ),
  };
  const suite = {
    scope,
    missions,
  } as unknown as ProjectDomainStoreSuite;
  return { contract, mission, missionId, scope, suite, workflow };
}

function freezeExactFixture(harness: ReturnType<typeof fixture>) {
  process.env.NEXUS_REAL_MISSION_E2E = "1";
  mocks.workflow.getMissionWorkflow.mockReturnValue(harness.workflow);
  expect(
    freezeRealMissionE2EPrevCIfNeeded(
      harness.suite,
      harness.missionId,
      harness.scope,
    ),
  ).toEqual({ frozen: false, reason: "already-frozen" });
}

describe("real mission E2E PREVC production review boundary", () => {
  it("stages outcome-sensitive sensors that reject a missing or incorrect deliverable", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "nexus-real-mission-prevc-sensors-"),
    );
    try {
      stageRealMissionE2EContextCorpus(root);
      const config = JSON.parse(
        readFileSync(
          path.join(root, ".context/config/sensors.json"),
          "utf8",
        ),
      ) as {
        sensors: Array<{ id: string; command: string[] }>;
      };
      const run = (sensorId: string) => {
        const sensor = config.sensors.find(
          (candidate) => candidate.id === sensorId,
        );
        if (!sensor) throw new Error(`missing sensor ${sensorId}`);
        return spawnSync(sensor.command[0]!, sensor.command.slice(1), {
          cwd: root,
          encoding: "utf8",
        }).status;
      };

      expect(run("typecheck")).not.toBe(0);
      expect(run("unit")).not.toBe(0);

      writeFileSync(path.join(root, "resultado.txt"), "incorrect\n", "utf8");
      expect(run("typecheck")).toBe(0);
      expect(run("unit")).not.toBe(0);

      writeFileSync(
        path.join(root, "resultado.txt"),
        "nexus-real-mission-e2e-ok\n",
        "utf8",
      );
      expect(run("typecheck")).toBe(0);
      expect(run("unit")).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes a fresh exact fixture with durable Main-owned authority after the Maestro exits", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "nexus-real-mission-prevc-main-"),
    );
    try {
      stageRealMissionE2EContextCorpus(root);
      const harness = fixture("mission-main-freeze", realpathSync(root));
      let isAdvanced = false;
      mocks.workflow.getMissionWorkflow.mockImplementation(() =>
        isAdvanced
          ? harness.workflow
          : { contract: null, workflow: null },
      );
      mocks.workflow.freezeContract.mockReturnValue(harness.workflow.contract);
      mocks.workflow.advance.mockImplementation(() => {
        isAdvanced = true;
        return harness.workflow.workflow;
      });
      process.env.NEXUS_REAL_MISSION_E2E = "1";

      expect(
        freezeRealMissionE2EPrevCIfNeeded(
          harness.suite,
          harness.missionId,
          harness.scope,
        ),
      ).toEqual({ frozen: true, reason: "frozen" });
      expect(mocks.workflow.freezeContract).toHaveBeenCalledOnce();
      expect(mocks.workflow.freezeContract.mock.calls[0]?.[1]).toEqual({
        id: "nexus-real-mission-e2e-prevc",
        sessionId: `main:${harness.missionId}:release-prevc`,
        provider: "nexus-main",
      });
      expect(mocks.workflow.advance).toHaveBeenCalledWith(
        harness.missionId,
        "execution",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an already frozen exact fixture without installing a review seam", () => {
    const harness = fixture("mission-authorized");
    freezeExactFixture(harness);
  });

  it("fails the exact fixture identity when mission intent drifts", () => {
    const harness = fixture("mission-drift");
    freezeExactFixture(harness);
    if (!harness.mission.intentContract) {
      throw new Error("fixture mission is missing its intent contract");
    }
    harness.mission.intentContract.goal = "missão arbitrária";
    expect(
      freezeRealMissionE2EPrevCIfNeeded(
        harness.suite,
        harness.missionId,
        harness.scope,
      ),
    ).toEqual({ frozen: false, reason: "not-e2e-mission" });
  });

  it("rejects Hardened native authority in the Autopilot release fixture", () => {
    const harness = fixture("mission-hardened-drift");
    if (!harness.mission.intentContract?.orchestratorRuntime) {
      throw new Error("fixture mission is missing its runtime snapshot");
    }
    harness.mission.intentContract.orchestratorRuntime = {
      ...harness.mission.intentContract.orchestratorRuntime,
      nativeReadOnly: true,
    };
    process.env.NEXUS_REAL_MISSION_E2E = "1";
    mocks.workflow.getMissionWorkflow.mockReturnValue(harness.workflow);

    expect(
      freezeRealMissionE2EPrevCIfNeeded(
        harness.suite,
        harness.missionId,
        harness.scope,
      ),
    ).toEqual({ frozen: false, reason: "not-e2e-mission" });
  });

  it("keeps merge and final validation on the live CliAutomatedReviewer", () => {
    const fixtureSource = readFileSync(
      new URL("./real-mission-e2e-prevc.ts", import.meta.url),
      "utf8",
    );
    const schedulerSource = readFileSync(
      new URL("./orch/mission-scheduler-production.ts", import.meta.url),
      "utf8",
    );
    const autopilotSource = readFileSync(
      new URL("./orch/prevc-autopilot-coordinator.ts", import.meta.url),
      "utf8",
    );
    expect(fixtureSource).not.toMatch(
      /AutomatedReviewSessionRegistry|realMissionE2EReviewDeps|sessions\.submit/u,
    );
    expect(fixtureSource).not.toMatch(
      /from\s+["']\.\/orch\/gate["']|getContextBySession/u,
    );
    expect(schedulerSource).not.toContain(
      "realMissionE2EMergeValidationDeps",
    );
    expect(autopilotSource).not.toContain(
      "realMissionE2EFinalValidationDeps",
    );
    expect(schedulerSource).toContain(
      "new MergeValidationCoordinator(service)",
    );
    expect(autopilotSource).toContain("new CliAutomatedReviewer()");
  });
});
