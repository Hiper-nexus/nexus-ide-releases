import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  clearAuditLogForTests,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "../jarvis/audit-log";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { AutomatedReviewSessionRegistry } from "../context/automated-review-session";
import type { Mission } from "../../shared/orch-types";
import {
  bindTokenToSession,
  mintToken,
  resetGateForTests,
  type AgentGateContext,
} from "./gate";
import {
  assertGuidedPrevcMcpFence,
  INACTIVE_GUIDED_PREVC_MCP_FENCE,
  type GuidedPrevcMcpFenceSnapshot,
} from "./guided-prevc-mcp-fence";
import { runInsidePtyStreamAgentTransport } from "./http-mcp-boundary";
import { dispatchToolCall } from "./mcp-dispatch";
import type { McpDispatchOptions } from "./mcp-dispatch-contract";
import type { McpRegistry, McpToolDef } from "./mcp-protocol";
import { encodeTaskScheduleDetail } from "./mission-scheduler-meta";
import {
  automatedReviewSkills,
  automatedReviewTools,
  CONTEXT_DRAFT_REVIEW_SKILLS,
  CONTEXT_DRAFT_REVIEW_TOOLS,
} from "./prevc-reviewer-profile";
import { resetMissionPromptQueues } from "./mission-prompt-queue-registry";
import { testProjectScope } from "./__tests__/scope-fixture";

const MISSION_ID = "mission-guided-fence";
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "nexus-guided-prevc-mcp-fence-"),
);
const scope = testProjectScope({ rootRealPath: root });
let runtime: ProjectRuntimeManager;

function detail(domain: string): string {
  return encodeTaskScheduleDetail("Executar", {
    dependsOn: [],
    ownership: {
      files: ["src"],
      symbols: [],
      domains: [domain],
    },
    merged: false,
    agentRef: "executor",
    agentCategory: "executor",
    executionMode: "isolated_worktree",
  });
}

function approvedMission(): Mission {
  return {
    id: MISSION_ID,
    title: "Guided fence",
    description: "guided fence test",
    status: "running",
    squadId: "agentic-guided-fence",
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: "Deliver safely",
      acceptanceCriteria: ["It works"],
      risk: "sensitive",
      executionMode: "autopilot",
      lane: "standard",
      contextPolicy: "on-demand",
      intentVersion: 1,
      approvedAt: 1,
      approvalReviewSha256: "a".repeat(64),
      budgets: {
        planningTokens: 1_000,
        executionTokens: 8_000,
        maxWorkers: 3,
        maxSteps: 500,
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function fence(
  stage: GuidedPrevcMcpFenceSnapshot["stage"],
  overrides: Partial<GuidedPrevcMcpFenceSnapshot> = {},
): GuidedPrevcMcpFenceSnapshot {
  const hasContract = stage !== null;
  const active =
    stage === null ||
    stage === "planning" ||
    stage === "review-primary" ||
    stage === "review-secondary";
  return Object.freeze({
    required: true,
    active,
    hasContract,
    stage,
    risk: hasContract ? "high" : null,
    contractHash: hasContract ? "b".repeat(64) : null,
    workflowRevision: hasContract ? 1 : null,
    ...overrides,
  });
}

function maestro(
  allowedTools: string[] | null = null,
): AgentGateContext {
  resetGateForTests();
  return mintToken({
    label: "Maestro",
    role: "orchestrator",
    missionId: MISSION_ID,
    agentName: "maestro",
    providerId: "claude",
    scope,
    allowedTools,
    allowedSkills: null,
  });
}

function physicalMaestro(
  allowedTools: string[] | null = null,
): AgentGateContext {
  const ctx = maestro(allowedTools);
  bindTokenToSession(ctx.token, "session-maestro");
  return ctx;
}

function ordinaryWorker(
  allowedTools: string[] | null = null,
): AgentGateContext {
  resetGateForTests();
  const ctx = mintToken({
    label: "executor-codex",
    role: "worker",
    missionId: MISSION_ID,
    agentName: "executor-codex",
    providerId: "codex",
    workerIncarnationId: "incarnation-executor-1",
    scope,
    allowedTools,
    allowedSkills: null,
  });
  bindTokenToSession(ctx.token, "session-executor");
  return ctx;
}

function draftReviewer(draftId = "draft-a"): AgentGateContext {
  resetGateForTests();
  return mintToken({
    label: "context-reviewer-codex-aaaaaaaaaaaa",
    role: "worker",
    missionId: MISSION_ID,
    agentName: "context-reviewer-codex-aaaaaaaaaaaa",
    providerId: "codex",
    readOnly: true,
    allowedTools: [...CONTEXT_DRAFT_REVIEW_TOOLS],
    allowedSkills: [...CONTEXT_DRAFT_REVIEW_SKILLS],
    internalPrevcReviewerAuthority: {
      kind: "context-draft",
      draftId,
    },
    internalPrevcReviewerAuthoritySource: "verified-active-profile",
    scope,
  });
}

function automatedReviewer(
  reviewSessionId = REVIEW_ID,
  includeDesign = false,
  issuedFor: "pre-execution" | "post-execution" = "pre-execution",
): AgentGateContext {
  resetGateForTests();
  const opaque = reviewSessionId.replaceAll("-", "").slice(0, 12);
  const ctx = mintToken({
    label: `reviewer-codex-1-${opaque}`,
    role: "worker",
    missionId: MISSION_ID,
    agentName: `reviewer-codex-1-${opaque}`,
    providerId: "codex",
    readOnly: true,
    allowedTools: [...automatedReviewTools(includeDesign)],
    allowedSkills: [...automatedReviewSkills(includeDesign)],
    internalPrevcReviewerAuthority: {
      kind: "automated-review",
      reviewSessionId,
      issuedFor,
    },
    internalPrevcReviewerAuthoritySource: "verified-active-profile",
    scope,
    executionScope: {
      ...scope,
      rootRealPath: path.join(root, "candidate"),
    },
  });
  bindTokenToSession(ctx.token, "session-reviewer");
  return ctx;
}

function tool(
  name: string,
  handler: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    handled: true,
  })),
): { registry: McpRegistry; handler: typeof handler } {
  const definition: McpToolDef = {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    handler,
  };
  return {
    registry: {
      tools: [definition],
      serverName: "guided-prevc-fence-test",
      serverVersion: "0.0.0",
    },
    handler,
  };
}

