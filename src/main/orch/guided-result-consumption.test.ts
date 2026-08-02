import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import type { SquadAgent } from "../../shared/orch-types";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { compileMissionContract } from "../context/contract-compiler";
import { createContextWorkflowStore } from "../context/context-workflow-store";
import { createWorkflowState } from "../context/prevc-engine";
import { ReviewCouncil } from "../context/review-council";
import { testProjectScope } from "./__tests__/scope-fixture";
import { createScopedHandoffStore } from "./handoff-store";
import { applyDriveAction } from "./mission-driver-apply";
import { createProductionApplyPorts } from "./mission-driver-io";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import { createScopedMissionStore } from "./mission-store";
import {
  buildMissionSchedulerTaskPrompt,
  loadMissionSchedulerDependencyHandoffs,
} from "./mission-scheduler-production";
import {
  decodeTaskScheduleDetail,
  encodeTaskScheduleDetail,
} from "./mission-scheduler-meta";
import { EMPTY_GIT_DIFF_SHA256 } from "./task-dispatch-codec";
import { createTaskDispatchStore } from "./task-dispatch-store";
import { createScopedTaskStore, plannedTaskId } from "./task-store";

let baseDir = "";
const managers: ProjectRuntimeManager[] = [];
const GUIDED_SQUAD_ID =
  "agentic-runtime-00000000-0000-4000-8000-000000000001";

function repositoryHead(): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guided-consumption-"));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function manager(): ProjectRuntimeManager {
  const runtime = new ProjectRuntimeManager({
    baseDir,
    appVersion: "0.19.31-test",
  });
  managers.push(runtime);
  return runtime;
}

