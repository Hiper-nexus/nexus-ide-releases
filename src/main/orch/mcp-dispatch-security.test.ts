import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearAuditLogForTests,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  readAuditLog,
} from '../jarvis/audit-log';
import { clearAll as clearAllPermissions } from '../jarvis/permissions';
import { mintToken, resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import type { McpDispatchOptions } from './mcp-dispatch';
import type { IntentGateMissionResolver } from './mcp-dispatch';
import type { McpRegistry, McpToolDef } from './mcp-protocol';
import { testProjectScope } from './__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  bumpMissionPromptIntent,
  resetMissionPromptQueues,
} from './mission-prompt-queue-registry';

const testDir = path.join(os.tmpdir(), 'nexus-mcp-dispatch-security');
const auditScope = testProjectScope({ rootRealPath: testDir });
const auditContext = { scope: auditScope } as const;
let auditManager: ProjectRuntimeManager;

function registryWith(tool: McpToolDef): McpRegistry {
  return {
    tools: [tool],
    serverName: 'nexus-security-test',
    serverVersion: '0.0.1',
  };
}

function userContext() {
  resetGateForTests();
  return mintToken({
    label: 'security-test',
    role: 'user',
    scope: auditScope,
  });
}

const TEST_MISSION_ID = 'mission-security-test';
const TEST_CONTEXT_REVISION = 'context-revision-security-test';

function missionContext(contextRevision?: string) {
  resetGateForTests();
  return mintToken({
    label: 'security-test',
    role: 'worker',
    missionId: TEST_MISSION_ID,
    contextRevision,
    scope: auditScope,
  });
}

function orchestratorMissionContext() {
  resetGateForTests();
  return mintToken({
    label: 'security-test-orchestrator',
    role: 'orchestrator',
    missionId: TEST_MISSION_ID,
    scope: auditScope,
  });
}

function dispatchedMissionFixture(): NonNullable<
  ReturnType<IntentGateMissionResolver>
