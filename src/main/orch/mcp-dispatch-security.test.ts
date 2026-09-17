import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PET_STUDIO_SQUAD } from "../../shared/pet-studio";
import {
  clearAuditLogForTests,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  readAuditLog,
} from "../jarvis/audit-log";
import { clearAll as clearAllPermissions } from "../jarvis/permissions";
import { bindTokenToSession, mintToken, releaseSessionByToken, resetGateForTests } from "./gate";
import { DENIAL_HINTS, dispatchToolCall } from "./mcp-dispatch";
import type { McpDispatchOptions } from "./mcp-dispatch";
import type { IntentGateMissionResolver } from "./mcp-dispatch";
import {
  CONTEXT_DRAFT_REVIEW_SKILLS,
  CONTEXT_DRAFT_REVIEW_TOOLS,
} from "./prevc-reviewer-profile";
import type { McpRegistry, McpToolDef } from "./mcp-protocol";
import type { Mission } from "../../shared/orch-types";
import { buildDomainTools } from "./tools-domain";
import * as domainStores from "./project-domain-store-registry";
import * as completion from "./civilian-delivery-completion";
import * as squads from "./squad-store";
import * as paneRegistry from "./pane-registry";
import { ProcessGitRunner } from "../runtime/git-command";
import { testProjectScope } from "./__tests__/scope-fixture";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  bumpMissionPromptIntent,
  peekMissionPromptQueue,
  resetMissionPromptQueues,
} from "./mission-prompt-queue-registry";

/**
 * Production workflow authority seam: the real PREVC registry is not booted in
 * this file, so the default mimics an uninitialized registry. Individual tests
 * override it to exercise the permissive (no frozen contract) and frozen
 * branches of the production resolver.
 */
const workflowRegistryMocks = vi.hoisted(() => ({
  getContextWorkflowService: vi.fn((): unknown => {
    throw new Error("context workflow service is not initialized");
  }),
}));

vi.mock("../context/context-workflow-registry", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../context/context-workflow-registry")
    >();
  return {
    ...original,
    getContextWorkflowService: workflowRegistryMocks.getContextWorkflowService,
  };
});

/**
 * This suite exercises mcp-dispatch's own gating (role/allowlist/intent/PREVC),
 * not mission-leadership resolution — that has its own dedicated test suite
 * (mission-leader-gate.test.ts). Default: the mocked domain store's current
 * `orchestratorSessionId` (when a test configured one, e.g. via
 * `completedPushDispatchFixture`) is treated as the proven leader, so tests
 * that mutate that field to simulate staleness keep working unmodified; tests
 * that never configure a mission store fall back to trusting the caller's own
 * session. Individual tests still override this to exercise
 * stale-session/split-brain denial directly at the dispatch boundary.
 */
const missionLeaderGateMocks = vi.hoisted(() => ({
  requireMissionLeaderSession: vi.fn(
    (
      scope: unknown,
      missionId: string,
      ctx: { sessionId?: string | null },
    ): import('./mission-leader-gate').MissionLeaderGateResult => {
      const fallback = {
        ok: true as const,
        leader: {
          sessionId: ctx.sessionId ?? "security-test-leader",
          paneId: null,
          source: "live" as const,
          proven: true,
        },
      };
      let durableSessionId: string | null | undefined;
      try {
        durableSessionId = (
          domainStores.getProjectDomainStores as (
            s: unknown,
          ) => { missions: { get(id: string): { orchestratorSessionId?: string | null } | null } }
        )(scope).missions.get(missionId)?.orchestratorSessionId;
      } catch {
        // No mission store configured for this test — trust the caller.
        return fallback;
      }
      if (
        durableSessionId &&
        Object.hasOwn(ctx, "sessionId") &&
        ctx.sessionId !== durableSessionId
      ) {
        return {
          ok: false as const,
          code: "stale-session" as const,
          hint: "outra sessão assumiu a missão",
        };
      }
      return durableSessionId
        ? {
            ok: true as const,
            leader: {
              sessionId: durableSessionId,
              paneId: null,
              source: "live" as const,
              proven: true,
            },
          }
        : fallback;
    },
  ),
}));
vi.mock("./mission-leader-gate", () => ({
  requireMissionLeaderSession: missionLeaderGateMocks.requireMissionLeaderSession,
}));

const testDir = path.join(os.tmpdir(), "nexus-mcp-dispatch-security");
const auditScope = testProjectScope({ rootRealPath: testDir });
const auditContext = { scope: auditScope } as const;
let auditManager: ProjectRuntimeManager;

function registryWith(tool: McpToolDef): McpRegistry {
  return {
    tools: [tool],
    serverName: "nexus-security-test",
    serverVersion: "0.0.1",
  };
}

function userContext() {
  resetGateForTests();
  return mintToken({
    label: "security-test",
    role: "user",
    scope: auditScope,
  });
}

const TEST_MISSION_ID = "mission-security-test";
const TEST_CONTEXT_REVISION = "context-revision-security-test";

function missionContext(
  contextRevision?: string,
  allowedTools: string[] | null = null,
  governedNativeProvider?: "codex",
) {
  resetGateForTests();
  return mintToken({
    label: "security-test",
    role: "worker",
    missionId: TEST_MISSION_ID,
    contextRevision,
    providerId: governedNativeProvider,
    governedNativeProvider,
    scope: auditScope,
    allowedTools,
    allowedSkills: null,
  });
}

function orchestratorMissionContext() {
  resetGateForTests();
  return mintToken({
    label: "security-test-orchestrator",
    role: "orchestrator",
    missionId: TEST_MISSION_ID,
    scope: auditScope,
  });
}

function petStudioMissionContext() {
  resetGateForTests();
  const maker = PET_STUDIO_SQUAD.agents[0]!;
  return mintToken({
    label: maker.agentName,
    role: "orchestrator",
    missionId: TEST_MISSION_ID,
    agentName: maker.agentName,
    providerId: "codex",
    petStudioMediaAuthority: true,
    petStudioAuthoritySource: "legacy-squad",
    petStudioSquadId: PET_STUDIO_SQUAD.id,
    scope: auditScope,
    allowedTools: [...(maker.allowedTools ?? [])],
    allowedSkills: [...(maker.allowedSkills ?? [])],
  });
}

function dispatchedMissionFixture(): NonNullable<
  ReturnType<IntentGateMissionResolver>
> {
  return {
    mission: {
      id: TEST_MISSION_ID,
      title: "Security test mission",
      description: "dispatched for security tests",
      status: "running" as const,
      milestones: [],
      learnings: "",
      intentState: "dispatched" as const,
      intentVersion: 1,
      intentContract: {
        version: 1 as const,
        source: "typed" as const,
        goal: "security test goal",
        acceptanceCriteria: ["ok"],
        risk: "normal" as const,
        executionMode: "assisted" as const,
        contextPolicy: "on-demand" as const,
        intentVersion: 1,
        approvedAt: Date.now(),
        budgets: {
          planningTokens: 1200,
          executionTokens: 8000,
          maxWorkers: 2,
        },
      },
      createdAt: 1,
      updatedAt: 1,
    },
    taskCount: 1,
    workerPaneCount: 0,
  };
}

function opsMissionFixture(): NonNullable<
  ReturnType<IntentGateMissionResolver>
> {
  const base = dispatchedMissionFixture();
  return {
    ...base,
    mission: {
      ...base.mission,
      intentContract: {
        ...base.mission.intentContract!,
        goal: "fazer backup na VPS e subir a landing page",
        lane: "ops" as const,
        budgets: {
          ...base.mission.intentContract!.budgets,
          maxWorkers: 0,
        },
      },
    },
  };
}

function workflowOptions(
  options: Pick<McpDispatchOptions, "confirm"> = {},
): McpDispatchOptions {
  return {
    ...options,
    resolveWorkflowAuthority: (_scope, missionId) => {
      if (missionId !== TEST_MISSION_ID) throw new Error("wrong test mission");
      return {
        contextRevision: TEST_CONTEXT_REVISION,
        assertExecutionEffectAllowed: () => undefined,
      };
    },
    // Tests do not boot the full domain registry — inject a dispatched mission.
    resolveMissionForIntentGate: (_scope, missionId) => {
      if (missionId !== TEST_MISSION_ID) return null;
      return dispatchedMissionFixture();
    },
    reserveMissionBudget: () => undefined,
  };
}

function opsWorkflowOptions(
  options: Pick<McpDispatchOptions, "confirm"> = {},
): McpDispatchOptions {
  return {
    ...workflowOptions(options),
    resolveWorkflowAuthority: (_scope, missionId) => {
      if (missionId !== TEST_MISSION_ID) throw new Error("wrong test mission");
      return {
        contextRevision: undefined,
        assertExecutionEffectAllowed: () => undefined,
      };
    },
    resolveMissionForIntentGate: (_scope, missionId) =>
      missionId === TEST_MISSION_ID ? opsMissionFixture() : null,
  };
}