describe("guided result consumption chain", () => {
  it("carries advisory→executor→review→QA results and leaves final completion to the PREVC-backed Driver", async () => {
    const runtime = manager();
    const scope = testProjectScope({ rootRealPath: process.cwd() });
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const intentVersion = 9;
    const orchestratorSessionId = "orchestrator-guided-consumption";
    const contract = {
      ...compileIntentContract({
        goal: "Entregar o fluxo guiado completo com revisão independente",
        intentVersion,
      }),
      approvedAt: 1,
      dispatchedAt: 1,
    };
    const roster: SquadAgent[] = [
      {
        id: "advisor",
        agentName: "Arquiteto consultivo",
        category: "architect",
        cli: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      {
        id: "executor",
        agentName: "Executor principal",
        category: "executor",
        cli: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      {
        id: "reviewer",
        agentName: "Reviewer independente",
        category: "reviewer",
        cli: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      {
        id: "qa",
        agentName: "QA corretivo",
        category: "reviewer",
        cli: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    ];
    const mission = missions.create({
      title: "Guided result chain",
      squadId: GUIDED_SQUAD_ID,
      intentVersion,
      intentState: "executing",
      intentContract: contract,
      orchestratorSessionId,
    });
    missions.setStatus(mission.id, "running");
    const qualityHeadSha = repositoryHead();
    const qualityContract = compileMissionContract(
      {
        schemaVersion: 1,
        scope,
        missionId: mission.id,
        baseCommit: qualityHeadSha,
        contextRevision: createHash("sha256")
          .update("guided-result-consumption-context")
          .digest("hex"),
        goal: "Validar cada candidato integrado do fluxo guiado",
        acceptanceCriteria: [
          {
            id: "independent-review",
            statement: "Cada candidato integrado recebe revisão independente.",
          },
        ],
      },
      {
        invariantRefs: new Set(),
        availableSensorIds: new Set(),
        blockingConflictIds: [],
      },
    );
    const qualityBinding = {
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      missionId: mission.id,
      contractHash: qualityContract.contractHash,
      contextHash: qualityContract.contextRevision,
      baseSha: qualityHeadSha,
      headSha: qualityHeadSha,
      diffHash: EMPTY_GIT_DIFF_SHA256,
    };
    const qualityStore = createContextWorkflowStore(runtime, scope);
    qualityStore.freeze(
      qualityContract,
      createWorkflowState(qualityContract.risk, qualityBinding),
      {
        id: "author-guided-result",
        sessionId: "session-author-guided-result",
        provider: "codex",
      },
    );
    const advisoryTaskId = plannedTaskId(
      mission.id,
      intentVersion,
      "guided-advisory",
    );
    const executorTaskId = plannedTaskId(
      mission.id,
      intentVersion,
      "guided-execution",
    );
    const reviewTaskId = plannedTaskId(
      mission.id,
      intentVersion,
      "guided-review",
    );
    const qaTaskId = plannedTaskId(
      mission.id,
      intentVersion,
      "guided-quality-gate",
    );
    const ownership = {
      files: ["src"],
      symbols: [] as string[],
      domains: ["sequential-only"],
    };
    const planned = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion,
      squad: { id: GUIDED_SQUAD_ID, agents: roster },
      rows: [
        {
          plannerId: "guided-advisory",
          title: "Mapear riscos",
          detail: encodeTaskScheduleDetail("Mapeie riscos concretos.", {
            dependsOn: [],
            ownership: {
              ...ownership,
              domains: ["guided-advisory", "sequential-only"],
            },
            merged: false,
            agentRef: "advisor",
            agentCategory: "architect",
            executionMode: "read_only",
          }),
          agentRef: "advisor",
          agentCategory: "architect",
        },
        {
          plannerId: "guided-execution",
          title: "Implementar",
          detail: encodeTaskScheduleDetail("Implemente os critérios.", {
            dependsOn: [advisoryTaskId],
            ownership: {
              ...ownership,
              domains: ["guided-implementation", "sequential-only"],
            },
            merged: false,
            agentRef: "executor",
            agentCategory: "executor",
            executionMode: "isolated_worktree",
          }),
          agentRef: "executor",
          agentCategory: "executor",
        },
        {
          plannerId: "guided-review",
          title: "Revisar",
          detail: encodeTaskScheduleDetail("Revise a implementação.", {
            dependsOn: [executorTaskId],
            ownership: {
              ...ownership,
              domains: ["guided-independent-review", "sequential-only"],
            },
            merged: false,
            agentRef: "reviewer",
            agentCategory: "reviewer",
            executionMode: "read_only",
          }),
          agentRef: "reviewer",
          agentCategory: "reviewer",
        },
        {
          plannerId: "guided-quality-gate",
          title: "Validar e corrigir",
          detail: encodeTaskScheduleDetail("Valide a entrega final.", {
            dependsOn: [reviewTaskId],
            ownership: {
              ...ownership,
              domains: ["guided-quality-gate", "sequential-only"],
            },
            merged: false,
            agentRef: "qa",
            agentCategory: "reviewer",
            executionMode: "isolated_worktree",
          }),
          agentRef: "qa",
          agentCategory: "reviewer",
        },
      ],
    });
    expect(planned.map((task) => task.id)).toEqual([
      advisoryTaskId,
      executorTaskId,
      reviewTaskId,
      qaTaskId,
    ]);
    const planReceipt = tasks.getPlanReceipt(mission.id, intentVersion)!;
    const tasksById = new Map(planned.map((task) => [task.id, task]));
    const agentsById = new Map(roster.map((agent) => [agent.id, agent]));

    const startTask = (taskId: string) => {
      const task = tasksById.get(taskId)!;
      const schedule = decodeTaskScheduleDetail(task.detail).meta!;
      const agent = agentsById.get(schedule.agentRef!)!;
      const route = missions.reserveRouteDecision(mission.id, task.title, {
        tier: "hard",
        adapterId: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        reason: "rota exata do roster guiado selado",
        alternatives: [],
      });
      const claim = dispatches.claim({
        missionId: mission.id,
        taskId,
        intentVersion,
        workerId: agent.agentName,
        leaseOwner: "main",
        leaseMs: 30_000,
        ownership: schedule.ownership,
        executionMode: schedule.executionMode!,
        agentRef: agent.id,
        agentCategory: agent.category as
          "executor" | "reviewer" | "scout" | "architect",
        rosterHash: planReceipt.rosterHash,
        routeContract: {
          adapterId: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
        },
      });
      const routed = dispatches.attachRoute({
        taskId,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
        routeReservationId: route.id,
        adapterId: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      });
      missions.consumeRouteReservation(
        {
          reservationId: route.id,
          missionId: mission.id,
          adapterId: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
        },
        `dispatch:${claim.id}`,
      );
      const sessionId = `session-${agent.id}`;
      const bound = dispatches.bindSpawn({
        taskId,
        revision: routed.revision,
        leaseToken: claim.leaseToken,
        workerIncarnationId: claim.workerIncarnationId,
        paneId: `pane-${agent.id}`,
        sessionId,
      });
      return { task, schedule, agent, claim, bound, sessionId };
    };

    let physicalReceipt = 0;
    const finishTask = (
      started: ReturnType<typeof startTask>,
      summary: string,
    ) => {
      const handoff = handoffs.submit({
        missionId: mission.id,
        sessionId: started.sessionId,
        workerIncarnationId: started.claim.workerIncarnationId,
        fromAgent: started.agent.agentName,
        status: "success",
        summary,
      });
      const receiptId = `physical-guided-${++physicalReceipt}`;
      const db = runtime.open(scope).db;
      const handoffCreatedAt = (
        db
          .prepare(`SELECT created_at FROM handoffs WHERE id = ?`)
          .get(handoff.id) as { created_at: number }
      ).created_at;
      const auditIntentOccurredAt = handoffCreatedAt - 2;
      const physicalIssuedAt = handoffCreatedAt - 1;
      db.prepare(
        `INSERT INTO audit_events
           (id, mission_id, actor, action, outcome, payload_json, occurred_at)
         VALUES (?, ?, ?, 'nexus_handoff_submit', 'intent', ?, ?)`,
      ).run(
        `audit-${receiptId}`,
        mission.id,
        started.sessionId,
        JSON.stringify({
          schema: "nexus.mcp-audit/v1",
          timestamp: new Date(auditIntentOccurredAt).toISOString(),
          project_id: scope.projectId,
          checkout_id: scope.checkoutId,
          source: "http-mcp",
          invocation_id: receiptId,
          args: {},
          duration_ms: 0,
          user_authorized: false,
        }),
        auditIntentOccurredAt,
      );
      db.prepare(
        `INSERT INTO handoff_mcp_receipts
             (receipt_id, handoff_id, tool_call_id, tool_name, source,
              mission_id, session_id, worker_incarnation_id,
              authority_sha256, worktree_head_sha, issued_at)
           VALUES (?, ?, ?, 'nexus_handoff_submit', 'http-mcp',
                   ?, ?, ?, ?, ?, ?)`,
      ).run(
        receiptId,
        handoff.id,
        receiptId,
        mission.id,
        started.sessionId,
        started.claim.workerIncarnationId,
        createHash("sha256").update(receiptId).digest("hex"),
        repositoryHead(),
        physicalIssuedAt,
      );
      const ready = dispatches.acceptHandoff({
        sessionId: started.sessionId,
        workerIncarnationId: started.claim.workerIncarnationId,
        handoffId: handoff.id,
      });
      if (started.schedule.executionMode === "read_only") {
        dispatches.completeReadOnlyFromTrustedHandoff({
          taskId: started.task.id,
          revision: ready.revision,
        });
      } else {
        const reviewId = `quality-${physicalReceipt}`;
        const review = new ReviewCouncil(
          qualityContract.risk,
          qualityBinding,
        ).submit({
          reviewId,
          reviewerId: `independent-${started.agent.id}`,
          reviewerSessionId: `session-independent-${started.agent.id}`,
          reviewerProvider: "codex",
          authorId: `author-${started.agent.id}`,
          authorSessionId: started.sessionId,
          authorProvider: "codex",
          binding: qualityBinding,
          findings: [],
        });
        qualityStore.recordMergeReviewReport(review);
        dispatches.completeByCoordinator({
          taskId: started.task.id,
          revision: ready.revision,
          receipt: {
            kind: "worktree_integrated",
            reference: repositoryHead(),
            completedAt: Date.now(),
            evidenceIds: [`review:${reviewId}`],
          },
        });
      }
      const attempt = handoffs.reserveDeliveryAttempt({
        handoffId: handoff.id,
        missionId: mission.id,
        orchestratorSessionId,
        maxAttempts: 2,
      });
      handoffs.markDeliveryAttemptPasted({
        attemptId: attempt.id,
        handoffId: handoff.id,
        acceptDeadlineAt: Date.now() + 10_000,
      });
      expect(
        handoffs.acceptDeliveryAttempt({
          attemptId: attempt.id,
          handoffId: handoff.id,
        }),
      ).toBe(true);
      return { handoff, attempt };
    };

    const dependencyPrompt = (started: ReturnType<typeof startTask>) => {
      const dependencyHandoffs = loadMissionSchedulerDependencyHandoffs({
        missionId: mission.id,
        dependsOn: started.schedule.dependsOn,
        stores: { taskDispatches: dispatches, handoffs },
      });
      const prompt = buildMissionSchedulerTaskPrompt(
        {
          id: started.task.id,
          title: started.task.title,
          detail: decodeTaskScheduleDetail(started.task.detail).body,
          status: "pending",
          dependsOn: started.schedule.dependsOn,
          ownership: started.schedule.ownership,
          merged: false,
          parallelEligible: false,
        },
        {
          agentName: started.agent.agentName,
          category: started.agent.category,
          executionMode: started.schedule.executionMode!,
        },
        dependencyHandoffs,
      );
      return {
        prompt,
        input: {
          taskId: started.task.id,
          revision: started.bound.revision,
          leaseToken: started.claim.leaseToken,
          sessionId: started.sessionId,
          workerIncarnationId: started.claim.workerIncarnationId,
          acceptedPrompt: prompt,
          dependencies: dependencyHandoffs.map((dependency) => ({
            taskId: dependency.taskId,
            handoffId: dependency.handoffId,
            summary: dependency.summary,
            summarySha256: dependency.summarySha256,
          })),
        },
      };
    };

    const feedDependencies = (started: ReturnType<typeof startTask>) => {
      const prepared = dependencyPrompt(started);
      const { prompt } = prepared;
      if (started.task.id === executorTaskId) {
        expect(() =>
          dispatches.recordDependencyPromptConsumption({
            ...prepared.input,
            dependencies: prepared.input.dependencies.map((dependency) => ({
              ...dependency,
              summarySha256: "0".repeat(64),
            })),
          }),
        ).toThrow(/summary changed/i);
        expect(() =>
          dispatches.recordDependencyPromptConsumption({
            ...prepared.input,
            acceptedPrompt: "Prompt aceito sem o resultado predecessor.",
          }),
        ).toThrow(/prompt omitted/i);
      }
      dispatches.recordDependencyPromptConsumption(prepared.input);
      return prompt;
    };

    const advisory = startTask(advisoryTaskId);
    const advisoryResult = finishTask(
      advisory,
      "Risco advisory: preserve o contrato de autenticação em src/auth.ts.",
    );
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        advisoryResult.handoff.id,
        mission.id,
        orchestratorSessionId,
      ),
    ).toBe(true);

    const executor = startTask(executorTaskId);
    const tamperDb = runtime.open(scope).db;
    const executorBody = decodeTaskScheduleDetail(executor.task.detail).body;
    tamperDb.prepare(`UPDATE tasks SET detail = ? WHERE id = ?`).run(
      encodeTaskScheduleDetail(executorBody, {
        ...executor.schedule,
        dependsOn: [],
      }),
      executor.task.id,
    );
    expect(() =>
      dispatches.recordDependencyPromptConsumption(
        dependencyPrompt(executor).input,
      ),
    ).toThrow(/sealed task projection/i);
    tamperDb
      .prepare(`UPDATE tasks SET detail = ? WHERE id = ?`)
      .run(executor.task.detail, executor.task.id);

    tamperDb
      .prepare(
        `UPDATE task_dispatch_queue SET ownership_json = ? WHERE task_id = ?`,
      )
      .run(
        JSON.stringify({ files: [], symbols: [], domains: [] }),
        executor.task.id,
      );
    expect(() =>
      dispatches.recordDependencyPromptConsumption(
        dependencyPrompt(executor).input,
      ),
    ).toThrow(/sealed task dispatch contract/i);
    tamperDb
      .prepare(
        `UPDATE task_dispatch_queue SET ownership_json = ? WHERE task_id = ?`,
      )
      .run(JSON.stringify(executor.schedule.ownership), executor.task.id);

    const executorPrompt = feedDependencies(executor);
    expect(executorPrompt).toContain(
      "Risco advisory: preserve o contrato de autenticação",
    );
    const executorReplay = dependencyPrompt(executor).input;
    const replayDb = runtime.open(scope).db;
    const predecessorAudit = replayDb
      .prepare(
        `SELECT id, mission_id, actor, action, outcome, payload_json,
                occurred_at
         FROM audit_events
         WHERE mission_id = ? AND actor = ?
           AND action = 'nexus_handoff_submit' AND outcome = 'intent'`,
      )
      .get(mission.id, advisory.sessionId) as {
      id: string;
      mission_id: string;
      actor: string;
      action: string;
      outcome: string;
      payload_json: string;
      occurred_at: number;
    };
    replayDb
      .prepare(`DELETE FROM audit_events WHERE id = ?`)
      .run(predecessorAudit.id);
    expect(() =>
      dispatches.recordDependencyPromptConsumption(executorReplay),
    ).toThrow(/audited physical authority/i);
    replayDb
      .prepare(
        `INSERT INTO audit_events
           (id, mission_id, actor, action, outcome, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        predecessorAudit.id,
        predecessorAudit.mission_id,
        predecessorAudit.actor,
        predecessorAudit.action,
        predecessorAudit.outcome,
        predecessorAudit.payload_json,
        predecessorAudit.occurred_at,
      );
    expect(() =>
      dispatches.recordDependencyPromptConsumption(executorReplay),
    ).not.toThrow();
    const executorResult = finishTask(
      executor,
      "Executor aplicou a correção de autenticação e deixou os testes verdes.",
    );
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        executorResult.handoff.id,
        mission.id,
        orchestratorSessionId,
      ),
    ).toBe(true);

    const reviewer = startTask(reviewTaskId);
    const lateReviewerConsumption = dependencyPrompt(reviewer);
    const reviewerPrompt = lateReviewerConsumption.prompt;
    expect(reviewerPrompt).toContain(
      "Executor aplicou a correção de autenticação",
    );
    const reviewerResult = finishTask(
      reviewer,
      "Review independente confirmou a correção e pediu validação de regressão.",
    );
    // A real provider can submit its handoff before the async prompt observer
    // calls back. The exact terminal handoff must recover that race without
    // losing the immutable predecessor-consumption receipt.
    expect(() =>
      dispatches.recordDependencyPromptConsumption(
        lateReviewerConsumption.input,
      ),
    ).not.toThrow();
    const lateReceipt = runtime
      .open(scope)
      .db.prepare(
        `SELECT receipt.consumed_at, dispatch.handoff_accepted_at,
                physical.issued_at, audit.occurred_at AS audit_intent_occurred_at
           FROM task_dependency_consumption_receipts AS receipt
           JOIN task_dispatch_queue AS dispatch
             ON dispatch.task_id = receipt.consumer_task_id
           JOIN handoff_mcp_receipts AS physical
             ON physical.handoff_id = dispatch.handoff_id
           JOIN audit_events AS audit
             ON audit.id = 'audit-' || physical.receipt_id
          WHERE receipt.consumer_task_id = ?`,
      )
      .get(reviewTaskId) as {
      consumed_at: number;
      handoff_accepted_at: number;
      issued_at: number;
      audit_intent_occurred_at: number;
    };
    expect(lateReceipt.consumed_at).toBe(
      lateReceipt.audit_intent_occurred_at,
    );
    expect(lateReceipt.consumed_at).toBeLessThan(lateReceipt.issued_at);
    expect(lateReceipt.consumed_at).toBeLessThanOrEqual(
      lateReceipt.handoff_accepted_at,
    );
    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        reviewerResult.handoff.id,
        mission.id,
        orchestratorSessionId,
      ),
    ).toBe(true);

    const qa = startTask(qaTaskId);
    const qaPrompt = feedDependencies(qa);
    expect(qaPrompt).toContain("Review independente confirmou a correção");
    const qaResult = finishTask(
      qa,
      "QA repetiu testes, typecheck e validação de regressão; entrega aprovada.",
    );

    const db = runtime.open(scope).db;
    expect(
      db
        .prepare(
          `SELECT consumer_task_id, dependency_task_id, handoff_id,
                  prompt_sha256, handoff_summary_sha256
           FROM task_dependency_consumption_receipts
           ORDER BY consumed_at, consumer_task_id`,
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer_task_id: executorTaskId,
          dependency_task_id: advisoryTaskId,
          handoff_id: advisoryResult.handoff.id,
        }),
        expect.objectContaining({
          consumer_task_id: reviewTaskId,
          dependency_task_id: executorTaskId,
          handoff_id: executorResult.handoff.id,
        }),
        expect.objectContaining({
          consumer_task_id: qaTaskId,
          dependency_task_id: reviewTaskId,
          handoff_id: reviewerResult.handoff.id,
        }),
      ]),
    );

    // The old bulk ACK projection is deliberately insufficient.
    expect(handoffs.acknowledgeMission(mission.id)).toBe(1);
    expect(
      dispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion,
      }),
    ).toBe(false);
    expect(missions.get(mission.id)?.status).toBe("running");

    expect(
      handoffs.markConsumedAfterAcceptedDelivery(
        qaResult.handoff.id,
        mission.id,
        orchestratorSessionId,
      ),
    ).toBe(true);
    expect(
      dispatches.completeMissionFromVerifiedPlan({
        missionId: mission.id,
        intentVersion,
      }),
    ).toBe(false);
    expect(missions.get(mission.id)).toMatchObject({
      status: "running",
      intentState: "executing",
    });

    const milestoneEvidenceId = `milestone:${createHash("sha256")
      .update("guided-result-step")
      .digest("hex")}`;
    expect(
      missions.update(mission.id, {
        milestones: [
          {
            id: "step-1",
            label: "Entregar o fluxo guiado completo",
            status: "done",
            evidenceIds: [milestoneEvidenceId],
          },
        ],
      }),
    ).not.toBeNull();
    const prevc = {
      advanceMissionStep: () => {
        throw new Error("completion must not advance a PREVC step");
      },
      isMissionComplete: (
        candidateMissionId: string,
        candidateScope: typeof scope,
        stepIds: readonly string[],
      ) =>
        candidateMissionId === mission.id &&
        candidateScope.projectId === scope.projectId &&
        candidateScope.checkoutId === scope.checkoutId &&
        stepIds.length === 1 &&
        stepIds[0] === "step-1",
    };
    const stores = {
      missions,
      handoffs,
    } as unknown as ProjectDomainStoreSuite;
    const result = await applyDriveAction(
      {
        missionId: mission.id,
        scope,
        action: {
          kind: "complete",
          reason: "all guided steps carry immutable PREVC receipts",
        },
      },
      createProductionApplyPorts(prevc, () => stores),
    );

    expect(result).toEqual({ applied: true, kind: "complete" });
    expect(missions.get(mission.id)).toMatchObject({
      status: "done",
      intentState: "done",
      milestones: [
        expect.objectContaining({
          id: "step-1",
          status: "done",
          evidenceIds: [milestoneEvidenceId],
        }),
      ],
    });
  });
});