> {
  return {
    mission: {
      id: TEST_MISSION_ID,
      title: 'Security test mission',
      description: 'dispatched for security tests',
      status: 'running' as const,
      milestones: [],
      learnings: '',
      intentState: 'dispatched' as const,
      intentVersion: 1,
      intentContract: {
        version: 1 as const,
        source: 'typed' as const,
        goal: 'security test goal',
        acceptanceCriteria: ['ok'],
        risk: 'normal' as const,
        executionMode: 'assisted' as const,
        contextPolicy: 'on-demand' as const,
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

function workflowOptions(
  options: Pick<McpDispatchOptions, 'confirm'> = {},
): McpDispatchOptions {
  return {
    ...options,
    resolveWorkflowAuthority: (_scope, missionId) => {
      if (missionId !== TEST_MISSION_ID) throw new Error('wrong test mission');
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

describe('MCP dispatch effect safety', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    auditManager = new ProjectRuntimeManager({
      baseDir: path.join(testDir, 'audit-runtime'),
      appVersion: 'security-test',
    });
    configureAuditLogRuntime(auditManager);
  });

  beforeEach(() => {
    configureAuditLogRuntime(auditManager);
    clearAuditLogForTests(auditContext);
    auditManager.open(auditScope).db.prepare(
      `INSERT OR IGNORE INTO missions
         (id, title, description, status, milestones_json, created_at, updated_at)
       VALUES (?, ?, '', 'running', '[]', ?, ?)`,
    ).run(TEST_MISSION_ID, 'Security test mission', Date.now(), Date.now());
    clearAllPermissions();
    resetMissionPromptQueues();
  });

  afterAll(() => {
    disposeAuditLogRuntime();
    auditManager.closeAll();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('requires a fresh approval for every effectful invocation with identical state', async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const confirm = vi.fn(async () => true);
    const registry = registryWith({
      name: 'nexus_terminal_run',
      description: 'terminal',
      inputSchema: { type: 'object', properties: {} },
      handler,
    });
    const context = missionContext();
    const args = { command: 'npm test' };

    const first = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_terminal_run',
      args,
      context,
      workflowOptions({ confirm }),
    );
    const second = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_terminal_run',
      args,
      context,
      workflowOptions({ confirm }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('blocks an unbound user effect before confirmation or handler execution', async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      'ipc-renderer',
      registryWith({
        name: 'nexus_terminal_run',
        description: 'terminal',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_terminal_run',
      { command: 'npm test' },
      userContext(),
      { confirm },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('denies unbound bootstrap and handoff effects at the dispatch boundary', async () => {
    for (const toolName of [
      'nexus_context_doctor',
      'nexus_handoff_submit',
    ]) {
      const handler = vi.fn(async () => ({ ok: true }));
      const result = await dispatchToolCall(
        'http-mcp',
        registryWith({
          name: toolName,
          description: 'mission-bound effect',
          inputSchema: { type: 'object', properties: {} },
          handler,
        }),
        toolName,
        toolName === 'nexus_handoff_submit'
          ? { status: 'partial', summary: 'A real handoff summary for the test.' }
          : {},
        userContext(),
      );

      expect(result).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining('mission'),
      });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('allows memory_retain as a missionless free-pane effect (bootstrap exemption)', async () => {
    // A memória agentic é compartilhada por todas as CLIs hospedadas; retain
    // precisa rodar em pane livre (sem missão). A exención é ESTREITA por nome:
    // o teste acima prova que context_doctor (também bootstrap-authority) segue
    // bloqueado sem missão.
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_memory_retain',
        description: 'agentic memory retain',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_memory_retain',
      { content: 'projeto usa better-sqlite3', kind: 'fact' },
      userContext(),
    );

    expect(result).not.toMatchObject({ denied: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows a confirmed renderer UI action without mission authority', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      'ipc-renderer',
      registryWith({
        name: 'nexus_ui_action',
        description: 'bounded main-authorized Nexus UI action',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_ui_action',
      { action: 'click', ref: 'u1e1' },
      userContext(),
      { confirm },
    );

    expect(result).toMatchObject({ ok: true, userAuthorized: true });
    expect(confirm).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects UI action authority outside the renderer user boundary', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_ui_action',
        description: 'bounded main-authorized Nexus UI action',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_ui_action',
      { action: 'click', ref: 'u1e1' },
      userContext(),
      { confirm },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('renderer user authority'),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores stale registry confirmation metadata for read-only policy', async () => {
    const handler = vi.fn(async () => ({ text: 'safe' }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_pane_read',
        description: 'read',
        requiresConfirm: true,
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_pane_read',
      {},
      userContext(),
      { confirm },
    );

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps handoff submission prompt-free for a mission-bound worker', async () => {
    const handler = vi.fn(async () => ({ stopGateSatisfied: false }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_handoff_submit',
        description: 'handler-owned handoff authority',
        requiresConfirm: true,
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_handoff_submit',
      { status: 'partial', summary: 'A bounded test handoff summary.' },
      missionContext(),
      workflowOptions({ confirm }),
    );

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('denies orchestrator delegation before intent dispatch (intent-first)', async () => {
    const handler = vi.fn(async () => ({ paneId: 'pane-worker' }));
    const confirm = vi.fn(async () => true);
    // Pre-dispatch mission: no approved contract — must not spawn workers.
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_pane_spawn',
        description: 'handler-owned bounded delegation',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_pane_spawn',
      { agentName: 'worker-a', prompt: 'Inspect the dirty checkout.' },
      orchestratorMissionContext(),
      {
        confirm,
        resolveMissionForIntentGate: () => ({
          mission: {
            ...dispatchedMissionFixture().mission,
            status: 'pending',
            intentState: 'awaiting_goal',
            intentContract: undefined,
            description: '',
          },
          taskCount: 0,
          workerPaneCount: 0,
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('dispatch_required'),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a mission orchestrator delegate only after intent dispatch', async () => {
    const handler = vi.fn(async () => ({ paneId: 'pane-worker' }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_pane_spawn',
        description: 'handler-owned bounded delegation',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_pane_spawn',
      { agentName: 'worker-a', prompt: 'Inspect the dirty checkout.' },
      orchestratorMissionContext(),
      { confirm, ...workflowOptions() },
    );

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('revalidates the exact intent after asynchronous confirmation', async () => {
    const handler = vi.fn(async () => ({ bytes: 1 }));
    let current = dispatchedMissionFixture();
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_file_write',
        description: 'write',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_file_write',
      { path: 'src/a.ts', content: 'x' },
      missionContext(),
      {
        ...workflowOptions(),
        confirm: async () => {
          current = {
            ...current,
            mission: {
              ...current.mission,
              status: 'pending',
              intentState: 'ready_to_start',
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

  it('revalidates the frozen workflow revision after confirmation', async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    let revision = TEST_CONTEXT_REVISION;
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_terminal_run',
        description: 'terminal',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_terminal_run',
      { command: 'npm test' },
      missionContext(TEST_CONTEXT_REVISION),
      {
        ...workflowOptions(),
        confirm: async () => {
          revision = 'new-context-revision';
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

  it('fails closed without leaking store details when budget reservation fails', async () => {
    const handler = vi.fn(async () => ({ bytes: 1 }));
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_file_write',
        description: 'write',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_file_write',
      { path: 'src/a.ts', content: 'x' },
      missionContext(),
      {
        ...workflowOptions({ confirm: async () => true }),
        reserveMissionBudget: () => {
          throw new Error('sqlite failed at /private/secret/runtime.sqlite3');
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: 'budget_reservation_unavailable',
    });
    expect(result.error).not.toContain('/private/secret');
    expect(handler).not.toHaveBeenCalled();
  });

  it('reserves budget before the handler and keeps the charge when the handler fails', async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => {
      order.push('handler');
      throw new Error('effect failed');
    });
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_pane_spawn',
        description: 'spawn',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_pane_spawn',
      { agentName: 'worker-a' },
      orchestratorMissionContext(),
      {
        ...workflowOptions(),
        reserveMissionBudget: () => {
          order.push('reserve');
        },
      },
    );

    expect(result).toMatchObject({ ok: false, effectMayHaveCommitted: true });
    expect(order).toEqual(['reserve', 'handler']);
  });

  it('serializes concurrent reservations at maxSteps', async () => {
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
      return { paneId: 'worker' };
    });
    const options: McpDispatchOptions = {
      ...workflowOptions(),
      resolveMissionForIntentGate: () => state,
      reserveMissionBudget: () => {
        const contract = state.mission.intentContract!;
        if ((contract.spentSteps ?? 0) >= (contract.budgets.maxSteps ?? 500)) {
          throw new Error('budget_exhausted');
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
      name: 'nexus_pane_spawn',
      description: 'spawn',
      inputSchema: { type: 'object', properties: {} },
      handler,
    });

    const first = dispatchToolCall(
      'http-mcp', registry, 'nexus_pane_spawn', {}, orchestratorMissionContext(), options,
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const second = await dispatchToolCall(
      'http-mcp', registry, 'nexus_pane_spawn', {}, orchestratorMissionContext(), options,
    );
    releaseFirst();
    const firstResult = await first;

    expect(firstResult.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('budget_exhausted'),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects pre-contract delegation from an unbound user or worker', async () => {
    const handler = vi.fn(async () => ({ paneId: 'must-not-spawn' }));
    const registry = registryWith({
      name: 'nexus_pane_spawn',
      description: 'bounded delegation',
      inputSchema: { type: 'object', properties: {} },
      handler,
    });
    const awaitingOpts: McpDispatchOptions = {
      resolveMissionForIntentGate: () => ({
        mission: {
          ...dispatchedMissionFixture().mission,
          status: 'pending',
          intentState: 'awaiting_goal',
          intentContract: undefined,
          description: '',
        },
        taskCount: 0,
        workerPaneCount: 0,
      }),
    };

    const fromUser = await dispatchToolCall(
      'http-mcp', registry, 'nexus_pane_spawn', {}, userContext(), awaitingOpts,
    );
    const fromWorker = await dispatchToolCall(
      'http-mcp', registry, 'nexus_pane_spawn', {}, missionContext(), awaitingOpts,
    );

    expect(fromUser).toMatchObject({ ok: false, denied: true });
    expect(fromWorker).toMatchObject({ ok: false, denied: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('permits repository sync only from the renderer-owned user path', async () => {
    const handler = vi.fn(async () => ({ status: 'up_to_date' }));
    const registry = registryWith({
      name: 'nexus_git_sync',
      description: 'narrow local fast-forward',
      inputSchema: { type: 'object', properties: {} },
      handler,
    });

    const fromRenderer = await dispatchToolCall(
      'ipc-renderer', registry, 'nexus_git_sync', {}, userContext(),
    );
    const fromAgent = await dispatchToolCall(
      'http-mcp', registry, 'nexus_git_sync', {}, missionContext(),
    );

    expect(fromRenderer).toMatchObject({ ok: true });
    expect(fromAgent).toMatchObject({ ok: false, denied: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('lets the exact orchestrator block a mission when bootstrap cannot freeze', async () => {
    const handler = vi.fn(async () => ({ status: 'blocked' }));
    // Fail-safe demotion to blocked is allowed even before intent dispatch.
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_mission_set_status',
        description: 'mission status guarded by its handler',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_mission_set_status',
      { missionId: TEST_MISSION_ID, status: 'blocked' },
      orchestratorMissionContext(),
      {
        resolveMissionForIntentGate: () => ({
          mission: {
            ...dispatchedMissionFixture().mission,
            status: 'pending',
            intentState: 'awaiting_goal',
            intentContract: undefined,
            description: '',
          },
          taskCount: 0,
          workerPaneCount: 0,
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('binds PREVC effects to the frozen context without a human prompt', async () => {
    const handler = vi.fn(async (_args, ctx) => ({
      contextRevision: ctx.contextRevision,
    }));
    const confirm = vi.fn(async () => true);
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_sensor_run',
        description: 'PREVC sensor authority',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_sensor_run',
      { missionId: TEST_MISSION_ID, sensorId: 'unit' },
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

  it('marks a failed PREVC handler as possibly committed without conflating it with confirmation', async () => {
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_sensor_run',
        description: 'PREVC sensor authority',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          throw new Error('sensor receipt transport failed');
        },
      }),
      'nexus_sensor_run',
      { missionId: TEST_MISSION_ID, sensorId: 'unit' },
      missionContext(),
      workflowOptions(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'sensor receipt transport failed',
      userAuthorized: false,
      effectMayHaveCommitted: true,
    });
  });

  it('aborts an executing bootstrap handler when a newer intent preempts it', async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const handler = vi.fn(async (
      _args: Record<string, unknown>,
      _ctx: unknown,
      invocation?: { signal?: AbortSignal },
    ) => {
      receivedSignal = invocation?.signal;
      releaseStarted();
      await new Promise<void>((_resolve, reject) => {
        if (invocation?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        invocation?.signal?.addEventListener(
          'abort', () => reject(new Error('aborted')), { once: true },
        );
      });
      return { refreshed: true };
    });
    const pending = dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_code_map_refresh',
        description: 'warm orientation',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_code_map_refresh',
      {},
      orchestratorMissionContext(),
      workflowOptions(),
    );
    await started;
    bumpMissionPromptIntent(TEST_MISSION_ID, 2);
    const result = await pending;
    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('intent_preempted'),
      effectMayHaveCommitted: true,
    });
  });

  it('blocks a stale token whose revision differs from the frozen contract', async () => {
    const handler = vi.fn(async () => ({ exitCode: 0 }));
    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_terminal_run',
        description: 'terminal',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_terminal_run',
      { command: 'npm test' },
      missionContext('stale-context-revision'),
      workflowOptions({ confirm: async () => true }),
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('does not match the frozen mission'),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps read-only calls prompt-free across repeated invocations', async () => {
    const handler = vi.fn(async () => ({ text: 'safe' }));
    const confirm = vi.fn(async () => true);
    const registry = registryWith({
      name: 'nexus_pane_read',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler,
    });
    const context = userContext();

    await dispatchToolCall('http-mcp', registry, 'nexus_pane_read', {}, context, {
      confirm,
    });
    await dispatchToolCall('http-mcp', registry, 'nexus_pane_read', {}, context, {
      confirm,
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not start a handler when scoped audit persistence is unavailable', async () => {
    const handler = vi.fn(async () => ({ text: 'must not run' }));
    disposeAuditLogRuntime();

    const result = await dispatchToolCall(
      'http-mcp',
      registryWith({
        name: 'nexus_pane_read',
        description: 'read',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }),
      'nexus_pane_read',
      {},
      userContext(),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('audit_unavailable'),
    });
    configureAuditLogRuntime(auditManager);
  });

  it('routes audit events from the immutable dispatch context, not global UI state', async () => {
    const scopeB = testProjectScope({
      rootRealPath: testDir,
      checkoutId: 'checkout-security-b',
    });
    clearAuditLogForTests({ scope: scopeB });
    const registry = registryWith({
      name: 'nexus_pane_read',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ text: 'ok' }),
    });
    const contextA = userContext();
    resetGateForTests();
    const contextB = mintToken({
      label: 'security-test-b',
      role: 'user',
      scope: scopeB,
    });

    await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_pane_read',
      {},
      contextA,
    );
    await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_pane_read',
      {},
      contextB,
    );

    expect(readAuditLog(auditContext).map((entry) => entry.checkout_id)).toEqual([
      auditScope.checkoutId,
    ]);
    expect(readAuditLog({ scope: scopeB }).map((entry) => entry.checkout_id)).toEqual([
      scopeB.checkoutId,
    ]);
  });

  it('persists a correlated intent before starting an effectful handler', async () => {
    let entriesSeenByHandler = readAuditLog(auditContext);
    const registry = registryWith({
      name: 'nexus_file_write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        entriesSeenByHandler = readAuditLog(auditContext);
        return { bytes: 1 };
      },
    });

    const result = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_file_write',
      { path: 'src/a.ts', content: 'x' },
      missionContext(),
      workflowOptions({ confirm: async () => true }),
    );

    expect(result.ok).toBe(true);
    expect(entriesSeenByHandler).toHaveLength(1);
    expect(entriesSeenByHandler[0]).toMatchObject({
      tool: 'nexus_file_write',
      result: 'intent',
      user_authorized: true,
      project_id: 'project-test',
      checkout_id: 'checkout-test',
      context_revision: TEST_CONTEXT_REVISION,
    });
    const entries = readAuditLog(auditContext);
    expect(entries.map((entry) => entry.result)).toEqual(['intent', 'ok']);
    expect(entries[0].invocation_id).toBeTruthy();
    expect(entries[1].invocation_id).toBe(entries[0].invocation_id);
  });

  it('reports effectMayHaveCommitted when outcome auditing fails after the handler ran', async () => {
    const unavailableAuditManager = new ProjectRuntimeManager({
      baseDir: path.join(testDir, 'unavailable-audit-runtime'),
      appVersion: 'security-test',
      databaseFactory: (() => {
        throw new Error('audit database unavailable');
      }) as never,
    });
    let effectApplied = false;
    const registry = registryWith({
      name: 'nexus_file_write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        effectApplied = true;
        configureAuditLogRuntime(unavailableAuditManager);
        return { bytes: 1 };
      },
    });

    const result = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_file_write',
      { path: 'src/a.ts', content: 'x' },
      missionContext(),
      workflowOptions({ confirm: async () => true }),
    );
    configureAuditLogRuntime(auditManager);
    unavailableAuditManager.closeAll();

    expect(effectApplied).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      tool: 'nexus_file_write',
      effectMayHaveCommitted: true,
      error: expect.stringContaining('audit_unavailable'),
    });
    expect(readAuditLog(auditContext).map((entry) => entry.result)).toEqual(['intent']);
  });

  it('reports effectMayHaveCommitted when an effectful handler throws after starting', async () => {
    const registry = registryWith({
      name: 'nexus_terminal_run',
      description: 'terminal',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('connection dropped after write');
      },
    });

    const result = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_terminal_run',
      { command: 'deploy' },
      missionContext(),
      workflowOptions({ confirm: async () => true }),
    );

    expect(result).toMatchObject({
      ok: false,
      effectMayHaveCommitted: true,
      error: 'connection dropped after write',
    });
    const entries = readAuditLog(auditContext);
    expect(entries.map((entry) => entry.result)).toEqual(['intent', 'error']);
    expect(entries[1].invocation_id).toBe(entries[0].invocation_id);
  });
});
