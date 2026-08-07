import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Squad } from "../../shared/orch-types";
import { TEAM_READ_ONLY_FANOUT_DOMAIN } from "../../shared/mission-topology";
import {
  decodeTaskScheduleDetail,
  encodeTaskScheduleDetail,
} from "./mission-scheduler-meta";
import { plannedTaskId } from "./task-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import {
  ensureGuidedMissionPlan,
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
  listRepositoryOwnershipClaims,
  repositoryOwnershipClaimsFromGitTree,
  type GuidedMissionPlannerDeps,
} from "./guided-mission-planner";
import type { GitRunOptions, GitRunner } from "../runtime/git-command";
import {
  harness,
  liveAdapter,
  mission,
  sealedGuidedV2Receipt,
  squad,
} from "./guided-mission-planner-test-harness";
import { testProjectScope } from "./__tests__/scope-fixture";

describe("Guided Planner v2", () => {
  it("runs qualified scout and architect advisory identities as pre-execution read-only tasks", () => {
    const expandedSquad: Squad = {
      ...squad,
      agents: [
        ...squad.agents,
        {
          id: "scout",
          agentName: "Scout de código",
          category: "scout",
          cli: "codex",
        },
        {
          id: "architect",
          agentName: "Arquiteto de solução",
          category: "architect",
          cli: "codex",
        },
      ],
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(expandedSquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad: expandedSquad,
      squadCliPolicy: "governed",
    });

    ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps);

    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    expect(rows).toHaveLength(
      expandedSquad.agents.filter((agent) => agent.category !== "orchestrator")
        .length,
    );
    for (const agentRef of ["scout", "architect"] as const) {
      const row = rows.find((candidate) => candidate.agentRef === agentRef)!;
      expect(decodeTaskScheduleDetail(row.detail).meta).toMatchObject({
        agentRef,
        executionMode: "read_only",
        ownership: {
          domains: ["guided-advisory"],
        },
      });
      expect(rows.indexOf(row)).toBeLessThan(
        rows.findIndex(
          (candidate) => candidate.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
        ),
      );
    }
  });

  it("rejects a mixed roster whose OpenCode/Kimi/AGY/Grok workers lack a qualified workspace sandbox", () => {
    const fallbackSquad: Squad = {
      ...squad,
      agents: [
        {
          id: "orch",
          agentName: "Maestro",
          category: "orchestrator",
          cli: "claude",
        },
        {
          id: "primary-codex",
          agentName: "Generalist principal",
          category: "executor",
          cli: "codex",
          effort: "high",
        },
        {
          id: "secondary-agy",
          agentName: "Executor AGY",
          category: "executor",
          cli: "agy",
        },
        {
          id: "scout-kimi",
          agentName: "Scout Kimi",
          category: "scout",
          cli: "kimi",
        },
        {
          id: "architect-grok",
          agentName: "Architect Grok",
          category: "architect",
          cli: "grok",
        },
        {
          id: "qa-opencode",
          agentName: "QA OpenCode",
          category: "reviewer",
          cli: "opencode",
          effort: "high",
        },
        {
          id: "review-longcat",
          agentName: "Reviewer LongCat",
          category: "reviewer",
          cli: "longcat",
        },
      ],
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(fallbackSquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad: fallbackSquad,
      adapters: [
        liveAdapter("claude"),
        liveAdapter("codex"),
        liveAdapter("opencode"),
        liveAdapter("agy"),
        liveAdapter("kimi"),
        liveAdapter("grok"),
        liveAdapter("longcat"),
      ],
    });
    vi.mocked(h.deps.assertStandardSquadReadiness).mockImplementationOnce(
      () => {
        throw new Error(
          "squad_runtime_unavailable:worker-unavailable: OpenCode/Kimi/AGY/Grok sem sandbox de workspace confiável",
        );
      },
    );

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/worker-unavailable.*sandbox de workspace/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("fails closed when the approved squad has no non-Claude QA/reviewer", () => {
    const executionOnlySquad: Squad = {
      ...squad,
      agents: squad.agents.filter(
        (agent) => agent.category !== "reviewer" || agent.cli === "claude",
      ),
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(executionOnlySquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad: executionOnlySquad,
      squadCliPolicy: "governed",
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_reviewer_missing/);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("keeps reserveClaude: a Claude executor is never selected as a worker", () => {
    const claudeOnlySquad: Squad = {
      ...squad,
      agents: squad.agents.filter(
        (agent) => agent.category === "orchestrator" || agent.cli === "claude",
      ),
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(claudeOnlySquad).hash,
      },
    });
    const h = harness({ currentMission, liveSquad: claudeOnlySquad });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/executor.*disponível/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("uses the single Claude session as executor when another CLI is Maestro in autopilot", () => {
    const claudeWorkerSquad: Squad = {
      ...squad,
      agents: [
        {
          id: "orch-codex",
          agentName: "Maestro Codex",
          category: "orchestrator",
          cli: "codex",
        },
        {
          id: "builder-claude",
          agentName: "Builder Claude",
          category: "executor",
          cli: "claude",
        },
        {
          id: "qa-kimi",
          agentName: "QA Kimi",
          category: "reviewer",
          cli: "kimi",
        },
      ],
    };
    const currentMission = mission({
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(claudeWorkerSquad).hash,
      },
    });
    const h = harness({
      currentMission,
      liveSquad: claudeWorkerSquad,
      adapters: [
        liveAdapter("codex"),
        liveAdapter("claude"),
        liveAdapter("kimi"),
      ],
    });

    ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps);

    const implementation = h.createPlanAtomically.mock.calls[0]![0].rows.find(
      (row) => row.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    expect(implementation).toMatchObject({
      agentRef: "builder-claude",
      agentCategory: "executor",
    });
    if (!implementation) {
      throw new Error("guided implementation task was not scheduled");
    }
    const decodedImplementation = decodeTaskScheduleDetail(implementation.detail);
    expect(decodedImplementation.meta).not.toBeNull();
    // Padrão desde 06/08: a entrega comum nasce no caminho simples.
    expect(decodedImplementation.meta!.executionMode).toBe("same_checkout");
  });

  it.each([
    ["automation", "standard", "automation-owned"],
    ["typed", "plan", "lane-not-standard"],
    ["typed", "consult", "lane-not-standard"],
    ["typed", "ops", "lane-not-standard"],
  ] as const)(
    "leaves source=%s lane=%s to its specialized flow",
    (source, lane, reason) => {
      const currentMission = mission({
        intentContract: {
          ...mission().intentContract!,
          source,
          lane,
        },
      });
      const h = harness({ currentMission });

      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
      ).toEqual({ applicable: false, sealed: false, reason });
      expect(h.deps.listLiveAdapters).not.toHaveBeenCalled();
      expect(h.deps.listRepositoryOwnership).not.toHaveBeenCalled();
      expect(h.createPlanAtomically).not.toHaveBeenCalled();
    },
  );

  it.each(["nexus-review", "nexus-research", "kimi-cell", "user-squad"])(
    "leaves manual/specialty squad %s to its established orchestrator plan",
    (squadId) => {
      const specialty: Squad = {
        ...squad,
        id: squadId,
        agents: squad.agents.map((agent) => ({ ...agent })),
      };
      const currentMission = mission({
        squadId,
        intentContract: {
          ...mission().intentContract!,
          squadRevisionHash: snapshotSquadAuthority(specialty).hash,
        },
      });
      const h = harness({
        currentMission,
        liveSquad: specialty,
      });

      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
      ).toEqual({
        applicable: false,
        sealed: false,
        reason: "squad-not-engine-generated",
      });
      expect(h.deps.getSquad).not.toHaveBeenCalled();
      expect(h.deps.listLiveAdapters).not.toHaveBeenCalled();
      expect(h.createPlanAtomically).not.toHaveBeenCalled();
    },
  );

  it("blocks a valid roster-bound pre-v2 receipt during upgrade/recovery", () => {
    const taskId = plannedTaskId(
      "mission-guided",
      3,
      "legacy-orchestrator-task",
    );
    const h = harness({
      existing: [
        {
          plannerId: "legacy-orchestrator-task",
          taskId,
          agentRef: "frontend",
          agentCategory: "executor",
        },
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_legacy_receipt_blocked.*roster-complete v2/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("recovers only an immutable roster-complete Guided v2 receipt", () => {
    const existing = sealedGuidedV2Receipt();
    const recovery = harness({ existing });
    const implementation = existing.find(
      (entry) => entry.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    if (!implementation) throw new Error("missing guided implementation");

    expect(
      ensureGuidedMissionPlan(recovery.suite, "mission-guided", recovery.deps),
    ).toEqual({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      topology: "delivery",
      workerAgentRef: implementation.agentRef,
      taskId: implementation.taskId,
    });
    expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("recovers delivery topology from its sealed receipt instead of reclassifying goal text", () => {
    const current = mission();
    const roundtableLikeGoal =
      "Todos os agentes devem responder o que fazem nesta missão";
    const recovery = harness({
      currentMission: {
        ...current,
        description: roundtableLikeGoal,
        intentContract: {
          ...current.intentContract!,
          goal: roundtableLikeGoal,
        },
      },
      existing: sealedGuidedV2Receipt(),
    });

    expect(
      ensureGuidedMissionPlan(
        recovery.suite,
        "mission-guided",
        recovery.deps,
      ),
    ).toMatchObject({
      applicable: true,
      sealed: false,
      reason: "already-sealed",
      topology: "delivery",
    });
    expect(recovery.deps.assertStandardSquadReadiness).toHaveBeenCalledWith(
      squad,
    );
    expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("blocks a saved squad with mixed sealed topology before any provider lookup or spawn authority", () => {
    const savedSquad: Squad = {
      ...squad,
      id: "user-squad",
      agents: squad.agents.map((agent) => ({ ...agent })),
    };
    const current = mission({
      squadId: savedSquad.id,
      intentContract: {
        ...mission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(savedSquad).hash,
      },
    });
    const existing = sealedGuidedV2Receipt().map((entry, index) => {
      const decoded = decodeTaskScheduleDetail(entry.task.detail);
      if (!decoded.meta) throw new Error("missing sealed schedule metadata");
      const detail =
        index === 0
          ? encodeTaskScheduleDetail(decoded.body, {
              ...decoded.meta,
              ownership: {
                ...decoded.meta.ownership,
                domains: [
                  ...decoded.meta.ownership.domains,
                  TEAM_READ_ONLY_FANOUT_DOMAIN,
                ],
              },
            })
          : entry.task.detail;
      return {
        ...entry,
        squadId: savedSquad.id,
        plannedDetail: detail,
        task: { ...entry.task, detail },
      };
    });
    const recovery = harness({
      currentMission: current,
      liveSquad: savedSquad,
      existing,
    });

    expect(() =>
      ensureGuidedMissionPlan(
        recovery.suite,
        "mission-guided",
        recovery.deps,
      ),
    ).toThrow(
      /guided_plan_mixed_topology_blocked.*replaneje.*reaprove/i,
    );
    expect(recovery.deps.getSquad).not.toHaveBeenCalled();
    expect(recovery.deps.assertStandardSquadReadiness).not.toHaveBeenCalled();
    expect(recovery.deps.listLiveAdapters).not.toHaveBeenCalled();
    expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "squadId",
      mutate: (entry: ReturnType<typeof sealedGuidedV2Receipt>[number]) => ({
        ...entry,
        squadId: "agentic-other-squad",
      }),
    },
    {
      label: "rosterHash",
      mutate: (entry: ReturnType<typeof sealedGuidedV2Receipt>[number]) => ({
        ...entry,
        rosterHash: "b".repeat(64),
      }),
    },
  ])(
    "rejects a recovered receipt with stale $label authority",
    ({ mutate }) => {
      const existing = sealedGuidedV2Receipt();
      const recovery = harness({
        existing: existing.map((entry, index) =>
          index === 0 ? mutate(entry) : entry,
        ),
      });

      expect(() =>
        ensureGuidedMissionPlan(
          recovery.suite,
          "mission-guided",
          recovery.deps,
        ),
      ).toThrow(
        /guided_plan_legacy_receipt_blocked.*squad\/roster atualmente aprovado/i,
      );
      expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
    },
  );

  it("rejects a sequential receipt whose Guided stages are semantically reordered", () => {
    const existing = sealedGuidedV2Receipt();
    const advisory = existing.find((entry) =>
      entry.plannerId.startsWith("guided-advisory-"),
    );
    const implementation = existing.find(
      (entry) => entry.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    const review = existing.find((entry) =>
      entry.plannerId.startsWith("guided-review-"),
    );
    const qualityGate = existing.find(
      (entry) => entry.plannerId === GUIDED_MISSION_QA_TASK_ID,
    );
    if (!advisory || !implementation || !review || !qualityGate) {
      throw new Error("missing Guided v2 stages");
    }
    const dependencies = new Map<string, readonly string[]>([
      [implementation.taskId, []],
      [review.taskId, [implementation.taskId]],
      [advisory.taskId, [review.taskId]],
      [qualityGate.taskId, [advisory.taskId]],
    ]);
    const reordered = existing.map((entry) => {
      const decoded = decodeTaskScheduleDetail(entry.task.detail);
      if (!decoded.meta) throw new Error("missing sealed schedule metadata");
      const detail = encodeTaskScheduleDetail(decoded.body, {
        ...decoded.meta,
        dependsOn: dependencies.get(entry.taskId)!,
      });
      return {
        ...entry,
        plannedDetail: detail,
        task: { ...entry.task, detail },
      };
    });
    const recovery = harness({ existing: reordered });

    expect(() =>
      ensureGuidedMissionPlan(recovery.suite, "mission-guided", recovery.deps),
    ).toThrow(
      /guided_plan_legacy_receipt_blocked.*(advisory.*raiz tip-only|implementation → independent-review|grafo Guided paralelo)/i,
    );
    expect(recovery.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("revalidates the physical worker roster before recovering an older sealed plan", () => {
    const taskId = plannedTaskId(
      "mission-guided",
      3,
      "legacy-orchestrator-task",
    );
    const h = harness({
      existing: [
        {
          plannerId: "legacy-orchestrator-task",
          taskId,
          agentRef: "frontend",
          agentCategory: "executor",
        },
      ],
    });
    vi.mocked(h.deps.assertStandardSquadReadiness).mockImplementationOnce(
      () => {
        throw new Error(
          "squad_runtime_unavailable:worker-unavailable: Aider sem handoff físico",
        );
      },
    );

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/worker-unavailable.*Aider.*handoff físico/i);
    expect(h.deps.assertStandardSquadReadiness).toHaveBeenCalledWith(squad);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("builds explicit ownership without root wildcards or Nexus authority paths", () => {
    const claims = repositoryOwnershipClaimsFromGitTree([
      ".",
      "*",
      ".context",
      ".context/contract.json",
      ".git",
      ".nexus",
      ".env",
      "PRODUCT.md",
      "src",
      "packages",
      "custom.config.ts",
    ]);

    expect(claims).toEqual(
      expect.arrayContaining(["src", "packages", "custom.config.ts"]),
    );
    expect(claims).not.toEqual(
      expect.arrayContaining([
        ".",
        "*",
        ".context",
        ".context/contract.json",
        ".git",
        ".nexus",
        ".env",
        "PRODUCT.md",
      ]),
    );
  });

  it("bounds every Git inventory probe through the hardened runner", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-inventory-runner-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      fs.writeFileSync(path.join(rootRealPath, "placeholder.txt"), "x");
      const run = vi.fn(
        (cwd: string, args: readonly string[], options?: GitRunOptions) => {
          expect(cwd).toBe(rootRealPath);
          expect(options?.timeoutMs).toBe(30_000);
          if (args[0] === "rev-parse") {
            return { status: 0, stdout: "true\n", stderr: "" };
          }
          if (args[0] === "ls-tree") {
            return { status: 0, stdout: "src\0package.json\0", stderr: "" };
          }
          throw new Error(`unexpected Git command: ${args.join(" ")}`);
        },
      );
      const git: GitRunner = { run };

      const claims = listRepositoryOwnershipClaims(
        testProjectScope({ rootRealPath }),
        git,
      );

      expect(claims).toEqual(expect.arrayContaining(["src", "package.json"]));
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls.flatMap((call) => call[1])).not.toContain("-C");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("seals a safe greenfield inventory for a physically empty folder", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-empty-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      const claims = listRepositoryOwnershipClaims(
        testProjectScope({ rootRealPath }),
      );

      expect(claims).toEqual(
        expect.arrayContaining([
          "package.json",
          "src",
          "tests",
          "index.html",
          "eslint.config.js",
          "next.config.ts",
          "postcss.config.mjs",
          "components.json",
        ]),
      );
      expect(claims).not.toContain(".");
      expect(claims).not.toContain("*");

      // Autopilot = delivery + post-review. Length 4 was Hardened roster.
      const h = harness();
      const deps: GuidedMissionPlannerDeps = {
        ...h.deps,
        listRepositoryOwnership: () => claims,
      };
      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", deps),
      ).toMatchObject({ applicable: true, sealed: true });
      expect(h.createPlanAtomically.mock.calls[0]![0].rows).toHaveLength(2);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

});
