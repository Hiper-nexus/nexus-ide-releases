import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Handoff, Mission, Squad } from "../../shared/orch-types";
import { compileIntentContract } from "../../shared/mission-intent";
import {
  decodeTaskScheduleDetail,
} from "./mission-scheduler-meta";
import { finalizeGuidedNoChangeQualityGate } from "./mission-scheduler-production";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import { plannedTaskId } from "./task-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import {
  ensureGuidedMissionPlan,
  approvedIntentRequiresReadOnlyQualityGate,
  GUIDED_MISSION_PLANNER_TASK_ID,
  GUIDED_MISSION_QA_TASK_ID,
  repositoryOwnershipClaimsFromGitTree,
  type GuidedMissionPlannerDeps,
} from "./guided-mission-planner";
import {
  WorktreeManager,
} from "../runtime/worktree-manager";
import { selectPhysicalPlanHandoff } from "./plan-promotion-authority";
import {
  MemoryWorktreeStateStore,
  denseUiMission,
  harness,
  liveAdapter,
  mission,
  missionForSquad,
  squad,
  squadWithAgentCli,
} from "./guided-mission-planner-test-harness";
import { testProjectScope } from "./__tests__/scope-fixture";

describe("Guided Planner v2", () => {
  it("honors an explicit natural-language QA read-only constraint", () => {
    const base = compileIntentContract({
      goal:
        "Crie resultado.txt. O executor deve editar e commitar; a revisão " +
        "independente e o QA devem validar de forma somente leitura.",
      acceptanceCriteria: ["resultado.txt validado"],
      intentVersion: 3,
      source: "typed",
      lane: "standard",
    });
    const currentMission = mission({
      description: base.goal,
      intentContract: {
        ...base,
        approvedAt: 10,
        dispatchedAt: 10,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    });
    expect(
      approvedIntentRequiresReadOnlyQualityGate(currentMission),
    ).toBe(true);
    const h = harness({ currentMission, squadCliPolicy: "governed" });

    expect(
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const qa = decodeTaskScheduleDetail(
      rows.find(
        (row) => row.plannerId === GUIDED_MISSION_QA_TASK_ID,
      )!.detail,
    );
    const review = decodeTaskScheduleDetail(
      rows.find((row) => row.agentRef === "reviewer")!.detail,
    );

    expect(qa.meta).toMatchObject({
      agentRef: "qa",
      agentCategory: "reviewer",
      executionMode: "read_only",
      ownership: {
        domains: ["guided-quality-gate", "sequential-only"],
      },
    });
    expect(qa.body).toContain(
      "gate final independente e mecanicamente somente leitura",
    );
    expect(qa.body).toContain(
      "não o corrija: envie handoff blocked",
    );
    expect(qa.body).not.toContain("Faça commit");
    expect(review.body).toContain(
      "QA final também será mecanicamente read-only",
    );
  });

  it("uses the combined sealed-detail budget instead of a smaller prompt-only cap", () => {
    const h = harness({ currentMission: denseUiMission() });

    expect(
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const implementation = rows.find(
      (row) => row.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    if (!implementation) throw new Error("missing guided implementation");
    expect(
      decodeTaskScheduleDetail(implementation.detail).body.length,
    ).toBeGreaterThan(60_000);
    expect(rows.every((row) => row.detail.length <= 65_536)).toBe(true);
  });

  it("ignores repository inventory size when sealing mutation ownership", () => {
    const h = harness({ currentMission: denseUiMission() });
    const ownership = repositoryOwnershipClaimsFromGitTree(
      Array.from(
        { length: 400 },
        (_, index) =>
          `tracked-root-${String(index).padStart(4, "0")}-${"x".repeat(35)}.txt`,
      ),
    );
    vi.mocked(h.deps.listRepositoryOwnership).mockReturnValue(ownership);

    expect(
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toMatchObject({ applicable: true, sealed: true });
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    const implementation = rows.find(
      (row) => row.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    if (!implementation) throw new Error("missing guided implementation");
    const sealed = decodeTaskScheduleDetail(implementation.detail).meta?.ownership;
    expect(sealed?.files).toContain("ui-panel.tsx");
    expect(sealed?.files.some((file) => file.startsWith("tracked-root-"))).toBe(
      false,
    );
  });

  it("seals a roster-complete Guided v2 graph for the promoted builtin delivery squad", () => {
    const promotedSquad: Squad = {
      ...squad,
      id: "nexus-story-impl",
      builtin: true,
      agents: squad.agents.map((agent) => ({ ...agent })),
    };
    const base = mission();
    const planContract = compileIntentContract({
      goal: base.intentContract!.goal,
      acceptanceCriteria: [...base.intentContract!.acceptanceCriteria],
      intentVersion: 2,
      source: "typed",
      lane: "plan",
    });
    const planMission: Mission = {
      ...base,
      intentVersion: 2,
      orchestratorSessionId: "session-plan-v2",
      intentContract: {
        ...planContract,
        approvedAt: 2,
        dispatchedAt: 2,
      },
    };
    const planHandoff: Handoff = {
      id: "handoff-plan-v2",
      missionId: planMission.id,
      sessionId: "session-plan-v2",
      fromAgent: "Maestro",
      authorityOrigin: "agent",
      mcpProvenance: {
        receiptId: "receipt-plan-v2",
        toolCallId: "tool-plan-v2",
        toolName: "nexus_handoff_submit",
        source: "http-mcp",
        authoritySha256: "a".repeat(64),
        missionId: planMission.id,
        sessionId: "session-plan-v2",
        issuedAt: 2,
      },
      status: "success",
      summary: "# PRD aprovado\nEntregar o sistema completo.",
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: "unverified",
      claimTrust: "untrusted",
      delivered: true,
      deliveryState: "submitted",
      submittedAt: 2,
      createdAt: 2,
    };
    const promotedPlan = selectPhysicalPlanHandoff({
      mission: planMission,
      handoffs: {
        list: () => [planHandoff],
        get: () => planHandoff,
      },
    });
    const promoted = mission({
      squadId: promotedSquad.id,
      intentContract: {
        ...base.intentContract!,
        squadRevisionHash: snapshotSquadAuthority(promotedSquad).hash,
        promotedPlan,
      },
    });
    const h = harness({
      currentMission: promoted,
      liveSquad: promotedSquad,
      squadCliPolicy: "governed",
    });

    const result = ensureGuidedMissionPlan(h.suite, promoted.id, h.deps);

    expect(result).toMatchObject({
      applicable: true,
      sealed: true,
      reason: "sealed",
    });
    expect(h.deps.assertStandardSquadReadiness).toHaveBeenCalledWith(
      promotedSquad,
    );
    const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
    expect(rows).toHaveLength(
      promotedSquad.agents.filter((agent) => agent.category !== "orchestrator")
        .length,
    );
    expect(new Set(rows.map((row) => row.agentRef))).toEqual(
      new Set(
        promotedSquad.agents
          .filter((agent) => agent.category !== "orchestrator")
          .map((agent) => agent.id),
      ),
    );
    expect(rows.every((row) => decodeTaskScheduleDetail(row.detail).meta)).toBe(
      true,
    );
  });

  it("carries the sealed executor → QA contract through real worktrees and a physical no-change receipt", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-wave-e2e-"),
    );
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-wave-runtime-"),
    );
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      git(rootRealPath, "init", "--quiet");
      git(rootRealPath, "symbolic-ref", "HEAD", "refs/heads/main");
      git(rootRealPath, "config", "user.name", "Nexus Test");
      git(rootRealPath, "config", "user.email", "nexus@example.test");
      fs.writeFileSync(path.join(rootRealPath, "app.txt"), "base\n");
      git(rootRealPath, "add", "app.txt");
      git(rootRealPath, "commit", "--quiet", "-m", "baseline");

      const waveSquad: Squad = {
        ...squad,
        agents: squad.agents.filter((agent) =>
          ["orch", "generalist", "qa"].includes(agent.id),
        ),
      };
      const waveBase = compileIntentContract({
        goal: "Atualize `app.txt` com a entrega guiada",
        acceptanceCriteria: ["app.txt atualizado"],
        intentVersion: 3,
        source: "typed",
        lane: "standard",
      });
      const waveMission = mission({
        description: waveBase.goal,
        intentContract: {
          ...waveBase,
          approvedAt: 10,
          dispatchedAt: 10,
          squadRevisionHash: snapshotSquadAuthority(waveSquad).hash,
        },
      });
      const h = harness({
        currentMission: waveMission,
        liveSquad: waveSquad,
        squadCliPolicy: "governed",
      });
      const deps: GuidedMissionPlannerDeps = {
        ...h.deps,
        listRepositoryOwnership: () => ["app.txt"],
      };
      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", deps),
      ).toMatchObject({ applicable: true, sealed: true });
      const rows = h.createPlanAtomically.mock.calls[0]![0].rows;
      const execution = decodeTaskScheduleDetail(rows[0]!.detail);
      const qualityGate = decodeTaskScheduleDetail(rows[1]!.detail);
      if (!execution.meta || !qualityGate.meta) {
        throw new Error("guided plan rows must carry sealed schedule metadata");
      }
      const executionMeta = execution.meta;
      const qualityGateMeta = qualityGate.meta;
      const executionTaskId = plannedTaskId(
        "mission-guided",
        3,
        GUIDED_MISSION_PLANNER_TASK_ID,
      );
      const qualityGateTaskId = plannedTaskId(
        "mission-guided",
        3,
        GUIDED_MISSION_QA_TASK_ID,
      );
      expect(qualityGateMeta.dependsOn).toEqual([executionTaskId]);

      const actualScope = testProjectScope({ rootRealPath });
      const manager = new WorktreeManager({
        runtimeRoot,
        stateStore: new MemoryWorktreeStateStore(),
        now: () => 10,
      });
      const executionAgent = squad.agents.find(
        (agent) => agent.id === executionMeta.agentRef,
      )!;
      const executorWorktree = await manager.create({
        scope: actualScope,
        missionId: "mission-guided",
        taskId: executionTaskId,
        workerId: executionAgent.agentName,
        ownership: executionMeta.ownership,
      });
      fs.writeFileSync(
        path.join(executorWorktree.worktreePath, "app.txt"),
        "implemented\n",
      );
      git(executorWorktree.worktreePath, "add", "app.txt");
      git(
        executorWorktree.worktreePath,
        "commit",
        "--quiet",
        "-m",
        "implement guided goal",
      );
      const preparedExecution = manager.prepareIntegration(
        actualScope,
        "mission-guided",
        executionTaskId,
      );
      manager.markQueued(
        actualScope,
        "mission-guided",
        executionTaskId,
        preparedExecution.taskHeadSha,
      );
      git(rootRealPath, "cherry-pick", preparedExecution.taskHeadSha);
      manager.markIntegrated(
        actualScope,
        "mission-guided",
        executionTaskId,
        git(rootRealPath, "rev-parse", "HEAD"),
      );

      const qualityAgent = squad.agents.find(
        (agent) => agent.id === qualityGateMeta.agentRef,
      )!;
      const qaWorktree = await manager.create({
        scope: actualScope,
        missionId: "mission-guided",
        taskId: qualityGateTaskId,
        workerId: qualityAgent.agentName,
        ownership: qualityGateMeta.ownership,
        dependsOn: qualityGateMeta.dependsOn.map((taskId) => ({
          missionId: "mission-guided",
          taskId,
        })),
      });
      const handoffReady: TaskDispatchRecord = {
        id: "dispatch-guided-quality-gate",
        taskId: qualityGateTaskId,
        missionId: "mission-guided",
        intentVersion: 3,
        revision: 4,
        attempt: 1,
        state: "handoff_ready",
        leaseOwner: "main",
        leaseExpiresAt: 1_000,
        workerId: qualityAgent.agentName,
        workerIncarnationId: "worker-incarnation-qa",
        ownership: qualityGateMeta.ownership,
        executionMode: "isolated_worktree",
        agentRef: qualityGateMeta.agentRef,
        agentCategory: qualityGateMeta.agentCategory,
        paneId: "pane-qa",
        sessionId: "session-qa",
        handoffId: "handoff-qa",
        projectId: actualScope.projectId,
        checkoutId: actualScope.checkoutId,
        createdAt: 1,
        updatedAt: 2,
      };
      const mergingDispatch: TaskDispatchRecord = {
        ...handoffReady,
        state: "merging",
        revision: handoffReady.revision + 1,
      };
      const complete = vi.fn();

      await expect(
        finalizeGuidedNoChangeQualityGate(
          {
            scope: actualScope,
            missionId: "mission-guided",
            taskId: qualityGateTaskId,
            dispatch: handoffReady,
          },
          {
            prepare: () =>
              manager.prepareNoChangeValidation(
                actualScope,
                "mission-guided",
                qualityGateTaskId,
              ),
            beginMerge: () => mergingDispatch,
            assertAuthority: () => mergingDispatch,
            validate: (context) => {
              expect(context).toMatchObject({
                checkoutPath: qaWorktree.worktreePath,
                integrationBaseSha: qaWorktree.baseSha,
                taskHeadSha: qaWorktree.baseSha,
                changedFiles: [],
              });
              return {
                sensorsPassed: true,
                reviewPassed: true,
                evidenceIds: ["sensor:guided-e2e", "review:guided-e2e"],
              };
            },
            markValidated: (prepared) => {
              manager.markValidatedNoChange(
                actualScope,
                "mission-guided",
                qualityGateTaskId,
                prepared.taskHeadSha,
                prepared.integrationHeadSha,
              );
            },
            complete,
            now: () => 42,
          },
        ),
      ).resolves.toBe(true);

      expect(
        manager.get(actualScope, "mission-guided", qualityGateTaskId),
      ).toMatchObject({
        status: "integrated",
        taskHeadSha: qaWorktree.baseSha,
        integratedSha: qaWorktree.baseSha,
      });
      expect(complete).toHaveBeenCalledWith(
        mergingDispatch.revision,
        expect.objectContaining({
          kind: "worktree_validated_no_change",
          reference: expect.stringMatching(
            /^no-change:[a-f0-9]{40,64}:[a-f0-9]{64}$/,
          ),
          evidenceIds: ["sensor:guided-e2e", "review:guided-e2e"],
        }),
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("fails closed instead of silently omitting an approved worker whose CLI is unavailable", () => {
    const liveSquad = squadWithAgentCli("generalist", "agy");
    const h = harness({
      currentMission: missionForSquad(liveSquad),
      liveSquad,
      adapters: [
        liveAdapter("codex"),
        liveAdapter("agy", false),
        liveAdapter("glm"),
        liveAdapter("claude"),
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable.*generalist\/agy/i);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("fails closed without a task receipt when no approved executor route is live", () => {
    const h = harness({
      adapters: [
        liveAdapter("codex", false),
        liveAdapter("glm"),
        liveAdapter("claude"),
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable/);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

  it("fails closed before persistence when the approved QA/reviewer route is unavailable", () => {
    const h = harness({
      adapters: [
        liveAdapter("codex", false),
        liveAdapter("glm", false),
        liveAdapter("claude"),
      ],
    });

    expect(() =>
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toThrow(/guided_plan_roster_route_unavailable/);
    expect(h.createPlanAtomically).not.toHaveBeenCalled();
  });

});