function standardWorkflowOptions(
  options: Pick<McpDispatchOptions, "confirm"> = {},
): McpDispatchOptions {
  return {
    ...workflowOptions(options),
    resolveWorkflowAuthority: (_scope, missionId) => {
      if (missionId !== TEST_MISSION_ID) throw new Error("wrong test mission");
      return {
        contextRevision: undefined,
        assertExecutionEffectAllowed: () => undefined,
      };
    },
  };
}

function completedPushDispatchFixture() {
  const ctx = orchestratorMissionContext();
  bindTokenToSession(ctx.token, 'push-session');
  let state = dispatchedMissionFixture();
  const update = (patch: Partial<Mission>) => {
    state = { ...state, mission: { ...state.mission, ...patch } };
  };
  update({ squadId: 'push-squad', orchestratorSessionId: 'push-session' });
  vi.spyOn(domainStores, 'getProjectDomainStores').mockReturnValue({
    missions: { get: () => state.mission, appendLearning: vi.fn() },
  } as never);
  vi.spyOn(squads, 'getSquad').mockReturnValue(null);
  const reconcile = vi.spyOn(completion, 'maybeCompleteFastLaneOnDelivery');
  const push = vi.spyOn(ProcessGitRunner.prototype, 'run')
    .mockReturnValue({ status: 0, stdout: 'Pushed to local fixture', stderr: '' });
  const tool = buildDomainTools().find((item) => item.name === 'nexus_mission_set_status')!;
  const finish = () => update({ status: 'done', intentState: 'done',
    result: { outcome: 'success', summary: 'Verified fixture', evidenceIds: [], artifactRefs: [] } });
  return {
    ctx, reconcile, push, finish, update,
    run: (caller = ctx) => dispatchToolCall('http-mcp', registryWith(tool), tool.name,
      { missionId: TEST_MISSION_ID, status: 'done', push: { remote: 'origin' } }, caller,
      { ...workflowOptions(), resolveMissionForIntentGate: () => state }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("MCP dispatch effect safety", () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    auditManager = new ProjectRuntimeManager({
      baseDir: path.join(testDir, "audit-runtime"),
      appVersion: "security-test",
    });
    configureAuditLogRuntime(auditManager);
  });

  beforeEach(() => {
    configureAuditLogRuntime(auditManager);
    clearAuditLogForTests(auditContext);
    workflowRegistryMocks.getContextWorkflowService.mockReset();
    workflowRegistryMocks.getContextWorkflowService.mockImplementation(() => {
      throw new Error("context workflow service is not initialized");
    });
    auditManager
      .open(auditScope)
      .db.prepare(
        `INSERT OR IGNORE INTO missions
         (id, title, description, status, milestones_json, created_at, updated_at)
       VALUES (?, ?, '', 'running', '[]', ?, ?)`,
      )
      .run(TEST_MISSION_ID, "Security test mission", Date.now(), Date.now());
    clearAllPermissions();
    resetMissionPromptQueues();
  });

  afterAll(() => {
    disposeAuditLogRuntime();
    auditManager.closeAll();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("denies workspace and process effects for read-only agents before handlers run", async () => {
    const confirm = vi.fn(async () => true);
    const deniedCases: Array<{
      toolName: string;
      args: Record<string, unknown>;
    }> = [
      { toolName: "nexus_git_commit", args: { message: "must not run" } },
      { toolName: "nexus_git_push", args: {} },
      { toolName: "nexus_route_task", args: { task: "mint forbidden route" } },
      {
        toolName: "nexus_context_draft_apply",
        args: { draftId: "draft-read-only-denied" },
      },
    ];

    for (const { toolName, args } of deniedCases) {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      resetGateForTests();
      const context = mintToken({
        label: "read-only-security-test",
        role: "worker",
        missionId: TEST_MISSION_ID,
        contextRevision: TEST_CONTEXT_REVISION,
        readOnly: true,
        scope: auditScope,
        allowedTools: null,
      });

      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: toolName,
          description: toolName,
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        toolName,
        args,
        context,
        workflowOptions({ confirm }),
      );

      expect(result, toolName).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("read-only"),
      });
      expect(handler, toolName).not.toHaveBeenCalled();
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it("dispatches image generation only for the exact Pet Studio media marker", async () => {
    const handler = vi.fn(async () => ({ generated: true }));
    const confirm = vi.fn(async () => true);
    const tool: McpToolDef = {
      name: "nexus_image_generate",
      description: "image",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
      requiresConfirm: true,
      handler,
    };
    const pet = petStudioMissionContext();
    const accepted = await dispatchToolCall(
      "http-mcp",
      registryWith(tool),
      tool.name,
      { prompt: "canonical pet base" },
      pet,
      standardWorkflowOptions({ confirm }),
    );

    expect(accepted).toMatchObject({
      ok: true,
      tool: "nexus_image_generate",
      result: { generated: true },
    });
    expect(handler).toHaveBeenCalledOnce();
    // The already-approved autopilot mission does not add a second modal.
    expect(confirm).not.toHaveBeenCalled();

    handler.mockClear();
    confirm.mockClear();
    resetGateForTests();
    const maker = PET_STUDIO_SQUAD.agents[0]!;
    const ordinary = mintToken({
      label: "ordinary-orchestrator",
      role: "orchestrator",
      missionId: TEST_MISSION_ID,
      scope: auditScope,
      allowedTools: [...(maker.allowedTools ?? [])],
    });
    const denied = await dispatchToolCall(
      "http-mcp",
      registryWith(tool),
      tool.name,
      { prompt: "must not run" },
      ordinary,
      standardWorkflowOptions({ confirm }),
    );

    expect(denied).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("outside this agent's allowlist"),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    {
      toolName: "nexus_file_write",
      args: {
        path: ".agents/skills/post-scan/SKILL.md",
        content: "# injected",
      },
      error: "Codex control path",
    },
    {
      toolName: "nexus_editor_apply_patch",
      args: {
        patch:
          "[packages/app/.codex/skills/post-scan/SKILL.md#1A2B]\n" +
          "INS.HEAD:\n+# injected\n",
      },
      error: "Codex control path",
    },
    {
      toolName: "nexus_terminal_run",
      args: { command: "mkdir -p .agents/skills/post-scan" },
      error: "inherited Codex process sandbox",
    },
    {
      toolName: "nexus_bg_run",
      args: { command: "mkdir -p .codex/skills/post-scan" },
      error: "inherited Codex process sandbox",
    },
    {
      toolName: "nexus_git_branch_switch",
      args: { name: "attacker-with-new-skill" },
      error: "inherited Codex process sandbox",
    },
  ])(
    "closes the null/null, no-PREVC SkillsWatcher bypass through $toolName",
    async ({ toolName, args, error }) => {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const confirm = vi.fn(async () => true);
      const context = missionContext(undefined, null, "codex");
      expect(context).toMatchObject({
        allowedTools: null,
        allowedSkills: null,
        governedNativeProvider: "codex",
      });
      expect(context.contextRevision).toBeUndefined();
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: toolName,
          description: toolName,
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        toolName,
        args,
        context,
        standardWorkflowOptions({ confirm }),
      );

      expect(result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining(error),
      });
      expect(handler).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("blocks an initially unbound worker on both the first and repeated main-owned process call", async () => {
    const handler = vi.fn(async () => ({ shouldNotRun: true }));
    const confirm = vi.fn(async () => true);
    const registry = registryWith({
      name: "nexus_terminal_run",
      description: "terminal",
      inputSchema: { type: "object", properties: {} },
      handler,
    });
    const context = missionContext(undefined, null, "codex");

    const first = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      { command: "npm test" },
      context,
      standardWorkflowOptions({ confirm }),
    );
    const repeated = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      { command: "npm test" },
      context,
      standardWorkflowOptions({ confirm }),
    );

    expect(first).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("inherited Codex process sandbox"),
    });
    expect(repeated).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("inherited Codex process sandbox"),
    });
    expect(context.contextRevision).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skips per-action confirmation for an approved mission (autopilot)", async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const confirm = vi.fn(async () => true);
    const registry = registryWith({
      name: "nexus_terminal_run",
      description: "terminal",
      inputSchema: { type: "object", properties: {} },
      handler,
    });
    const context = missionContext();
    const args = { command: 'ssh vps "hostname && uptime"' };

    const first = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      args,
      context,
      opsWorkflowOptions({ confirm }),
    );
    const second = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      args,
      context,
      opsWorkflowOptions({ confirm }),
    );
    const testRun = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      { command: "npm test" },
      context,
      opsWorkflowOptions({ confirm }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(testRun.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(3);
    // A aprovação da missão é a autorização: nada de modal por ação.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cron muta dentro de missão aprovada SEM modal (N1: zero fricção)", async () => {
    // Antes este teste exigia o modal. A mudança de agenda continua sendo um
    // risco real — ela dispara depois que a missão acaba — mas a resposta passou
    // a ser desfazer + registro visível (cron-reversibility.ts), não interromper
    // uma missão que o dono já aprovou. `confirm` recusaria; ninguém o consulta.
    const handler = vi.fn(async () => ({ created: true }));
    const confirm = vi.fn(async () => false);
    const registry = registryWith({
      name: "nexus_cron",
      description: "persistent cron",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_cron",
      { action: "create", name: "nightly" },
      missionContext(undefined, ["nexus_cron"]),
      workflowOptions({ confirm }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("minta o recibo exato de mutação de cron sem passar por modal", async () => {
    const handler = vi.fn(
      async (
        _args: Record<string, unknown>,
        _ctx: unknown,
        invocation?: {
          exactUserConsent?: {
            toolName: string;
            action: string;
            grantedAt: number;
            receiptId: string;
          };
        },
      ) => invocation?.exactUserConsent,
    );
    const confirm = vi.fn(async () => true);
    const registry = registryWith({
      name: "nexus_cron",
      description: "persistent cron",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_cron",
      { action: "create", name: "nightly" },
      missionContext(undefined, ["nexus_cron"]),
      workflowOptions({ confirm }),
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        toolName: "cron",
        action: "create",
        grantedAt: expect.any(Number),
        receiptId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      },
    });
    // O ponto do teste depois da N1: o recibo é mintado pela aprovação da
    // missão, NÃO por um clique. Sem isto, cron-runtime.ts:354 recusaria gravar
    // com cron_exact_consent_required e "tirar o prompt" teria quebrado o cron.
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps cron list observational inside an approved mission", async () => {
    const handler = vi.fn(async () => []);
    const confirm = vi.fn(async () => false);
    const registry = registryWith({
      name: "nexus_cron",
      description: "persistent cron",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_cron",
      { action: "list" },
      missionContext(undefined, ["nexus_cron"]),
      workflowOptions({ confirm }),
    );

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("auto-approves destructive commands in an approved mission (paridade com o modo vibe)", async () => {
    // Decisão 09/09 ("mesma doutrina"): a missão aprovada não pergunta nada —
    // o piso destrutivo saiu também da missão. A reversibilidade continua
    // sendo preparada quando existir; não bloqueia quando não existir.
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const confirm = vi.fn(async () => false);
    const registry = registryWith({
      name: "nexus_terminal_run",
      description: "terminal",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      { command: "rm -rf ~/projeto" },
      missionContext(),
      opsWorkflowOptions({ confirm }),
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, tool: "nexus_terminal_run" });
  });

  it.each([
    "nexus_catalog_install",
    "catalog_install",
    "nexus_agent_spec_write",
    "agent_spec_write",
    "nexus_squad_save",
    "squad_save",
  ])(
    "routes global instruction mutation %s exclusively to exact native review",
    async (toolName) => {
      const handler = vi.fn(async () => ({ ok: true }));
      const confirm = vi.fn(async () => true);
      const registry = registryWith({
        name: toolName,
        description: "global instruction mutation",
        inputSchema: { type: "object", properties: {} },
        handler,
      });

      const result = await dispatchToolCall(
        "http-mcp",
        registry,
        toolName,
        toolName.includes("catalog")
          ? { kind: "agent", slug: "reviewer" }
          : toolName.includes("squad")
            ? { squad: { id: "reviewers", name: "Reviewers", agents: [] } }
            : { name: "reviewer", systemPrompt: "sensitive suffix" },
        missionContext(undefined, [toolName]),
        workflowOptions({ confirm }),
      );

      expect(result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("renderer_exact_confirmation_required"),
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("denies at the intent gate (no modal) when the mission has no current approval", async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const confirm = vi.fn(async () => true);
    const registry = registryWith({
      name: "nexus_terminal_run",
      description: "terminal",
      inputSchema: { type: "object", properties: {} },
      handler,
    });
    const options = workflowOptions({ confirm });
    options.resolveMissionForIntentGate = (_scope, missionId) => {
      if (missionId !== TEST_MISSION_ID) return null;
      const fixture = dispatchedMissionFixture();
      return {
        ...fixture,
        mission: {
          ...fixture.mission,
          status: 'pending',
          intentContract: {
            ...fixture.mission.intentContract!,
            approvedAt: undefined,
          },
        },
      };
    };

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      { command: "npm test" },
      missionContext(),
      options,
    );

    // Sem aprovação corrente, o intent gate nega antes de qualquer confirmação.
    expect(result.ok).toBe(false);
    expect(result.denied).toBe(true);
    expect(String(result.error)).toMatch(/dispatch_required|approval_required/);
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks an unbound user effect before confirmation or handler execution", async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "ipc-renderer",
      registryWith({
        name: "nexus_terminal_run",
        description: "terminal",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_terminal_run",
      { command: "npm test" },
      userContext(),
      { confirm },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("missionId and contextRevision"),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies unbound bootstrap and handoff effects at the dispatch boundary", async () => {
    for (const toolName of ["nexus_context_doctor", "nexus_handoff_submit"]) {
      const handler = vi.fn(async () => ({ ok: true }));
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: toolName,
          description: "mission-bound effect",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        toolName,
        toolName === "nexus_handoff_submit"
          ? {
              status: "partial",
              summary: "A real handoff summary for the test.",
            }
          : {},
        userContext(),
      );

      expect(result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("mission"),
      });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("deixa a mão do operador (user, sem missão) spawnar e falar com panes sem modal", async () => {
    // Campo 09/09: pane aberto pelo operador, agente pede outro pane e leva
    // "mission effect blocked". Estreito: só pane_spawn/write/ask/close. E o
    // pedido de confirmação por pane era a fricção ("toda hora pedindo isto"):
    // a mão do operador é autoridade; o modal só volta para texto destrutivo.
    for (const [toolName, args] of [
      ["nexus_pane_spawn", { adapterId: "codex", prompt: "oi" }],
      ["nexus_pane_write", { paneId: "pane-1", text: "oi" }],
      ["nexus_pane_write_many", { writes: [{ paneId: "pane-1", text: "oi" }] }],
      ["nexus_pane_ask", { paneId: "pane-1", question: "oi" }],
      ["nexus_pane_close", { paneId: "pane-1" }],
    ] as const) {
      const handler = vi.fn(async () => ({ ok: true }));
      const confirm = vi.fn(async () => true);
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: toolName,
          description: "operator pane effect",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        toolName,
        args,
        userContext(),
        { confirm },
      );
      expect(result).not.toMatchObject({ denied: true });
      expect(result).toMatchObject({ ok: true, tool: toolName });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
    }
  });

  it("modo vibe: texto destrutivo do operador sem missão também passa, com aviso", async () => {
    // Decisão 09/09: "sem cabresto nenhum, só auditoria depois". O dispatch
    // libera e emite `[vibe]` no log; o registro de auditoria continua.
    const handler = vi.fn(async () => ({ ok: true }));
    const confirm = vi.fn(async () => false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_pane_write",
          description: "operator pane effect",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        "nexus_pane_write",
        { paneId: "pane-1", text: "npm test; rm -rf /tmp/nexus-f148" },
        userContext(),
        { confirm },
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, tool: "nexus_pane_write" });
      expect(handler).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[vibe]"));
    } finally {
      warn.mockRestore();
    }
  });

  it("modo vibe: terminal_run/file_write/git_commit do operador sem missão passam sem modal", async () => {
    for (const [toolName, args] of [
      ["nexus_terminal_run", { command: "npm test" }],
      ["nexus_file_write", { path: "src/x.ts", content: "x" }],
      ["nexus_git_commit", { message: "vibe" }],
    ] as const) {
      const handler = vi.fn(async () => ({ ok: true }));
      const confirm = vi.fn(async () => false);
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: toolName,
          description: "vibe",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        toolName,
        args,
        userContext(),
        { confirm },
      );
      expect(result).not.toMatchObject({ denied: true });
      expect(result).toMatchObject({ ok: true, tool: toolName });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
    }
  });

  it("modo vibe não vale para worker sem missão", async () => {
    resetGateForTests();
    const worker = mintToken({ label: "orfao", role: "worker", scope: auditScope, allowedTools: null, allowedSkills: null });
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({ name: "nexus_terminal_run", description: "x", inputSchema: { type: "object", properties: {} }, handler }),
      "nexus_terminal_run",
      { command: "npm test" },
      worker,
    );
    expect(result).toMatchObject({ ok: false, denied: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("worker sem missão continua barrado no pane_spawn", async () => {
    resetGateForTests();
    const worker = mintToken({ label: "orfao", role: "worker", scope: auditScope, allowedTools: null, allowedSkills: null });
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({ name: "nexus_pane_spawn", description: "x", inputSchema: { type: "object", properties: {} }, handler }),
      "nexus_pane_spawn",
      { adapterId: "codex" },
      worker,
    );
    expect(result).toMatchObject({ ok: false, denied: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts workspace handoff only for a live operator child without stale context", async () => {
    const ctx = userContext();
    bindTokenToSession(ctx.token, 'workspace-child');
    const parent = mintToken({ label: 'parent', role: 'user', scope: auditScope });
    bindTokenToSession(parent.token, 'workspace-parent');
    vi.spyOn(paneRegistry, 'getPaneRuntimeAuthorityBySession').mockImplementation(sessionId => ({
      paneId: `pane-${sessionId}`, sessionId, kind: 'cli-agent', scope: auditScope,
      owner: null, ...(sessionId === 'workspace-child' ? { operatorParentSessionId: 'workspace-parent' } : {}),
    }));
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = { name: 'nexus_handoff_submit', description: 'workspace handoff', inputSchema: { type: 'object', properties: {} }, handler };
    const run = () => dispatchToolCall('http-mcp', registryWith(tool), tool.name, {}, ctx);
    expect(await run()).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    ctx.contextRevision = 'stale';
    expect(await run()).toMatchObject({ ok: false });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("handoff sem missão pela mão do operador recusa ensinando o caminho", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({ name: "nexus_handoff_submit", description: "x", inputSchema: { type: "object", properties: {} }, handler }),
      "nexus_handoff_submit",
      { status: "success", summary: "handoff de teste" },
      userContext(),
    );
    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("missionId and contextRevision"),
      hint: expect.stringContaining("nexus_pane_write"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows memory_retain as a missionless free-pane effect (bootstrap exemption)", async () => {
    // A memória agentic é compartilhada por todas as CLIs hospedadas; retain
    // precisa rodar em pane livre (sem missão). A exención é ESTREITA por nome:
    // o teste acima prova que context_doctor (também bootstrap-authority) segue
    // bloqueado sem missão.
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_memory_retain",
        description: "agentic memory retain",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_memory_retain",
      { content: "projeto usa better-sqlite3", kind: "fact" },
      userContext(),
    );

    expect(result).not.toMatchObject({ denied: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("allows context_draft_review from an unbound independent reviewer pane", async () => {
    // Drafts de contexto de projeto têm missionId nulo e o reviewer pane é
    // deliberadamente spawnado sem vínculo de missão (independência do autor;
    // cli-context-draft-reviewer só vincula quando o draft tem missão). A
    // autoridade real vive no handler: reviewer ≠ autor, provider distinto e
    // re-hash das fontes (context-draft-store.review). Exención ESTREITA por
    // nome, como memory_retain — context_doctor segue bloqueado sem missão.
    resetGateForTests();
    const reviewerContext = mintToken({
      label: "context-reviewer-test",
      role: "worker",
      scope: auditScope,
    });
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_context_draft_review",
        description: "independent context draft review",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_context_draft_review",
      {
        draftId: "draft-test-1",
        decision: "approve",
        rationale: "sources re-verified against the checkout.",
      },
      reviewerContext,
    );

    expect(result).not.toMatchObject({ denied: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("allows a confirmed renderer UI action without mission authority", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "ipc-renderer",
      registryWith({
        name: "nexus_ui_action",
        description: "bounded main-authorized Nexus UI action",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_ui_action",
      { action: "click", ref: "u1e1" },
      userContext(),
      { confirm },
    );

    expect(result).toMatchObject({ ok: true, userAuthorized: true });
    expect(confirm).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects UI action authority outside the renderer user boundary", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_ui_action",
        description: "bounded main-authorized Nexus UI action",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_ui_action",
      { action: "click", ref: "u1e1" },
      userContext(),
      { confirm },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("renderer user authority"),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores stale registry confirmation metadata for read-only policy", async () => {
    const handler = vi.fn(async () => ({ text: "safe" }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_read",
        description: "read",
        requiresConfirm: true,
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_read",
      {},
      userContext(),
      { confirm },
    );

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("cannot turn a direct main dispatch into a physical handoff receipt", async () => {
    const handler = vi.fn(async () => ({ stopGateSatisfied: false }));
    const confirm = vi.fn(async () => true);
    const ctx = missionContext();
    bindTokenToSession(ctx.token, "session-handoff-worker");
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_handoff_submit",
        description: "handler-owned handoff authority",
        requiresConfirm: true,
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_handoff_submit",
      { status: "partial", summary: "A bounded test handoff summary." },
      ctx,
      workflowOptions({ confirm }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/physical agent transport boundary/i),
    });
    expect(result.effectMayHaveCommitted).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies orchestrator delegation before intent dispatch (intent-first)", async () => {
    const handler = vi.fn(async () => ({ paneId: "pane-worker" }));
    const confirm = vi.fn(async () => true);
    // Pre-dispatch mission: no approved contract — must not spawn workers.
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_spawn",
        description: "handler-owned bounded delegation",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_spawn",
      { agentName: "worker-a", prompt: "Inspect the dirty checkout." },
      orchestratorMissionContext(),
      {
        confirm,
        resolveMissionForIntentGate: () => ({
          mission: {
            ...dispatchedMissionFixture().mission,
            status: "pending",
            intentState: "awaiting_goal",
            intentContract: undefined,
            description: "",
          },
          taskCount: 0,
          workerPaneCount: 0,
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("dispatch_required"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets a mission orchestrator delegate only after intent dispatch", async () => {
    const handler = vi.fn(async () => ({ paneId: "pane-worker" }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_spawn",
        description: "handler-owned bounded delegation",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_spawn",
      { agentName: "worker-a", prompt: "Inspect the dirty checkout." },
      orchestratorMissionContext(),
      { confirm, ...workflowOptions() },
    );

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("denies delegation from a stale orchestrator token superseded by a new mission leader", async () => {
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false,
      code: "stale-session",
      hint: "outra sessão assumiu a missão",
    });
    const handler = vi.fn(async () => ({ paneId: "pane-worker" }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_spawn",
        description: "handler-owned bounded delegation",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_spawn",
      { agentName: "worker-a", prompt: "Inspect the dirty checkout." },
      orchestratorMissionContext(),
      { confirm, ...workflowOptions() },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("stale-session"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies delegation on split-brain instead of picking a winner, and never wedges by throwing raw", async () => {
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false,
      code: "split-brain",
      hint: "duas sessões físicas reivindicam a missão",
    });
    const handler = vi.fn(async () => ({ paneId: "pane-worker" }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_spawn",
        description: "handler-owned bounded delegation",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_spawn",
      { agentName: "worker-a", prompt: "Inspect the dirty checkout." },
      orchestratorMissionContext(),
      { confirm, ...workflowOptions() },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("split-brain"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("worker continua worker: a bare worker token never reaches the leader resolver for delegation-authority tools", async () => {
    missionLeaderGateMocks.requireMissionLeaderSession.mockClear();
    const handler = vi.fn(async () => ({ paneId: "pane-worker" }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_spawn",
        description: "handler-owned bounded delegation",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_spawn",
      { agentName: "worker-a", prompt: "Inspect the dirty checkout." },
      missionContext(),
      workflowOptions(),
    );

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(missionLeaderGateMocks.requireMissionLeaderSession).not.toHaveBeenCalled();
  });

  it("revalidates the exact intent after asynchronous confirmation", async () => {
    const handler = vi.fn(async () => ({ bytes: 1 }));
    const base = dispatchedMissionFixture();
    // Missão RUNNING mas SEM aprovação corrente: o intent gate libera e o
    // auto-approve não — é o caminho que ainda abre o modal desde que o piso
    // destrutivo saiu. A revalidação pós-confirmação continua fechando a
    // corrida.
    let current: NonNullable<ReturnType<IntentGateMissionResolver>> = {
      ...base,
      mission: {
        ...base.mission,
        status: "running",
        intentContract: {
          ...base.mission.intentContract!,
          approvedAt: undefined,
        },
      },
    };
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_terminal_run",
        description: "terminal",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_terminal_run",
      // Comando destrutivo: mesmo com missão aprovada o modal dispara — é o
      // caminho onde a revalidação pós-confirmação continua existindo.
      { command: "rm -rf /tmp/nexus-revalidate-intent" },
      missionContext(),
      {
        ...workflowOptions(),
        confirm: async () => {
          current = {
            ...current,
            mission: {
              ...current.mission,
              status: "pending",
              intentState: "ready_to_start",
              intentVersion: 2,
              intentContract: {
                ...current.mission.intentContract!,
                intentVersion: 2,
                approvedAt: undefined,
              },
            },
          };
          return true;
        },
        resolveMissionForIntentGate: () => current,
      },
    );

    expect(result).toMatchObject({ ok: false, denied: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("revalidates the frozen workflow revision after confirmation", async () => {
    // A corrida sob teste (revisão congelada muda DURANTE a confirmação) é a
    // mesma; com a decisão 09/09 a missão RUNNING sem approvedAt corrente é o
    // caminho que abre o modal sem barrar no intent gate.
    const handler = vi.fn(async () => ({ created: true }));
    let revision = TEST_CONTEXT_REVISION;
    const base = dispatchedMissionFixture();
    const unapproved: NonNullable<ReturnType<IntentGateMissionResolver>> = {
      ...base,
      mission: {
        ...base.mission,
        status: "running",
        intentContract: {
          ...base.mission.intentContract!,
          approvedAt: undefined,
        },
      },
    };
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_terminal_run",
        description: "destructive shell",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_terminal_run",
      { command: "rm -rf /tmp/revision-race" },
      missionContext(TEST_CONTEXT_REVISION, ["nexus_terminal_run"]),
      {
        ...workflowOptions(),
        resolveMissionForIntentGate: () => unapproved,
        confirm: async () => {
          revision = "new-context-revision";
          return true;
        },
        resolveWorkflowAuthority: () => ({
          contextRevision: revision,
          assertExecutionEffectAllowed: () => undefined,
        }),
      },
    );

    expect(result).toMatchObject({ ok: false, denied: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when PREVC changes while an effect handler is awaiting", async () => {
    let revision = TEST_CONTEXT_REVISION;
    const handler = vi.fn(async () => {
      revision = "context-revision-refrozen-during-effect";
      return { exitCode: 0 };
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_file_write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_file_write",
      { path: "src/prevc-race.ts", content: "export {};" },
      missionContext(TEST_CONTEXT_REVISION),
      {
        ...workflowOptions(),
        resolveWorkflowAuthority: () => ({
          contextRevision: revision,
          assertExecutionEffectAllowed: () => undefined,
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("workflow_authority_revoked"),
      effectMayHaveCommitted: true,
    });
    expect(handler).toHaveBeenCalledOnce();
    const entries = readAuditLog(auditContext);
    expect(entries.map((entry) => entry.result)).toEqual(["intent", "error"]);
    expect(entries[0]?.invocation_id).toBe(entries[1]?.invocation_id);
  });

  it("fails closed without leaking store details when budget reservation fails", async () => {
    const handler = vi.fn(async () => ({ bytes: 1 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_file_write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_file_write",
      { path: "src/a.ts", content: "x" },
      missionContext(),
      {
        ...workflowOptions({ confirm: async () => true }),
        reserveMissionBudget: () => {
          throw new Error("sqlite failed at /private/secret/runtime.sqlite3");
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: "budget_reservation_unavailable",
    });
    expect(result.error).not.toContain("/private/secret");
    expect(handler).not.toHaveBeenCalled();
    const entries = readAuditLog(auditContext);
    expect(entries.map((entry) => entry.result)).toEqual(["intent", "error"]);
    expect(entries[0]?.invocation_id).toBe(entries[1]?.invocation_id);
  });

  it("never reserves budget when the correlated intent insert fails", async () => {
    const db = auditManager.open(auditScope).db;
    const reserveMissionBudget = vi.fn();
    db.exec(`
      CREATE TEMP TRIGGER reject_effect_intent_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.outcome = 'intent'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic intent audit failure');
      END;
    `);
    try {
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_file_write",
          description: "write",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ bytes: 1 }),
        }),
        "nexus_file_write",
        { path: "src/a.ts", content: "x" },
        missionContext(),
        {
          ...workflowOptions({ confirm: async () => true }),
          reserveMissionBudget,
        },
      );

      expect(result).toMatchObject({ ok: false, error: "audit_unavailable" });
      expect(reserveMissionBudget).not.toHaveBeenCalled();
      expect(readAuditLog(auditContext)).toEqual([]);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_effect_intent_audit");
    }
  });

  it("reserves budget before the handler and keeps the charge when the handler fails", async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => {
      order.push("handler");
      throw new Error("effect failed");
    });
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_spawn",
        description: "spawn",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_spawn",
      { agentName: "worker-a" },
      orchestratorMissionContext(),
      {
        ...workflowOptions(),
        reserveMissionBudget: () => {
          expect(
            readAuditLog(auditContext).map((entry) => entry.result),
          ).toEqual(["intent"]);
          order.push("reserve");
        },
      },
    );

    expect(result).toMatchObject({ ok: false, effectMayHaveCommitted: true });
    expect(order).toEqual(["reserve", "handler"]);
  });

  it("serializes concurrent reservations at maxSteps", async () => {
    let releaseFirst!: () => void;
    const firstHandler = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let state = dispatchedMissionFixture();
    state = {
      ...state,
      mission: {
        ...state.mission,
        intentContract: {
          ...state.mission.intentContract!,
          spentSteps: 0,
          spentTokens: 0,
          budgets: { ...state.mission.intentContract!.budgets, maxSteps: 1 },
        },
      },
    };
    let handlerCalls = 0;
    const handler = vi.fn(async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) await firstHandler;
      return { paneId: "worker" };
    });
    const options: McpDispatchOptions = {
      ...workflowOptions(),
      resolveMissionForIntentGate: () => state,
      // O teto sintético de steps/tokens saiu do gate de intent (ledger é
      // telemetria); a serialização de reservas continua sendo do dispatch —
      // este dep injetado simula QUALQUER reserva que falhe na 2ª chamada
      // concorrente (ex.: approval_required por mudança de contrato).
      reserveMissionBudget: () => {
        const contract = state.mission.intentContract!;
        if ((contract.spentSteps ?? 0) >= (contract.budgets.maxSteps ?? 500)) {
          throw new Error("budget_exhausted: maxSteps reached");
        }
        state = {
          ...state,
          mission: {
            ...state.mission,
            intentContract: {
              ...contract,
              spentSteps: (contract.spentSteps ?? 0) + 1,
              spentTokens: (contract.spentTokens ?? 0) + 100,
            },
          },
        };
      },
    };
    const registry = registryWith({
      name: "nexus_pane_spawn",
      description: "spawn",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const dispatchContext = orchestratorMissionContext();
    const first = dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_spawn",
      {},
      dispatchContext,
      options,
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const second = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_spawn",
      {},
      dispatchContext,
      options,
    );
    releaseFirst();
    const firstResult = await first;

    expect(firstResult.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("budget_exhausted"),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects pre-contract delegation from an unbound worker; the operator's own pane may spawn", async () => {
    const handler = vi.fn(async () => ({ paneId: "must-not-spawn" }));
    const registry = registryWith({
      name: "nexus_pane_spawn",
      description: "bounded delegation",
      inputSchema: { type: "object", properties: {} },
      handler,
    });
    const awaitingOpts: McpDispatchOptions = {
      resolveMissionForIntentGate: () => ({
        mission: {
          ...dispatchedMissionFixture().mission,
          status: "pending",
          intentState: "awaiting_goal",
          intentContract: undefined,
          description: "",
        },
        taskCount: 0,
        workerPaneCount: 0,
      }),
    };

    const fromUser = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_spawn",
      {},
      userContext(),
      awaitingOpts,
    );
    const fromWorker = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_spawn",
      {},
      missionContext(),
      awaitingOpts,
    );

    // Campo 09/09: a sessão `user` sem missão é a mão do operador — ela já
    // abre pane pela UI, então pane_spawn via MCP não exige contrato. O
    // worker (preso à missão pré-contrato) continua barrado no intent gate.
    expect(fromUser).toMatchObject({ ok: true });
    expect(fromWorker).toMatchObject({ ok: false, denied: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("permits repository sync only from the renderer-owned user path", async () => {
    const handler = vi.fn(async () => ({ status: "up_to_date" }));
    const registry = registryWith({
      name: "nexus_git_sync",
      description: "narrow local fast-forward",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const fromRenderer = await dispatchToolCall(
      "ipc-renderer",
      registry,
      "nexus_git_sync",
      {},
      userContext(),
    );
    const fromAgent = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_git_sync",
      {},
      missionContext(),
    );

    expect(fromRenderer).toMatchObject({ ok: true });
    expect(fromAgent).toMatchObject({ ok: false, denied: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("lets the exact orchestrator block a mission when bootstrap cannot freeze", async () => {
    const handler = vi.fn(async () => ({ status: "blocked" }));
    // Fail-safe demotion to blocked is allowed even before intent dispatch.
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_mission_set_status",
        description: "mission status guarded by its handler",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_mission_set_status",
      { missionId: TEST_MISSION_ID, status: "blocked" },
      orchestratorMissionContext(),
      {
        ...workflowOptions(),
        resolveMissionForIntentGate: () => ({
          mission: {
            ...dispatchedMissionFixture().mission,
            status: "pending",
            intentState: "awaiting_goal",
            intentContract: undefined,
            description: "",
          },
          taskCount: 0,
          workerPaneCount: 0,
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("reports success after mission_set_status durably finishes its own mission", async () => {
    let state = dispatchedMissionFixture();
    const handler = vi.fn(async () => {
      state = {
        ...state,
        mission: {
          ...state.mission,
          status: "done",
          intentState: "done",
        },
      };
      return { status: "done" };
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_mission_set_status",
        description: "finish mission",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_mission_set_status",
      { missionId: TEST_MISSION_ID, status: "done" },
      orchestratorMissionContext(),
      {
        ...workflowOptions(),
        resolveMissionForIntentGate: () => state,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { status: "done" },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs an explicitly requested push after slow verification through the real dispatcher', async () => {
    const f = completedPushDispatchFixture();
    const pending = Promise.withResolvers<void>();
    f.reconcile.mockImplementation(async () => {
      await pending.promise;
      f.finish();
      return { action: 'complete', completed: true } as never;
    });
    const running = f.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.push).not.toHaveBeenCalled();
    pending.resolve();

    expect(await running).toMatchObject({ ok: true, result: { status: 'done', pushExecuted: true } });
    expect(f.push).toHaveBeenCalledExactlyOnceWith(auditScope.rootRealPath, ['push', 'origin'], { timeoutMs: 60_000 });
  });

  it('accepts a fresh done-plus-push retry for the bound orchestrator through the real dispatcher', async () => {
    const f = completedPushDispatchFixture();
    f.finish();

    expect(await f.run()).toMatchObject({ ok: true, result: { pushExecuted: true } });
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledTimes(1);
  });

  it.each(['revoked', 'stale', 'bad-scope'] as const)('rejects completed push with %s authority through the dispatcher', async (failure) => {
    const f = completedPushDispatchFixture();
    f.reconcile.mockImplementation(async () => {
      f.finish();
      if (failure === 'revoked') releaseSessionByToken(f.ctx.token);
      if (failure === 'stale') f.update({ orchestratorSessionId: 'replacement-session' });
      return { action: 'complete', completed: true } as never;
    });
    const caller = failure === 'bad-scope'
      ? { ...f.ctx, scope: { ...f.ctx.scope, checkoutId: 'forged-checkout' } }
      : f.ctx;

    expect(await f.run(caller)).toMatchObject({ ok: false });
    expect(f.push).not.toHaveBeenCalled();
  });

  it("ops lane runs execution effects without a frozen PREVC contract", async () => {
    // PREVC degrada, não bloqueia: sem contrato congelado a autoridade de
    // produção é permissiva e a lane ops executa normalmente.
    workflowRegistryMocks.getContextWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_terminal_run",
        description: "terminal",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_terminal_run",
      { command: 'ssh vps "tar czf /backups/www.tgz /var/www"' },
      missionContext(),
      {
        confirm: async () => true,
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === TEST_MISSION_ID ? opsMissionFixture() : null,
        reserveMissionBudget: () => undefined,
      },
    );

    expect(result).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("standard lane executes without a frozen contract (PREVC degrades, never blocks)", async () => {
    workflowRegistryMocks.getContextWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_terminal_run",
        description: "terminal",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_terminal_run",
      { command: "npm test" },
      missionContext(),
      {
        confirm: async () => true,
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === TEST_MISSION_ID ? dispatchedMissionFixture() : null,
        reserveMissionBudget: () => undefined,
      },
    );

    expect(result).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("file_write executes without a frozen contract", async () => {
    workflowRegistryMocks.getContextWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });
    const handler = vi.fn(async () => ({ bytes: 1 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_file_write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_file_write",
      { path: "src/a.ts", content: "x" },
      missionContext(),
      {
        confirm: async () => true,
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === TEST_MISSION_ID ? dispatchedMissionFixture() : null,
        reserveMissionBudget: () => undefined,
      },
    );

    expect(result).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps .context/ read-only without a frozen contract (path target)", async () => {
    workflowRegistryMocks.getContextWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });
    const handler = vi.fn(async () => ({ bytes: 1 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_file_write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_file_write",
      { path: ".context/config/policy.json", content: "x" },
      missionContext(),
      {
        confirm: async () => true,
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === TEST_MISSION_ID ? dispatchedMissionFixture() : null,
        reserveMissionBudget: () => undefined,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining(
        "versioned context authority is read-only to executors",
      ),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps .context/ read-only without a frozen contract (hashline patch target)", async () => {
    workflowRegistryMocks.getContextWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_editor_apply_patch",
        description: "hashline patch",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_editor_apply_patch",
      { patch: "[.context/config/policy.json#1a2b]\nINS.TAIL:\n+{}\n" },
      missionContext(),
      {
        confirm: async () => true,
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === TEST_MISSION_ID ? dispatchedMissionFixture() : null,
        reserveMissionBudget: () => undefined,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining(
        "versioned context authority is read-only to executors",
      ),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("frozen contract outside the execution stage still blocks execution effects", async () => {
    // Com contrato congelado o PREVC funciona como antes: stage errado bloqueia.
    workflowRegistryMocks.getContextWorkflowService.mockReturnValue({
      getMissionWorkflow: () => ({
        contract: { contract: { contextRevision: TEST_CONTEXT_REVISION } },
        workflow: { stage: "planning" },
      }),
      assertMutationAllowed: () => {
        throw new Error("code mutation blocked during workflow stage planning");
      },
    });
    const handler = vi.fn(async () => ({ bytes: 1 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_file_write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_file_write",
      { path: "src/a.ts", content: "x" },
      missionContext(),
      {
        confirm: async () => true,
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === TEST_MISSION_ID ? dispatchedMissionFixture() : null,
        reserveMissionBudget: () => undefined,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining(
        "code mutation blocked during workflow stage planning",
      ),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("ops lane allows repo code mutations at the intent gate", async () => {
    const handler = vi.fn(async () => ({ bytes: 1 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_file_write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_file_write",
      { path: "src/a.ts", content: "x" },
      missionContext(),
      {
        confirm: async () => true,
        resolveWorkflowAuthority: () => ({
          contextRevision: TEST_CONTEXT_REVISION,
          assertExecutionEffectAllowed: () => undefined,
        }),
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === TEST_MISSION_ID ? opsMissionFixture() : null,
        reserveMissionBudget: () => undefined,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { bytes: 1 },
    });
    expect(handler).toHaveBeenCalled();
  });

  it("binds PREVC effects to the frozen context without a human prompt", async () => {
    const handler = vi.fn(async (_args, ctx) => ({
      contextRevision: ctx.contextRevision,
    }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_sensor_run",
        description: "PREVC sensor authority",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_sensor_run",
      { missionId: TEST_MISSION_ID, sensorId: "unit" },
      missionContext(),
      workflowOptions({ confirm }),
    );

    expect(result).toMatchObject({
      ok: true,
      result: { contextRevision: TEST_CONTEXT_REVISION },
      userAuthorized: false,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("accepts a heartbeat from a worker dispatched before the contract freeze", async () => {
    const preFreezeRevision = "context-revision-before-freeze";
    const handler = vi.fn(async (_args, ctx) => ({
      contextRevision: ctx.contextRevision,
    }));
    const resolveWorkflowAuthority = vi.fn(() => ({
      contextRevision: TEST_CONTEXT_REVISION,
      assertExecutionEffectAllowed: () => undefined,
    }));

    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_worker_heartbeat",
        description: "worker liveness receipt",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_worker_heartbeat",
      {},
      missionContext(preFreezeRevision),
      {
        ...workflowOptions(),
        resolveWorkflowAuthority,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { contextRevision: preFreezeRevision },
      userAuthorized: false,
    });
    expect(resolveWorkflowAuthority).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("marks a failed PREVC handler as possibly committed without conflating it with confirmation", async () => {
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_sensor_run",
        description: "PREVC sensor authority",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          throw new Error("sensor receipt transport failed");
        },
      }),
      "nexus_sensor_run",
      { missionId: TEST_MISSION_ID, sensorId: "unit" },
      missionContext(),
      workflowOptions(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "sensor receipt transport failed",
      userAuthorized: false,
      effectMayHaveCommitted: true,
    });
  });

  it("aborts an executing bootstrap handler when a newer intent preempts it", async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const handler = vi.fn(
      async (
        _args: Record<string, unknown>,
        _ctx: unknown,
        invocation?: { signal?: AbortSignal },
      ) => {
        receivedSignal = invocation?.signal;
        releaseStarted();
        await new Promise<void>((_resolve, reject) => {
          if (invocation?.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          invocation?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
        return { refreshed: true };
      },
    );
    const pending = dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_code_map_refresh",
        description: "warm orientation",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_code_map_refresh",
      {},
      orchestratorMissionContext(),
      workflowOptions(),
    );
    await started;
    bumpMissionPromptIntent(auditScope, TEST_MISSION_ID, 2);
    const result = await pending;
    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("intent_preempted"),
      effectMayHaveCommitted: true,
    });
  });

  it("allows a mission-bound read-only child while its orchestrator awaits review", async () => {
    let releaseParent!: () => void;
    const parentWait = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const parentHandler = vi.fn(async () => {
      await parentWait;
      return { paneId: "reviewer-pane" };
    });
    const childGetHandler = vi.fn(async () => ({ status: "proposed" }));
    const childReviewHandler = vi.fn(async () => ({ status: "approved" }));
    const parentContext = orchestratorMissionContext();
    const parent = dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_context_draft_review_run",
        description: "spawn and await an independent reviewer",
        inputSchema: { type: "object", properties: {} },
        handler: parentHandler,
      }),
      "nexus_context_draft_review_run",
      { draftId: "draft-security-test" },
      parentContext,
      workflowOptions(),
    );
    await vi.waitFor(() => expect(parentHandler).toHaveBeenCalledOnce());

    const childContext = mintToken({
      label: "context-reviewer-security-test",
      role: "worker",
      missionId: TEST_MISSION_ID,
      readOnly: true,
      scope: auditScope,
      allowedTools: ["nexus_context_draft_get", "nexus_context_draft_review"],
    });
    const childRegistry: McpRegistry = {
      serverName: "nexus-security-test",
      serverVersion: "0.0.1",
      tools: [
        {
          name: "nexus_context_draft_get",
          description: "read the bound context draft",
          inputSchema: { type: "object", properties: {} },
          handler: childGetHandler,
        },
        {
          name: "nexus_context_draft_review",
          description: "persist the independent review verdict",
          inputSchema: { type: "object", properties: {} },
          handler: childReviewHandler,
        },
      ],
    };
    const childGet = await dispatchToolCall(
      "http-mcp",
      childRegistry,
      "nexus_context_draft_get",
      { draftId: "draft-security-test" },
      childContext,
      workflowOptions(),
    );
    const childReview = await dispatchToolCall(
      "http-mcp",
      childRegistry,
      "nexus_context_draft_review",
      {
        draftId: "draft-security-test",
        decision: "approve",
        rationale: "The bound sources and hashes match the proposed content.",
      },
      childContext,
      workflowOptions(),
    );

    expect(childGet).toMatchObject({ ok: true });
    expect(childReview).toMatchObject({ ok: true });
    expect(childGetHandler).toHaveBeenCalledOnce();
    expect(childReviewHandler).toHaveBeenCalledOnce();
    expect(
      peekMissionPromptQueue(auditScope, TEST_MISSION_ID).executing?.body,
    ).toBe("nexus_context_draft_review_run");

    releaseParent();
    await expect(parent).resolves.toMatchObject({ ok: true });
  });

  it("blocks a stale token whose revision differs from the frozen contract", async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_terminal_run",
        description: "terminal",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_terminal_run",
      { command: "npm test" },
      missionContext("stale-context-revision"),
      workflowOptions({ confirm: async () => true }),
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining("does not match the frozen mission"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps read-only calls prompt-free across repeated invocations", async () => {
    const handler = vi.fn(async () => ({ text: "safe" }));
    const confirm = vi.fn(async () => true);
    const registry = registryWith({
      name: "nexus_pane_read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      handler,
    });
    const context = userContext();

    await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_read",
      {},
      context,
      {
        confirm,
      },
    );
    await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_read",
      {},
      context,
      {
        confirm,
      },
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not start a handler when scoped audit persistence is unavailable", async () => {
    const handler = vi.fn(async () => ({ text: "must not run" }));
    disposeAuditLogRuntime();

    const result = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_pane_read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        handler,
      }),
      "nexus_pane_read",
      {},
      userContext(),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("audit_unavailable"),
    });
    configureAuditLogRuntime(auditManager);
  });

  it("routes audit events from the immutable dispatch context, not global UI state", async () => {
    const scopeB = testProjectScope({
      rootRealPath: testDir,
      checkoutId: "checkout-security-b",
    });
    clearAuditLogForTests({ scope: scopeB });
    const registry = registryWith({
      name: "nexus_pane_read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ text: "ok" }),
    });
    const contextA = userContext();
    const contextB = mintToken({
      label: "security-test-b",
      role: "user",
      scope: scopeB,
    });

    await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_read",
      {},
      contextA,
    );
    await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_pane_read",
      {},
      contextB,
    );

    expect(
      readAuditLog(auditContext).map((entry) => entry.checkout_id),
    ).toEqual([auditScope.checkoutId]);
    expect(
      readAuditLog({ scope: scopeB }).map((entry) => entry.checkout_id),
    ).toEqual([scopeB.checkoutId]);
  });

  it("persists a correlated intent before starting an effectful handler", async () => {
    let entriesSeenByHandler = readAuditLog(auditContext);
    const registry = registryWith({
      name: "nexus_file_write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        entriesSeenByHandler = readAuditLog(auditContext);
        return { bytes: 1 };
      },
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_file_write",
      { path: "src/a.ts", content: "x" },
      missionContext(),
      workflowOptions({ confirm: async () => true }),
    );

    expect(result.ok).toBe(true);
    expect(entriesSeenByHandler).toHaveLength(1);
    expect(entriesSeenByHandler[0]).toMatchObject({
      tool: "nexus_file_write",
      result: "intent",
      user_authorized: true,
      project_id: "project-test",
      checkout_id: "checkout-test",
      context_revision: TEST_CONTEXT_REVISION,
    });
    const entries = readAuditLog(auditContext);
    expect(entries.map((entry) => entry.result)).toEqual(["intent", "ok"]);
    expect(entries[0].invocation_id).toBeTruthy();
    expect(entries[1].invocation_id).toBe(entries[0].invocation_id);
  });

  it("reports effectMayHaveCommitted when outcome auditing fails after the handler ran", async () => {
    const unavailableAuditManager = new ProjectRuntimeManager({
      baseDir: path.join(testDir, "unavailable-audit-runtime"),
      appVersion: "security-test",
      databaseFactory: (() => {
        throw new Error("audit database unavailable");
      }) as never,
    });
    let effectApplied = false;
    const registry = registryWith({
      name: "nexus_file_write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        effectApplied = true;
        configureAuditLogRuntime(unavailableAuditManager);
        return { bytes: 1 };
      },
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_file_write",
      { path: "src/a.ts", content: "x" },
      missionContext(),
      workflowOptions({ confirm: async () => true }),
    );
    configureAuditLogRuntime(auditManager);
    unavailableAuditManager.closeAll();

    expect(effectApplied).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      tool: "nexus_file_write",
      effectMayHaveCommitted: true,
      error: expect.stringContaining("audit_unavailable"),
    });
    expect(readAuditLog(auditContext).map((entry) => entry.result)).toEqual([
      "intent",
    ]);
  });

  it("reports effectMayHaveCommitted when an effectful handler throws after starting", async () => {
    const registry = registryWith({
      name: "nexus_terminal_run",
      description: "terminal",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        throw new Error("connection dropped after write");
      },
    });

    const result = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_terminal_run",
      { command: "deploy" },
      missionContext(),
      opsWorkflowOptions({ confirm: async () => true }),
    );

    expect(result).toMatchObject({
      ok: false,
      effectMayHaveCommitted: true,
      error: "connection dropped after write",
    });
    const entries = readAuditLog(auditContext);
    expect(entries.map((entry) => entry.result)).toEqual(["intent", "error"]);
    expect(entries[1].invocation_id).toBe(entries[0].invocation_id);
  });

  it("closes the correlated audit intent when caller authority disappears after the effect", async () => {
    const caller = new AbortController();
    const registry = registryWith({
      name: "nexus_file_write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        caller.abort("renderer destroyed");
        return { bytes: 1 };
      },
    });

    const result = await dispatchToolCall(
      "ipc-renderer",
      registry,
      "nexus_file_write",
      { path: "src/a.ts", content: "x" },
      missionContext(),
      {
        ...workflowOptions({ confirm: async () => true }),
        callerSignal: caller.signal,
        assertCurrentCaller: () => true,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: "session_authority_revoked",
      effectMayHaveCommitted: true,
    });
    const entries = readAuditLog(auditContext);
    expect(entries.map((entry) => entry.result)).toEqual(["intent", "error"]);
    expect(entries[1].invocation_id).toBe(entries[0].invocation_id);
  });

  it("joins a same-tool warm bootstrap retry instead of denying prompt_queue_busy", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const handler = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return { checked: true };
    });
    const registry = registryWith({
      name: "nexus_context_doctor",
      description: "idempotent context check",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const dispatchContext = orchestratorMissionContext();
    const first = dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_context_doctor",
      {},
      dispatchContext,
      workflowOptions(),
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    // Retry do MESMO tool: faz join (segue direto para o handler) em vez de
    // cancelar com prompt_queue_busy.
    const second = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_context_doctor",
      {},
      dispatchContext,
      workflowOptions(),
    );

    expect(second).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledTimes(2);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("still denies a different warm tool while the bootstrap slot is busy", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const doctorHandler = vi.fn(async () => {
      await firstGate;
      return { checked: true };
    });
    const mapHandler = vi.fn(async () => ({ refreshed: true }));

    const dispatchContext = orchestratorMissionContext();
    const first = dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_context_doctor",
        description: "idempotent context check",
        inputSchema: { type: "object", properties: {} },
        handler: doctorHandler,
      }),
      "nexus_context_doctor",
      {},
      dispatchContext,
      workflowOptions(),
    );
    await vi.waitFor(() => expect(doctorHandler).toHaveBeenCalledTimes(1));

    const second = await dispatchToolCall(
      "http-mcp",
      registryWith({
        name: "nexus_code_map_refresh",
        description: "warm orientation",
        inputSchema: { type: "object", properties: {} },
        handler: mapHandler,
      }),
      "nexus_code_map_refresh",
      {},
      dispatchContext,
      workflowOptions(),
    );

    expect(second).toMatchObject({
      ok: false,
      denied: true,
      error: "prompt_queue_busy",
    });
    expect(mapHandler).not.toHaveBeenCalled();
    const secondIntent = readAuditLog(auditContext).at(-2);
    const secondOutcome = readAuditLog(auditContext).at(-1);
    expect(secondIntent).toMatchObject({
      tool: "nexus_code_map_refresh",
      result: "intent",
    });
    expect(secondOutcome).toMatchObject({
      tool: "nexus_code_map_refresh",
      result: "error",
      error: "prompt_queue_busy",
    });
    expect(secondOutcome?.invocation_id).toBe(secondIntent?.invocation_id);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("still denies a duplicate freeze while freeze is executing (not idempotent)", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = vi.fn(async () => {
      await firstGate;
      return { frozen: true };
    });
    const registry = registryWith({
      name: "nexus_mission_freeze_contract",
      description: "freeze the mission contract",
      inputSchema: { type: "object", properties: {} },
      handler,
    });

    const dispatchContext = orchestratorMissionContext();
    const first = dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_mission_freeze_contract",
      {},
      dispatchContext,
      workflowOptions(),
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const second = await dispatchToolCall(
      "http-mcp",
      registry,
      "nexus_mission_freeze_contract",
      {},
      dispatchContext,
      workflowOptions(),
    );

    expect(second).toMatchObject({
      ok: false,
      denied: true,
      error: "prompt_queue_busy",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  describe("denial hints instruct instead of blocking", () => {
    function internalDraftReviewerContext() {
      resetGateForTests();
      return mintToken({
        label: "context-reviewer-codex-abcdef123456",
        role: "worker",
        missionId: TEST_MISSION_ID,
        agentName: "context-reviewer-codex-abcdef123456",
        providerId: "codex",
        readOnly: true,
        allowedTools: [...CONTEXT_DRAFT_REVIEW_TOOLS],
        allowedSkills: [...CONTEXT_DRAFT_REVIEW_SKILLS],
        internalPrevcReviewerAuthority: {
          kind: "context-draft",
          draftId: "draft-security-hints",
        },
        internalPrevcReviewerAuthoritySource: "verified-active-profile",
        scope: auditScope,
      });
    }

    function readOnlyContext() {
      resetGateForTests();
      return mintToken({
        label: "read-only-hint-test",
        role: "worker",
        missionId: TEST_MISSION_ID,
        contextRevision: TEST_CONTEXT_REVISION,
        readOnly: true,
        scope: auditScope,
        allowedTools: null,
      });
    }

    it("hints that an allowlist denial is a squad decision, not a mission blocker", async () => {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const context = missionContext(undefined, ["nexus_file_read"]);
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_git_commit",
          description: "commit",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        "nexus_git_commit",
        { message: "must not run" },
        context,
        workflowOptions(),
      );

      expect(result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("outside this agent's allowlist"),
        hint: DENIAL_HINTS.allowlist,
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("hints that a read-only denial must not be routed around", async () => {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_git_commit",
          description: "commit",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        "nexus_git_commit",
        { message: "must not run" },
        readOnlyContext(),
        workflowOptions(),
      );

      expect(result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining("read-only authority denied tool"),
        hint: DENIAL_HINTS.readOnly,
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("hints that the internal reviewer only reads and concludes", async () => {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_file_write",
          description: "write",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        "nexus_file_write",
        { path: "src/anything.ts", content: "x" },
        internalDraftReviewerContext(),
        workflowOptions(),
      );

      expect(result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining(
          "outside this internal reviewer's exact profile",
        ),
        hint: DENIAL_HINTS.internalReviewer,
      });
      expect(handler).not.toHaveBeenCalled();
    });

    // Bug de campo: a mão do operador num pane sem missão que tenta handoff
    // levava sempre a mesma dica ("crie uma missão com nexus_mission_create"),
    // mesmo quando o próprio pane não consegue chamar essa tool (readOnly ou
    // fora do allowlist). A dica agora só nomeia uma tool que ESTE pane
    // realmente alcança.
    function readOnlyEmptyAllowlistUserPane() {
      resetGateForTests();
      // Reproduz tools-panes.ts: spawn ad-hoc da mão do operador com
      // readOnly:true sempre zera allowedTools do filho (attenuateTools com
      // requested=[]), então o pane nasce role "user", readOnly, allowedTools
      // vazio — exatamente o pane que bateu no bug.
      return mintToken({
        label: "operator-hand-readonly",
        role: "user",
        readOnly: true,
        allowedTools: [],
        scope: auditScope,
      });
    }

    it("hints only nexus_pane_ask for an unbound handoff from an unrestricted user pane with tools", async () => {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_handoff_submit",
          description: "handoff",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        "nexus_handoff_submit",
        { status: "partial", summary: "unbound handoff attempt" },
        userContext(),
      );

      expect(result).toMatchObject({ ok: false, denied: true });
      expect(result.hint).toContain("nexus_pane_write");
      expect(result.hint).toContain("nexus_pane_ask");
      expect(result.hint).toContain("crie uma missão com nexus_mission_create");
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not point a read-only, allowlist-empty user pane at nexus_mission_create or nexus_pane_write", async () => {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_handoff_submit",
          description: "handoff",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        "nexus_handoff_submit",
        { status: "partial", summary: "unbound handoff attempt" },
        readOnlyEmptyAllowlistUserPane(),
      );

      expect(result).toMatchObject({ ok: false, denied: true });
      // The only tool this pane can actually reach without a mission.
      expect(result.hint).toContain("nexus_pane_ask");
      // Neither tool is reachable from this pane: readOnly and the allowlist
      // both deny pane_write, and both deny mission_create too. The hint must
      // never tell the agent to call something the gate itself will refuse.
      expect(result.hint).not.toContain("crie uma missão com nexus_mission_create");
      expect(result.hint).not.toMatch(/use nexus_pane_write/);
      expect(handler).not.toHaveBeenCalled();
    });

    it("gives no actionable hint to an orphaned worker with no mission and no reachable tool", async () => {
      resetGateForTests();
      const orphanedWorker = mintToken({
        label: "orfao-handoff",
        role: "worker",
        scope: auditScope,
        allowedTools: [],
        allowedSkills: null,
      });
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith({
          name: "nexus_handoff_submit",
          description: "handoff",
          inputSchema: { type: "object", properties: {} },
          handler,
        }),
        "nexus_handoff_submit",
        { status: "partial", summary: "unbound handoff attempt" },
        orphanedWorker,
      );

      expect(result).toMatchObject({ ok: false, denied: true });
      // Nothing is actually reachable for this pane: no false lead offered.
      expect(result.hint).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("runtime availability predicate", () => {
    it("refuses a tool whose available() is false, with the settings hint", async () => {
      const handler = vi.fn(async () => ({ shouldNotRun: true }));
      const tool: McpToolDef = {
        name: "nexus_judge",
        description: "judge",
        inputSchema: { type: "object", properties: {} },
        available: () => false,
        handler,
      };
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith(tool),
        "nexus_judge",
        { state: {}, questions: {} },
        userContext(),
        standardWorkflowOptions(),
      );
      expect(result).toMatchObject({ ok: false, denied: true });
      expect(result.error).toContain(
        "indisponível: configure a chave TypeSafe em Ajustes",
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it("dispatches a tool whose available() is true", async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      const tool: McpToolDef = {
        name: "nexus_judge",
        description: "judge",
        inputSchema: { type: "object", properties: {} },
        available: () => true,
        handler,
      };
      const result = await dispatchToolCall(
        "http-mcp",
        registryWith(tool),
        "nexus_judge",
        { state: {}, questions: {} },
        userContext(),
        standardWorkflowOptions(),
      );
      expect(result).toMatchObject({ ok: true });
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});
