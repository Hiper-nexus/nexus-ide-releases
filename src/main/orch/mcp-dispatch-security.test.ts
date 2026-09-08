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
import { dispatchToolCall } from "./mcp-dispatch";
import type { McpDispatchOptions } from "./mcp-dispatch";
import type { IntentGateMissionResolver } from "./mcp-dispatch";
import type { McpRegistry, McpToolDef } from "./mcp-protocol";
import type { Mission } from "../../shared/orch-types";
import { buildDomainTools } from "./tools-domain";
import * as domainStores from "./project-domain-store-registry";
import * as completion from "./civilian-delivery-completion";
import * as squads from "./squad-store";
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

  it("still requires confirmation for destructive commands in an approved mission", async () => {
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

    expect(result.ok).toBe(false);
    expect(result.error).toBe("user_denied");
    expect(confirm).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
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

  it("revalidates the exact intent after asynchronous confirmation", async () => {
    const handler = vi.fn(async () => ({ bytes: 1 }));
    let current = dispatchedMissionFixture();
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
    // O veículo mudou junto com a N1: o cron deixou de abrir modal, então quem
    // ainda passa pelo ramo de confirmação é o comando destrutivo SEM
    // preparador de reversibilidade ligado — o piso que só cai onde o desfazer
    // existe. A corrida sob teste (revisão congelada muda DURANTE a
    // confirmação) é a mesma; o que se prova é que ela continua fechando.
    const handler = vi.fn(async () => ({ created: true }));
    let revision = TEST_CONTEXT_REVISION;
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

  it("rejects pre-contract delegation from an unbound user or worker", async () => {
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

    expect(fromUser).toMatchObject({ ok: false, denied: true });
    expect(fromWorker).toMatchObject({ ok: false, denied: true });
    expect(handler).not.toHaveBeenCalled();
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
});
