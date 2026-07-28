import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  ipcMain: {},
}));

import {
  createRealMissionPrematureExitHandlers,
  hasCorrelatedPhysicalWorkerData,
  isCodexMcpApprovalPrompt,
  isRealMissionPhysicalPtyAgent,
  readDurableAuthoritySnapshot,
} from "./real-mission-e2e";
import {
  REAL_MISSION_E2E_EXECUTOR_NAME,
  REAL_MISSION_E2E_ORCHESTRATOR_NAME,
  REAL_MISSION_E2E_QA_NAME,
  REAL_MISSION_E2E_REVIEWER_NAME,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../shared/real-mission-e2e";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "./jarvis/audit-log";
import { createScopedHandoffStore } from "./orch/handoff-store";
import { createScopedMissionStore } from "./orch/mission-store";
import { createScopedTaskStore } from "./orch/task-store";
import { testProjectScope } from "./orch/__tests__/scope-fixture";
import { ProjectRuntimeManager } from "./runtime/project-runtime-manager";
import {
  ExactRealMissionPhysicalPtyGate,
  type RealMissionPhysicalPtyIdentity,
} from "./real-mission-e2e-physical";
import type { OwnedAgentSessionInfo } from "./pty/pty-manager";

const physicalScope: OwnedAgentSessionInfo["scope"] = {
  version: 1,
  installationId: "installation",
  projectId: "project",
  checkoutId: "checkout",
  rootRealPath: "/tmp/workspace",
  identitySource: "manifest",
};

function rosterPty(input: {
  sessionId: string;
  agentName: string;
  role: "orchestrator" | "worker";
  readOnly: boolean;
  nativeReadOnly: boolean;
}): OwnedAgentSessionInfo {
  return {
    sessionId: input.sessionId,
    paneId: `pane-${input.sessionId}`,
    adapterId: "codex",
    cwd: "/tmp/workspace",
    scope: physicalScope,
    source: input.role === "orchestrator" ? "legacy-squad" : "pending",
    role: input.role,
    missionId: "mission-e2e",
    ...(input.role === "orchestrator"
      ? { squadId: REAL_MISSION_E2E_SQUAD_ID }
      : { workerIncarnationId: `incarnation-${input.sessionId}` }),
    agentName: input.agentName,
    readOnly: input.readOnly,
    nativeReadOnly: input.nativeReadOnly,
    allowedTools: null,
    allowedSkills: null,
  };
}

describe("real mission premature exit receipts", () => {
  it("maps app and renderer lifecycle loss to closed failure codes", () => {
    let settled = false;
    const finish = vi.fn(() => {
      settled = true;
    });
    const handlers = createRealMissionPrematureExitHandlers({
      isSettled: () => settled,
      finish,
    });

    handlers.beforeQuit();
    handlers.ownerDestroyed();
    handlers.rendererGone();

    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith("app-error");
  });

  it("uses renderer-failed for either owner-loss event", () => {
    for (const event of ["ownerDestroyed", "rendererGone"] as const) {
      const finish = vi.fn();
      const handlers = createRealMissionPrematureExitHandlers({
        isSettled: () => false,
        finish,
      });

      handlers[event]();

      expect(finish).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledWith("renderer-failed");
    }
  });

  it("wires all premature exit hooks into the packaged gate", () => {
    const source = readFileSync(
      new URL("./real-mission-e2e.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('app.on("before-quit", onBeforeQuit)');
    expect(source).toContain('owner.once("destroyed", onOwnerDestroyed)');
    expect(source).toContain(
      'owner.once("render-process-gone", onOwnerRenderProcessGone)',
    );
  });

  it("cannot inject a harness-owned task plan around the production Guided Planner", () => {
    const source = readFileSync(
      new URL("./real-mission-e2e.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("sealRealMissionE2EPlanIfNeeded");
    expect(source).not.toContain("advanceRealMissionE2EMainOwnedChain");
    expect(source).not.toContain("createRealMissionE2EPlanTasks");
    expect(source).toContain('"production-guided-planner"');
  });

  it("recognizes a scheduler worker by mission + incarnation without squadId", () => {
    expect(
      isRealMissionPhysicalPtyAgent("pty-worker", "mission-e2e", {
        sessionId: "pty-worker",
        paneId: "pane-worker",
        adapterId: "codex",
        cwd: "/tmp/worktree",
        scope: {
          version: 1,
          installationId: "installation",
          projectId: "project",
          checkoutId: "checkout",
          rootRealPath: "/tmp/worktree",
          identitySource: "manifest",
        },
        source: "pending",
        role: "worker",
        missionId: "mission-e2e",
        agentName: REAL_MISSION_E2E_EXECUTOR_NAME,
        workerIncarnationId: "worker-incarnation",
        readOnly: false,
        allowedTools: null,
        allowedSkills: null,
      }),
    ).toBe(true);
  });

  it("fail-closes a mission-bound auxiliary PTY outside the approved roster", () => {
    const gate = new ExactRealMissionPhysicalPtyGate("mission-e2e");
    const auxiliary = rosterPty({
      sessionId: "pty-auxiliary-merge",
      agentName: "E2E Merge Auxiliar",
      role: "worker",
      readOnly: true,
      nativeReadOnly: true,
    });

    expect(gate.inspect(auxiliary.sessionId, auxiliary)).toEqual({
      kind: "violation",
    });
    expect(gate.acceptedSessionCount).toBe(0);
  });

  it("ignores canonical merge-council reviewer PTYs as unrelated to the roster fence", () => {
    const gate = new ExactRealMissionPhysicalPtyGate("mission-e2e");
    const council = rosterPty({
      sessionId: "pty-merge-council",
      agentName: "reviewer-codex-1-63549194f40b",
      role: "worker",
      readOnly: true,
      nativeReadOnly: true,
    });

    expect(gate.inspect(council.sessionId, council)).toEqual({
      kind: "unrelated",
    });
    expect(gate.acceptedSessionCount).toBe(0);
  });

  it("accepts exactly one physical PTY for each of the four roster identities", () => {
    const gate = new ExactRealMissionPhysicalPtyGate("mission-e2e");
    const roster = [
      rosterPty({
        sessionId: "pty-orchestrator",
        agentName: REAL_MISSION_E2E_ORCHESTRATOR_NAME,
        role: "orchestrator",
        readOnly: false,
        nativeReadOnly: true,
      }),
      rosterPty({
        sessionId: "pty-executor",
        agentName: REAL_MISSION_E2E_EXECUTOR_NAME,
        role: "worker",
        readOnly: false,
        nativeReadOnly: false,
      }),
      rosterPty({
        sessionId: "pty-reviewer",
        agentName: REAL_MISSION_E2E_REVIEWER_NAME,
        role: "worker",
        readOnly: true,
        nativeReadOnly: true,
      }),
      rosterPty({
        sessionId: "pty-qa",
        agentName: REAL_MISSION_E2E_QA_NAME,
        role: "worker",
        readOnly: true,
        nativeReadOnly: true,
      }),
    ];
    const identities: RealMissionPhysicalPtyIdentity[] = [
      "orchestrator",
      "executor",
      "reviewer",
      "qa",
    ];

    roster.forEach((agent, index) => {
      expect(gate.inspect(agent.sessionId, agent)).toMatchObject({
        kind: "accepted",
        identity: identities[index],
      });
    });
    expect(gate.acceptedSessionCount).toBe(4);

    const duplicateReviewer = rosterPty({
      sessionId: "pty-reviewer-replacement",
      agentName: REAL_MISSION_E2E_REVIEWER_NAME,
      role: "worker",
      readOnly: true,
      nativeReadOnly: true,
    });
    expect(
      gate.inspect(duplicateReviewer.sessionId, duplicateReviewer),
    ).toEqual({ kind: "violation" });
    expect(gate.acceptedSessionCount).toBe(4);
  });

  it("routes state, data, exit and live inventory through the same exact-roster fence", () => {
    const source = readFileSync(
      new URL("./real-mission-e2e-observer.ts", import.meta.url),
      "utf8",
    );
    const stateBlock = source.slice(
      source.indexOf("this.#untapState = tapSessionState"),
      source.indexOf("this.#untapData = tapSessionData"),
    );
    const dataBlock = source.slice(
      source.indexOf("this.#untapData = tapSessionData"),
      source.indexOf("this.#untapExit = tapSessionExit"),
    );
    const exitBlock = source.slice(
      source.indexOf("this.#untapExit = tapSessionExit"),
      source.indexOf("this.#interval = setInterval"),
    );
    const inventoryBlock = source.slice(
      source.indexOf("for (const agent of listAgentSessions())"),
      source.indexOf("if (this.#owner.isDestroyed()"),
    );

    expect(stateBlock).toContain("#acceptMissionPhysicalPty");
    expect(dataBlock).toContain("#acceptMissionPhysicalPty");
    expect(exitBlock).toContain("#acceptMissionPhysicalPty");
    expect(inventoryBlock).toContain("#acceptMissionPhysicalPty");
  });

  it("observes a worker only after correlated physical PTY data exists", () => {
    const dispatches = [
      {
        sessionId: "pty-worker",
        workerIncarnationId: "worker-incarnation",
      },
    ];
    const captures = new Map<
      string,
      {
        role: "orchestrator" | "worker";
        workerIncarnationId: string | null;
        dataAt: number | null;
        ptyChunkSha256: string | null;
      }
    >([
      [
        "pty-worker",
        {
          role: "worker" as const,
          workerIncarnationId: "worker-incarnation",
          dataAt: null,
          ptyChunkSha256: null,
        },
      ],
    ]);

    expect(hasCorrelatedPhysicalWorkerData(dispatches, captures)).toBe(false);
    captures.set("pty-worker", {
      role: "worker",
      workerIncarnationId: "stale-incarnation",
      dataAt: 10,
      ptyChunkSha256: "a".repeat(64),
    });
    expect(hasCorrelatedPhysicalWorkerData(dispatches, captures)).toBe(false);
    captures.set("pty-worker", {
      role: "worker",
      workerIncarnationId: "worker-incarnation",
      dataAt: 10,
      ptyChunkSha256: "a".repeat(64),
    });
    expect(hasCorrelatedPhysicalWorkerData(dispatches, captures)).toBe(true);
  });

  it("detects the exact Codex MCP approval question without retaining output", () => {
    expect(
      isCodexMcpApprovalPrompt(`
        Question 1/1 (1 unanswered)
        Allow the nexus_6f0357953c28 MCP server to run
        tool "nexus_handoff_submit"?
      `),
    ).toBe(true);
    expect(
      isCodexMcpApprovalPrompt(`
        Allow the nexus_6f0357953c28 MCP server to run
        tool "nexus_context_get"?
      `),
    ).toBe(true);
    expect(
      isCodexMcpApprovalPrompt(`
        Questão 1/1
        Permitir que o servidor MCP nexus_91ab execute a ferramenta
        "nexus_files_read"?
        1. Permitir  2. Permitir nesta sessão  3. Negar
      `),
    ).toBe(true);
    expect(
      isCodexMcpApprovalPrompt(`
        ¿Autorizar al servidor MCP nexus_local para ejecutar la herramienta
        nexus_browser_read?
        1. Autorizar  2. Cancelar
      `),
    ).toBe(true);
    expect(
      isCodexMcpApprovalPrompt(`
        Allow MCP server nexus_release to run tool nexus_task_list?
        Allow for this session / Cancel this tool call
      `),
    ).toBe(true);
    expect(
      isCodexMcpApprovalPrompt(
        "Running nexus_handoff_submit through the bound Nexus server.",
      ),
    ).toBe(false);
    expect(
      isCodexMcpApprovalPrompt(`
        Booting MCP server: nexus_6f0357953c28
        (0s • esc to interrupt)
      `),
    ).toBe(false);
    // Rolling PTY buffer: boot status + later model prose must not abort the gate.
    expect(
      isCodexMcpApprovalPrompt(`
        Booting MCP server: nexus_6f0357953c28
        (0s • esc to interrupt)
        Please confirm the mission goal before we continue?
      `),
    ).toBe(false);
    expect(
      isCodexMcpApprovalPrompt(`
        Booting MCP server: nexus_6f0357953c28
        Allow edits to resultado.txt?
      `),
    ).toBe(false);
    expect(
      isCodexMcpApprovalPrompt(
        "Use nexus_task to list work, then confirm the plan with the operator?",
      ),
    ).toBe(false);
  });

  it("reads consumption and reviewer<-executor receipts through a query-only snapshot", () => {
    const baseDir = mkdtempSync(
      path.join(os.tmpdir(), "nexus-real-mission-authority-"),
    );
    const manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: "0.19.31",
      now: () => 100,
    });
    const scope = testProjectScope({
      projectId: "project-real-evidence",
      checkoutId: "checkout-real-evidence",
    });
    configureAuditLogRuntime(manager);
    try {
      const mission = createScopedMissionStore(manager, scope).create({
        title: "Authority evidence",
      });
      const tasks = createScopedTaskStore(manager, scope);
      const executor = tasks.create({
        missionId: mission.id,
        title: "Executor",
      });
      const reviewer = tasks.create({
        missionId: mission.id,
        title: "Reviewer",
      });
      const handoff = createScopedHandoffStore(manager, scope).submit({
        missionId: mission.id,
        sessionId: "session-executor",
        workerIncarnationId: "incarnation-executor",
        fromAgent: "E2E Executor",
        status: "success",
        summary: "Executor completed",
      });
      const database = manager.open(scope).db;
      database
        .prepare(
          `UPDATE handoffs
           SET delivered = 1, delivery_state = 'consumed',
               consumed_at = 130, consumed_by_session = 'session-orch',
               consumed_delivery_attempt_id = 'attempt-executor'
           WHERE id = ?`,
        )
        .run(handoff.id);
      database
        .prepare(
          `INSERT INTO task_dependency_consumption_receipts
             (mission_id, consumer_task_id, dependency_task_id, handoff_id,
              consumer_session_id, consumer_worker_incarnation_id,
              prompt_sha256, handoff_summary_sha256, consumed_at)
           VALUES (?, ?, ?, ?, 'session-reviewer', 'incarnation-reviewer',
                   ?, ?, 140)`,
        )
        .run(
          mission.id,
          reviewer.id,
          executor.id,
          handoff.id,
          "a".repeat(64),
          "b".repeat(64),
        );
      database
        .prepare(
          `INSERT INTO mission_step_receipts
             (mission_id, step_id, from_stage, to_stage,
              workflow_revision_before, workflow_revision_after,
              evidence_ids_json, evidence_binding_json, completed_at)
           VALUES (?, 'step-1', 'validation-primary', 'validation-primary',
                   3, 3, ?, ?, 150)`,
        )
        .run(
          mission.id,
          JSON.stringify([`milestone:${"c".repeat(64)}`]),
          JSON.stringify({
            missionId: mission.id,
            contextRevision: "d".repeat(64),
            contractHash: "e".repeat(64),
            baseSha: "f".repeat(40),
            headSha: "a".repeat(40),
            diffHash: "b".repeat(64),
            workflowRevision: 3,
          }),
        );

      const snapshot = readDurableAuthoritySnapshot(scope, mission.id);

      expect(snapshot.handoffConsumptions.get(handoff.id)).toEqual({
        id: handoff.id,
        consumed_at: 130,
        consumed_by_session: "session-orch",
        consumed_delivery_attempt_id: "attempt-executor",
      });
      expect(snapshot.dependencyConsumptions).toEqual([
        {
          mission_id: mission.id,
          consumer_task_id: reviewer.id,
          dependency_task_id: executor.id,
          handoff_id: handoff.id,
          consumer_session_id: "session-reviewer",
          consumer_worker_incarnation_id: "incarnation-reviewer",
          prompt_sha256: "a".repeat(64),
          handoff_summary_sha256: "b".repeat(64),
          consumed_at: 140,
        },
      ]);
      expect(snapshot.missionStepReceipts).toEqual([
        {
          step_id: "step-1",
          from_stage: "validation-primary",
          to_stage: "validation-primary",
          workflow_revision_before: 3,
          workflow_revision_after: 3,
          evidence_ids_json: JSON.stringify([`milestone:${"c".repeat(64)}`]),
          evidence_binding_json: JSON.stringify({
            missionId: mission.id,
            contextRevision: "d".repeat(64),
            contractHash: "e".repeat(64),
            baseSha: "f".repeat(40),
            headSha: "a".repeat(40),
            diffHash: "b".repeat(64),
            workflowRevision: 3,
          }),
          completed_at: 150,
        },
      ]);
    } finally {
      disposeAuditLogRuntime();
      manager.closeAll();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("accepts both sealed main-owned and legacy-squad orchestrators", () => {
    const orchestrator = {
      sessionId: "pty-orchestrator",
      paneId: "pane-orchestrator",
      adapterId: "codex",
      cwd: "/tmp/workspace",
      scope: {
        version: 1 as const,
        installationId: "installation",
        projectId: "project",
        checkoutId: "checkout",
        rootRealPath: "/tmp/workspace",
        identitySource: "manifest" as const,
      },
      source: "legacy-squad" as const,
      role: "orchestrator" as const,
      missionId: "mission-e2e",
      agentName: "E2E Orquestrador",
      readOnly: false,
      allowedTools: null,
      allowedSkills: null,
    };

    expect(
      isRealMissionPhysicalPtyAgent(
        orchestrator.sessionId,
        "mission-e2e",
        orchestrator,
      ),
    ).toBe(false);
    expect(
      isRealMissionPhysicalPtyAgent(orchestrator.sessionId, "mission-e2e", {
        ...orchestrator,
        squadId: REAL_MISSION_E2E_SQUAD_ID,
      }),
    ).toBe(true);
    expect(
      isRealMissionPhysicalPtyAgent(orchestrator.sessionId, "mission-e2e", {
        ...orchestrator,
        source: "pending",
        authoritySeal: {
          intentVersion: 1,
          intentContractHash: "a".repeat(64),
          contextRevision: "revision",
          contractHash: "b".repeat(64),
          squadRevisionHash: "c".repeat(64),
        },
      }),
    ).toBe(true);
  });
});