function dispatchOptions(
  resolveFence: () => GuidedPrevcMcpFenceSnapshot,
  extra: Partial<McpDispatchOptions> = {},
): McpDispatchOptions {
  return {
    resolveGuidedPrevcMcpFence: () => resolveFence(),
    resolveMissionForIntentGate: (_scope, missionId) =>
      missionId === MISSION_ID
        ? {
            mission: approvedMission(),
            taskCount: 3,
            workerPaneCount: 0,
          }
        : null,
    resolveWorkflowAuthority: () => ({
      contextRevision: undefined,
      assertExecutionEffectAllowed: () => undefined,
    }),
    reserveMissionBudget: () => undefined,
    ...extra,
  };
}

async function call(input: {
  readonly name: string;
  readonly args?: Record<string, unknown>;
  readonly ctx?: AgentGateContext;
  readonly snapshot?: GuidedPrevcMcpFenceSnapshot;
  readonly handler?: ReturnType<typeof vi.fn>;
  readonly options?: Partial<McpDispatchOptions>;
}) {
  const selected = tool(input.name, input.handler);
  const snapshot = input.snapshot ?? fence(null);
  const result = await dispatchToolCall(
    "http-mcp",
    selected.registry,
    input.name,
    input.args ?? {},
    input.ctx ?? maestro(),
    dispatchOptions(() => snapshot, input.options),
  );
  return { result, handler: selected.handler };
}

beforeAll(() => {
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(root, "runtime"),
    appVersion: "guided-prevc-fence-test",
  });
  configureAuditLogRuntime(runtime);
});

beforeEach(() => {
  configureAuditLogRuntime(runtime);
  clearAuditLogForTests({ scope });
  runtime
    .open(scope)
    .db.prepare(
      `INSERT OR IGNORE INTO missions
       (id, title, description, status, milestones_json, created_at, updated_at)
       VALUES (?, ?, '', 'running', '[]', ?, ?)`,
    )
    .run(MISSION_ID, "Guided fence", Date.now(), Date.now());
  resetMissionPromptQueues();
  resetGateForTests();
});

afterAll(() => {
  disposeAuditLogRuntime();
  runtime.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("guided PREVC MCP pre-execution fence", () => {
  it("keeps mission coordination and bounded observations available while PREVC prepares in parallel", async () => {
    const workerCalls = [
      [
        "nexus_handoff_submit",
        {
          status: "success",
          summary: "Entrega física concluída e pronta para consumo.",
          artifacts: [],
        },
      ],
      ["nexus_handoff_list", {}],
      ["nexus_worker_heartbeat", {}],
      ["nexus_task", { action: "list" }],
      ["nexus_todo_manager", { action: "read_list" }],
      ["nexus_clarify", {
        question: "Qual alternativa atende ao objetivo?",
        options: ["A", "B"],
      }],
      ["nexus_memory_recall", { query: "arquitetura da missão" }],
      ["nexus_file_read", { path: "README.md" }],
      ["nexus_code_map_query", { query: "mission scheduler" }],
    ] as const;
    const maestroCalls = [
      ["nexus_task", { action: "list", missionId: MISSION_ID }],
      ["nexus_handoff_list", { missionId: MISSION_ID }],
      ["nexus_handoff_ack", { handoffId: "handoff-a" }],
      ["nexus_pane_list", {}],
      ["nexus_memory_recall", { query: "decisões arquiteturais" }],
      ["nexus_browser_open", { url: "https://example.com/docs" }],
      [
        "nexus_browser_navigate",
        { paneId: "pane-browser", url: "https://example.com/reference" },
      ],
    ] as const;

    for (const stage of [
      null,
      "planning",
      "review-primary",
      "review-secondary",
    ] as const) {
      for (const [name, args] of workerCalls) {
        const workerCtx = ordinaryWorker();
        const invoke = () =>
          call({
            name,
            args,
            ctx: workerCtx,
            snapshot: fence(stage),
          });
        const called =
          name === "nexus_handoff_submit"
            ? await runInsidePtyStreamAgentTransport(
                workerCtx.sessionId!,
                workerCtx,
                invoke,
              )
            : await invoke();
        expect(
          called.result,
          `${stage ?? "no-contract"}:${name}:${JSON.stringify(called.result)}`,
        ).toMatchObject({ ok: true });
        expect(called.handler).toHaveBeenCalledOnce();
      }
      for (const [name, args] of maestroCalls) {
        const maestroCtx = physicalMaestro();
        const invoke = () =>
          call({
            name,
            args,
            ctx: maestroCtx,
            snapshot: fence(stage),
          });
        const called =
          name === "nexus_handoff_ack"
            ? await runInsidePtyStreamAgentTransport(
                maestroCtx.sessionId!,
                maestroCtx,
                invoke,
              )
            : await invoke();
        expect(
          called.result,
          `${stage ?? "no-contract"}:${name}:${JSON.stringify(called.result)}`,
        ).toMatchObject({ ok: true });
        expect(called.handler).toHaveBeenCalledOnce();
      }
    }
  });

  it("binds pre-execution coordination to the exact physical role and mission", () => {
    const active = fence("planning");
    const worker = ordinaryWorker();
    const maestroCtx = physicalMaestro();

    for (const [ctx, expected] of [
      [{ ...worker, missionId: undefined }, /mission-bound bearer/i],
      [{ ...worker, sessionId: undefined }, /current physical mission worker/i],
      [
        { ...worker, workerIncarnationId: undefined },
        /current physical mission worker/i,
      ],
    ] as const) {
      expect(() =>
        assertGuidedPrevcMcpFence(
          active,
          "nexus_worker_heartbeat",
          {},
          ctx,
        ),
      ).toThrow(expected);
    }

    for (const [name, args] of [
      ["nexus_handoff_list", { missionId: "mission-other" }],
      ["nexus_task", { action: "list", missionId: "mission-other" }],
      ["nexus_todo_manager", { action: "read_list", listId: "mission-other" }],
    ] as const) {
      expect(() =>
        assertGuidedPrevcMcpFence(active, name, args, worker),
      ).toThrow(/differs from bearer/i);
    }

    for (const [name, args] of [
      ["nexus_task", { action: "create", title: "duplicate plan" }],
      ["nexus_task", { action: "update", taskId: "task-a" }],
      ["nexus_task", { action: "plan", tasks: [] }],
      ["nexus_todo_manager", { action: "add_task", task: "duplicate" }],
      ["nexus_todo_manager", { action: "mark_all_done" }],
    ] as const) {
      expect(() =>
        assertGuidedPrevcMcpFence(active, name, args, worker),
      ).toThrow(/mutation is unavailable/i);
    }

    expect(() =>
      assertGuidedPrevcMcpFence(
        active,
        "nexus_handoff_ack",
        { handoffId: "handoff-a" },
        worker,
      ),
    ).toThrow(/physical mission Maestro/i);
    expect(() =>
      assertGuidedPrevcMcpFence(
        active,
        "nexus_worker_heartbeat",
        {},
        maestroCtx,
      ),
    ).toThrow(/physical mission worker/i);
    expect(() =>
      assertGuidedPrevcMcpFence(
        active,
        "nexus_handoff_submit",
        {
          status: "success",
          summary: "reviewer must remain inside its exact authority",
        },
        automatedReviewer(REVIEW_ID),
      ),
    ).toThrow(/outside the exact internal reviewer profile/i);

    for (const [ctx, expected] of [
      [worker, /physical mission Maestro/i],
      [{ ...maestroCtx, sessionId: undefined }, /physical mission Maestro/i],
      [{ ...maestroCtx, missionId: undefined }, /mission-bound bearer/i],
    ] as const) {
      expect(() =>
        assertGuidedPrevcMcpFence(
          active,
          "nexus_browser_open",
          { url: "https://example.com" },
          ctx,
        ),
      ).toThrow(expected);
    }
  });

  it("blocks execution, external mutation, and PREVC transition handlers before execution", async () => {
    const denied = [
      ["nexus_preview_start", {}],
      ["nexus_catalog_overlay", {}],
      ["nexus_route_task", { task: "delegate" }],
      ["nexus_pane_spawn", {}],
      ["nexus_terminal_run", { command: "npm test" }],
      ["nexus_bg_run", { command: "npm test" }],
      ["nexus_file_write", { path: "src/index.ts", content: "changed" }],
      ["nexus_git_push", {}],
      ["nexus_browser_click", { paneId: "pane-browser", ref: "e1" }],
      [
        "nexus_browser_fill",
        { paneId: "pane-browser", ref: "e2", text: "mutation" },
      ],
      ["nexus_merge_task", { missionId: MISSION_ID, taskId: "task-a" }],
      ["nexus_context_commit", { message: "must not run" }],
    ] as const;
    for (const stage of [
      null,
      "planning",
      "review-primary",
      "review-secondary",
    ] as const) {
      for (const [name, args] of denied) {
        const handler = vi.fn(async () => ({ impossible: true }));
        const called = await call({
          name,
          args,
          snapshot: fence(stage),
          handler,
        });
        expect(called.result, `${stage ?? "no-contract"}:${name}`).toMatchObject(
          {
            ok: false,
            denied: true,
            error: expect.stringContaining("guided_prevc_mcp_fence"),
          },
        );
        expect(handler, `${stage ?? "no-contract"}:${name}`).not.toHaveBeenCalled();
      }
    }
  });

  it("allows only the Maestro bootstrap/observation/fail-safe matrix", async () => {
    const missing = fence(null);
    const planning = fence("planning");

    await expect(
      call({ name: "nexus_context_doctor", snapshot: missing }),
    ).resolves.toMatchObject({
      result: { ok: true },
      handler: expect.any(Function),
    });
    for (const args of [
      { autoReview: false },
      { autoCommit: false },
    ]) {
      const denied = await call({
        name: "nexus_context_doctor",
        args,
        snapshot: missing,
      });
      expect(denied.result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("autoReview and autoCommit"),
      });
      expect(denied.handler).not.toHaveBeenCalled();
    }
    const postFreezeDoctor = await call({
      name: "nexus_context_doctor",
      snapshot: planning,
    });
    expect(postFreezeDoctor.result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("Doctor authority ends"),
    });
    expect(postFreezeDoctor.handler).not.toHaveBeenCalled();

    for (const [name, args, snapshot] of [
      ["nexus_mission_freeze_contract", { missionId: MISSION_ID }, missing],
      ["nexus_mission_freeze_contract", { missionId: MISSION_ID }, planning],
      ["nexus_mission_get", { missionId: MISSION_ID }, missing],
      ["nexus_workflow_get", { missionId: MISSION_ID }, planning],
      [
        "nexus_mission_set_status",
        { missionId: MISSION_ID, status: "blocked" },
        missing,
      ],
      [
        "nexus_mission_set_status",
        { missionId: MISSION_ID, status: "failed" },
        planning,
      ],
      [
        "nexus_workflow_prepare_execution",
        { missionId: MISSION_ID },
        planning,
      ],
    ] as const) {
      const allowed = await call({ name, args, snapshot });
      expect(allowed.result, name).toMatchObject({ ok: true });
      expect(allowed.handler, name).toHaveBeenCalledOnce();
    }

    const prepareTooSoon = await call({
      name: "nexus_workflow_prepare_execution",
      args: { missionId: MISSION_ID },
      snapshot: missing,
    });
    expect(prepareTooSoon.result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("requires a frozen contract"),
    });
    expect(prepareTooSoon.handler).not.toHaveBeenCalled();

    for (const status of ["pending", "running", "done"]) {
      const denied = await call({
        name: "nexus_mission_set_status",
        args: { missionId: MISSION_ID, status },
        snapshot: planning,
      });
      expect(denied.result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("blocked or failed"),
      });
      expect(denied.handler).not.toHaveBeenCalled();
    }
  });

  it("binds every allowed Maestro mission tool to the bearer mission", async () => {
    const otherMissionId = "mission-guided-fence-other";
    for (const [name, args, snapshot] of [
      [
        "nexus_mission_freeze_contract",
        { missionId: otherMissionId },
        fence(null),
      ],
      [
        "nexus_workflow_prepare_execution",
        { missionId: otherMissionId },
        fence("planning"),
      ],
      ["nexus_mission_get", { missionId: otherMissionId }, fence(null)],
      ["nexus_workflow_get", { missionId: otherMissionId }, fence("planning")],
      [
        "nexus_mission_set_status",
        { missionId: otherMissionId, status: "blocked" },
        fence("planning"),
      ],
    ] as const) {
      const denied = await call({ name, args, snapshot });
      expect(denied.result, name).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining(
          "requested mission differs from bearer authority",
        ),
      });
      expect(denied.handler, name).not.toHaveBeenCalled();
    }
  });

  it("binds internal context and automated reviewers to exact objects", async () => {
    const exactDraft = await call({
      name: "nexus_context_draft_review",
      args: {
        draftId: "draft-a",
        decision: "approve",
        rationale: "source hashes match",
      },
      ctx: draftReviewer("draft-a"),
      snapshot: fence(null),
    });
    expect(exactDraft.result).toMatchObject({ ok: true });
    expect(exactDraft.handler).toHaveBeenCalledOnce();

    const crossDraft = await call({
      name: "nexus_context_draft_review",
      args: {
        draftId: "draft-b",
        decision: "approve",
        rationale: "cross-draft attempt",
      },
      ctx: draftReviewer("draft-a"),
      snapshot: fence(null),
    });
    expect(crossDraft.result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("bound to another draft"),
    });
    expect(crossDraft.handler).not.toHaveBeenCalled();

    const afterFreeze = await call({
      name: "nexus_file_read",
      args: { path: "PRODUCT.md" },
      ctx: draftReviewer("draft-a"),
      snapshot: fence("planning"),
    });
    expect(afterFreeze.result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("authority ends"),
    });
    expect(afterFreeze.handler).not.toHaveBeenCalled();

    const reviewId = REVIEW_ID;
    const exactReview = await call({
      name: "nexus_merge_review_submit",
      args: { reviewSessionId: reviewId, findings: [] },
      ctx: automatedReviewer(reviewId),
      snapshot: fence("review-primary", { risk: "critical" }),
    });
    expect(exactReview.result).toMatchObject({ ok: true });
    expect(exactReview.handler).toHaveBeenCalledOnce();

    const crossReview = await call({
      name: "nexus_merge_review_submit",
      args: {
        reviewSessionId: "22222222-2222-4222-8222-222222222222",
        findings: [],
      },
      ctx: automatedReviewer(reviewId),
      snapshot: fence("review-primary", { risk: "critical" }),
    });
    expect(crossReview.result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("another review session"),
    });
    expect(crossReview.handler).not.toHaveBeenCalled();

    const wrongRisk = await call({
      name: "nexus_file_read",
      args: { path: "src/index.ts" },
      ctx: automatedReviewer(reviewId),
      snapshot: fence("review-primary", { risk: "medium" }),
    });
    expect(wrongRisk.result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("current review phase"),
    });
    expect(wrongRisk.handler).not.toHaveBeenCalled();

    for (const stage of [
      "execution",
      "validation-primary",
      "confirmation",
      "complete",
    ] as const) {
      const staleDraft = await call({
        name: "nexus_context_draft_review",
        args: {
          draftId: "draft-a",
          decision: "approve",
          rationale: "stale reviewer",
        },
        ctx: draftReviewer("draft-a"),
        snapshot: fence(stage, { active: false }),
      });
      expect(staleDraft.result, `draft:${stage}`).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("authority ends"),
      });
      expect(staleDraft.handler).not.toHaveBeenCalled();

      const staleAutomated = await call({
        name: "nexus_merge_review_submit",
        args: { reviewSessionId: reviewId, findings: [] },
        ctx: automatedReviewer(reviewId),
        snapshot: fence(stage, { active: false, risk: "critical" }),
      });
      expect(staleAutomated.result, `automated:${stage}`).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("current review phase"),
      });
      expect(staleAutomated.handler).not.toHaveBeenCalled();
    }

    const validationReview = await call({
      name: "nexus_merge_review_submit",
      args: { reviewSessionId: reviewId, findings: [] },
      ctx: automatedReviewer(reviewId, false, "post-execution"),
      snapshot: fence("validation-primary", {
        active: false,
        risk: "critical",
      }),
    });
    expect(validationReview.result).toMatchObject({ ok: true });
    expect(validationReview.handler).toHaveBeenCalledOnce();

  });

  it("keeps a valid submit successful when it wakes the parent and closes before the post-handler checkpoint", async () => {
    const sessions = new AutomatedReviewSessionRegistry();
    const binding = {
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      missionId: MISSION_ID,
      contractHash: "b".repeat(64),
      contextHash: "c".repeat(64),
      baseSha: "d".repeat(40),
      headSha: "e".repeat(40),
      diffHash: "f".repeat(64),
    };
    const reviewSessionId = sessions.open({
      missionId: MISSION_ID,
      checkoutPath: path.join(root, "candidate"),
      risk: "high",
      binding,
      author: {
        id: "author",
        sessionId: "author-session",
        provider: "claude",
      },
      persist: () => undefined,
    });
    const parent = sessions
      .wait(reviewSessionId, 1_000)
      .then(() => sessions.close(reviewSessionId));
    const handler = vi.fn(async () =>
      sessions.submit(
        reviewSessionId,
        {
          id: "reviewer",
          sessionId: "session-reviewer",
          provider: "codex",
          missionId: MISSION_ID,
          checkoutPath: path.join(root, "candidate"),
        },
        [],
      ),
    );
    const submitted = await call({
      name: "nexus_merge_review_submit",
      args: { reviewSessionId, findings: [] },
      ctx: automatedReviewer(reviewSessionId),
      snapshot: fence("review-primary", { risk: "high" }),
      handler,
    });
    await parent;
    expect(submitted.result).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(() =>
      sessions.submit(
        reviewSessionId,
        {
          id: "late-reviewer",
          sessionId: "late-session",
          provider: "codex",
          missionId: MISSION_ID,
          checkoutPath: path.join(root, "candidate"),
        },
        [],
      ),
    ).toThrow(/unknown or expired/i);
  });

  it("disarms at execution and never rearms during validation/confirmation/complete", () => {
    const ctx = maestro();
    for (const stage of [
      "execution",
      "validation-primary",
      "validation-secondary",
      "confirmation",
      "complete",
    ] as const) {
      expect(() =>
        assertGuidedPrevcMcpFence(
          fence(stage, { active: false }),
          "nexus_terminal_run",
          { command: "npm test" },
          ctx,
        ),
      ).not.toThrow();
    }
    expect(() =>
      assertGuidedPrevcMcpFence(
        INACTIVE_GUIDED_PREVC_MCP_FENCE,
        "nexus_route_task",
        { task: "non-guided behavior" },
        ctx,
      ),
    ).not.toThrow();
  });

  it("revalidates after a confirmation await before the handler starts", async () => {
    let current = fence("execution", { active: false });
    const handler = vi.fn(async () => ({ impossible: true }));
    const confirm = vi.fn(async () => {
      current = fence("planning");
      return true;
    });
    const selected = tool("nexus_cron", handler);
    const result = await dispatchToolCall(
      "http-mcp",
      selected.registry,
      "nexus_cron",
      {
        action: "create",
        name: "fence-await",
        schedule: "0 9 * * *",
      },
      maestro(["nexus_cron"]),
      dispatchOptions(() => current, { confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("guided_prevc_mcp_fence"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("revalidates after the handler await and permits the sanctioned prepare transition", async () => {
    let current = fence(null);
    const doctorHandler = vi.fn(async () => {
      await Promise.resolve();
      current = fence("planning");
      return { changed: true };
    });
    const changedDuringDoctor = await call({
      name: "nexus_context_doctor",
      snapshot: current,
      handler: doctorHandler,
      options: {
        resolveGuidedPrevcMcpFence: () => current,
      },
    });
    expect(doctorHandler).toHaveBeenCalledOnce();
    expect(changedDuringDoctor.result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Doctor authority ends"),
      effectMayHaveCommitted: true,
    });

    current = fence("review-primary", { risk: "high" });
    const prepareHandler = vi.fn(async () => {
      await Promise.resolve();
      current = fence("execution", { active: false, risk: "high" });
      return { state: "execution" };
    });
    const prepared = await call({
      name: "nexus_workflow_prepare_execution",
      args: { missionId: MISSION_ID },
      snapshot: current,
      handler: prepareHandler,
      options: {
        resolveGuidedPrevcMcpFence: () => current,
      },
    });
    expect(prepared.result).toMatchObject({
      ok: true,
      result: { state: "execution" },
    });
    expect(prepareHandler).toHaveBeenCalledOnce();
  });

  it("preserves the non-guided dispatch path", async () => {
    const handler = vi.fn(async () => ({ delegated: true }));
    const selected = tool("nexus_route_task", handler);
    const result = await dispatchToolCall(
      "http-mcp",
      selected.registry,
      "nexus_route_task",
      { task: "ordinary mission" },
      maestro(),
      dispatchOptions(() => INACTIVE_GUIDED_PREVC_MCP_FENCE),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { delegated: true },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", []],
    ["corrupt", ["NEXUS_SCHEDULE_META:{broken}\n---\nExecutar"]],
    ["legacy", [detail("manual-specialty")]],
  ])(
    "keeps the unfrozen execution assertion active with %s task metadata",
    async (_label, _taskDetails) => {
      const { assertUnfrozenGuidedExecutionEffectAllowed } =
        await import("./mcp-dispatch");
      expect(() =>
        assertUnfrozenGuidedExecutionEffectAllowed(approvedMission()),
      ).toThrow(
        /guided_prevc_required.*context_doctor.*freeze_contract.*stage=execution/i,
      );
    },
  );

  it("retains the unfrozen path for a manual specialty mission", async () => {
    const { assertUnfrozenGuidedExecutionEffectAllowed } =
      await import("./mcp-dispatch");
    expect(() =>
      assertUnfrozenGuidedExecutionEffectAllowed({
        ...approvedMission(),
        squadId: "saved-specialty-squad",
      }),
    ).not.toThrow();
  });

  it("fails closed for mixed sealed topology even on a manual saved squad", async () => {
    const { assertUnfrozenGuidedExecutionEffectAllowed } =
      await import("./mcp-dispatch");
    expect(() =>
      assertUnfrozenGuidedExecutionEffectAllowed(
        {
          ...approvedMission(),
          squadId: "saved-specialty-squad",
        },
        "invalid",
      ),
    ).toThrow(
      /guided_plan_mixed_topology_blocked.*replaneje.*reaprove/i,
    );
  });
});
