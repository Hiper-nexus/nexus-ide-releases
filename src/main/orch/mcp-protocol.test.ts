import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import {
  mintToken,
  releaseSessionByToken,
  resetGateForTests,
} from './gate';
import {
  clearAuditLogForTests,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  readAuditLog,
} from '../jarvis/audit-log';
import {
  handleMcpMessage,
  MCP_PROTOCOL_VERSION,
  resolveTool,
  type JsonRpcRequest,
  type McpRegistry,
  type McpToolDef,
  type McpToolInvocation,
  withMcpImageContent,
} from './mcp-protocol';
import { buildToolset } from './tools';
import { testProjectScope } from './__tests__/scope-fixture';
import { clearAll as clearAllPermissions } from '../jarvis/permissions';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { McpDispatchOptions } from './mcp-dispatch';

const auditScope = testProjectScope();
const auditContext = { scope: auditScope } as const;
const TEST_MISSION_ID = 'mission-mcp-protocol-test';
const TEST_CONTEXT_REVISION = 'context-revision-mcp-protocol-test';

function makeRegistry(): McpRegistry {
  const echo: McpToolDef = {
    name: 'nexus_pane_read',
    description: 'echo tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args) => ({ echoed: args }),
  };
  const boom: McpToolDef = {
    name: 'nexus_pane_read_many',
    description: 'always throws',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('kaboom');
    },
  };
  return { tools: [echo, boom], serverName: 'nexus-test', serverVersion: '0.0.1' };
}

function req(method: string, params?: Record<string, unknown>, id: number | undefined = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

function userCtx() {
  resetGateForTests();
  return mintToken({ label: 'test', role: 'user', scope: auditScope });
}

function missionCtx() {
  resetGateForTests();
  return mintToken({
    label: 'test',
    role: 'worker',
    missionId: TEST_MISSION_ID,
    contextRevision: TEST_CONTEXT_REVISION,
    scope: auditScope,
  });
}

function opsMissionCtx() {
  resetGateForTests();
  return mintToken({
    label: 'test',
    role: 'worker',
    missionId: TEST_MISSION_ID,
    scope: auditScope,
  });
}

function orchestratorMissionCtx(overrides?: Partial<Parameters<typeof mintToken>[0]>) {
  resetGateForTests();
  return mintToken({
    label: 'maestro',
    role: 'orchestrator',
    missionId: TEST_MISSION_ID,
    contextRevision: TEST_CONTEXT_REVISION,
    readOnly: false,
    allowedTools: null,
    scope: auditScope,
    ...overrides,
  });
}

function workflowOptions(
  confirm?: McpDispatchOptions['confirm'],
): McpDispatchOptions {
  return {
    confirm,
    resolveMissionForIntentGate: () => ({
      mission: {
        id: TEST_MISSION_ID,
        title: 'MCP protocol mission',
        description: 'Exercise an approved MCP effect',
        status: 'running',
        milestones: [],
        learnings: '',
        intentState: 'dispatched',
        intentVersion: 1,
        intentContract: {
          version: 1,
          source: 'typed',
          goal: 'Exercise an approved MCP effect',
          acceptanceCriteria: ['Effect follows confirmation policy'],
          risk: 'normal',
          executionMode: 'assisted',
          contextPolicy: 'on-demand',
          approvedAt: 1,
          intentVersion: 1,
          budgets: {
            planningTokens: 1_200,
            executionTokens: 8_000,
            maxWorkers: 1,
          },
        },
        createdAt: 1,
        updatedAt: 1,
      },
      taskCount: 1,
      workerPaneCount: 1,
    }),
    resolveWorkflowAuthority: () => ({
      contextRevision: TEST_CONTEXT_REVISION,
      assertExecutionEffectAllowed: () => undefined,
    }),
    reserveMissionBudget: () => undefined,
  };
}

function opsTerminalWorkflowOptions(
  confirm?: McpDispatchOptions['confirm'],
  opts?: { approved?: boolean },
): McpDispatchOptions {
  const base = workflowOptions(confirm);
  const approved = opts?.approved ?? true;
  return {
    ...base,
    resolveMissionForIntentGate: (scope, missionId) => {
      const resolved = base.resolveMissionForIntentGate?.(scope, missionId);
      if (!resolved?.mission.intentContract) return resolved ?? null;
      return {
        ...resolved,
        mission: {
          ...resolved.mission,
          intentContract: {
            ...resolved.mission.intentContract,
            lane: 'ops',
            approvedAt: approved ? resolved.mission.intentContract.approvedAt : undefined,
            budgets: {
              ...resolved.mission.intentContract.budgets,
              maxWorkers: 0,
            },
          },
        },
      };
    },
    // Ops is the intentional terminal/SSH lane and does not freeze a PREVC
    // code-worktree contract. Revision-bound code workers use native shell
    // inside their inherited process sandbox instead of this main-owned MCP.
    resolveWorkflowAuthority: () => ({
      contextRevision: undefined,
      assertExecutionEffectAllowed: () => undefined,
    }),
  };
}

describe('resolveTool', () => {
  it('resolves canonical and bare alias names', () => {
    const registry = makeRegistry();
    expect(resolveTool(registry, 'nexus_pane_read')?.name).toBe('nexus_pane_read');
    expect(resolveTool(registry, 'pane_read')?.name).toBe('nexus_pane_read');
    expect(resolveTool(registry, 'nope')).toBeNull();
  });
});

describe('handleMcpMessage', () => {
  const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-mcp-protocol');
  let auditManager: ProjectRuntimeManager;

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    auditManager = new ProjectRuntimeManager({
      baseDir: path.join(testDir, 'audit-runtime'),
      appVersion: 'mcp-protocol-test',
    });
    configureAuditLogRuntime(auditManager);
  });

  beforeEach(() => {
    clearAuditLogForTests(auditContext);
    auditManager.open(auditScope).db.prepare(
      `INSERT OR IGNORE INTO missions
         (id, title, description, status, milestones_json, created_at, updated_at)
       VALUES (?, ?, '', 'running', '[]', ?, ?)`,
    ).run(TEST_MISSION_ID, 'MCP protocol mission', Date.now(), Date.now());
    clearAllPermissions();
  });

  afterAll(() => {
    disposeAuditLogRuntime();
    auditManager.closeAll();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('answers initialize with the negotiated protocol version', async () => {
    const res = await handleMcpMessage(
      makeRegistry(),
      userCtx(),
      req('initialize', { protocolVersion: '2025-03-26' }),
    );
    expect(res?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'nexus-test' },
    });
  });

  it('initialize entrega a doutrina de delegação só à mão do operador sem missão', async () => {
    const user = await handleMcpMessage(makeRegistry(), userCtx(), req('initialize', {}));
    expect((user?.result as { instructions?: string }).instructions).toContain('nexus_pane_spawn');
    const worker = await handleMcpMessage(makeRegistry(), missionCtx(), req('initialize', {}));
    expect((worker?.result as { instructions?: string }).instructions).toBeUndefined();
    const orch = await handleMcpMessage(makeRegistry(), orchestratorMissionCtx(), req('initialize', {}));
    expect((orch?.result as { instructions?: string }).instructions).toBeUndefined();
  });

  it('reports the completed tool result to the transport observer without changing the response', async () => {
    const onToolResult = vi.fn();
    const response = await handleMcpMessage(
      makeRegistry(),
      userCtx(),
      req('tools/call', {
        name: 'nexus_pane_read',
        arguments: { paneId: 'pane-observed' },
      }),
      { onToolResult },
    );

    expect(onToolResult).toHaveBeenCalledOnce();
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        tool: 'nexus_pane_read',
        result: { echoed: { paneId: 'pane-observed' } },
      }),
    );
    expect(
      (response?.result as { isError?: boolean } | undefined)?.isError,
    ).toBeUndefined();
  });

  it('falls back to the default protocol version for unknown requests', async () => {
    const res = await handleMcpMessage(
      makeRegistry(),
      userCtx(),
      req('initialize', { protocolVersion: '1999-01-01' }),
    );
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(
      MCP_PROTOCOL_VERSION,
    );
  });

  it('swallows notifications (returns null)', async () => {
    const res = await handleMcpMessage(
      makeRegistry(),
      userCtx(),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    expect(res).toBeNull();
  });

  it('F-1157: lists every available tool, whatever the allowlist names', async () => {
    resetGateForTests();
    const ctx = mintToken({
      label: 'restricted',
      role: 'worker',
      scope: testProjectScope(),
      allowedTools: ['file_read'],
    });
    const fileRead: McpToolDef = {
      name: 'nexus_file_read',
      description: 'read a file',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    };
    const paneWrite: McpToolDef = {
      name: 'nexus_pane_write',
      description: 'write a pane',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    };
    const registry: McpRegistry = {
      tools: [...makeRegistry().tools, fileRead, paneWrite],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const res = await handleMcpMessage(registry, ctx, req('tools/list'));
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'nexus_pane_read',
      'nexus_pane_read_many',
      'nexus_file_read',
      'nexus_pane_write',
    ]);
  });

  it('recusa sem missão mantém o erro canônico e leva a dica de caminho ao agente', async () => {
    // Contrato: `error` é a string que o smoke empacotado (mcp-write-guard)
    // compara ao pé da letra; a dica vai em `hint` e só entra no TEXTO que o
    // agente lê. Trocar a string do erro reprovou o gate da 0.76.8.
    resetGateForTests();
    const ctx = userCtx();
    const handoff: McpToolDef = {
      name: 'nexus_handoff_submit',
      description: 'handoff',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    };
    const registry: McpRegistry = {
      tools: [...makeRegistry().tools, handoff],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const res = await handleMcpMessage(
      registry,
      ctx,
      req('tools/call', {
        name: 'nexus_handoff_submit',
        arguments: { status: 'success', summary: 'handoff de teste' },
      }),
    );
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'mission effect blocked: projectId, checkoutId, missionId and contextRevision are required',
    );
    expect(result.content[0].text).toContain('nexus_pane_write');
    expect(result.content[0].text).toContain('nexus_mission_create');
  });

  it('hides tools whose runtime availability predicate is false', async () => {
    resetGateForTests();
    const ctx = userCtx();
    const tool = (name: string, available?: () => boolean): McpToolDef => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      ...(available ? { available } : {}),
      handler: async () => ({ ok: true }),
    });
    const registry: McpRegistry = {
      tools: [
        tool('nexus_file_read'),
        tool('nexus_judge', () => false),
        tool('nexus_rank', () => true),
      ],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const res = await handleMcpMessage(registry, ctx, req('tools/list'));
    const names = (
      res?.result as { tools: Array<{ name: string }> }
    ).tools.map((t) => t.name);
    expect(names).toEqual(['nexus_file_read', 'nexus_rank']);
  });

  it('advertises pane_spawn to a running mission orchestrator', async () => {
    resetGateForTests();
    const ctx = orchestratorMissionCtx();
    const registry: McpRegistry = {
      tools: buildToolset(),
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const res = await handleMcpMessage(registry, ctx, req('tools/list'));
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('nexus_pane_spawn');
  });

  it('advertises pane_spawn to a running mission orchestrator even with empty squad allowlist', async () => {
    resetGateForTests();
    const ctx = orchestratorMissionCtx({ allowedTools: [] });
    const registry: McpRegistry = {
      tools: buildToolset(),
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const res = await handleMcpMessage(registry, ctx, req('tools/list'));
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('nexus_pane_spawn');
  });

  it('F-1157: advertises media generation to every orchestrator, Pet marker or not', async () => {
    resetGateForTests();
    const maker = PET_STUDIO_SQUAD.agents[0]!;
    const definitions = [
      'nexus_media_providers',
      'nexus_image_generate',
      'nexus_video_generate',
    ].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({ ok: true })),
    }));
    const registry: McpRegistry = {
      tools: definitions,
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const pet = mintToken({
      label: maker.agentName,
      role: 'orchestrator',
      agentName: maker.agentName,
      providerId: 'codex',
      petStudioMediaAuthority: true,
      petStudioAuthoritySource: 'legacy-squad',
      petStudioSquadId: PET_STUDIO_SQUAD.id,
      allowedTools: [...(maker.allowedTools ?? [])],
      allowedSkills: [...(maker.allowedSkills ?? [])],
      scope: auditScope,
    });
    const ordinary = mintToken({
      label: 'ordinary-orchestrator',
      role: 'orchestrator',
      allowedTools: [...(maker.allowedTools ?? [])],
      scope: auditScope,
    });

    const petResponse = await handleMcpMessage(
      registry,
      pet,
      req('tools/list'),
    );
    const ordinaryResponse = await handleMcpMessage(
      registry,
      ordinary,
      req('tools/list'),
    );
    const names = (response: typeof petResponse) =>
      (response?.result as { tools: Array<{ name: string }> }).tools.map(
        (tool) => tool.name,
      );

    const all = ['nexus_media_providers', 'nexus_image_generate', 'nexus_video_generate'];
    expect(names(petResponse)).toEqual(all);
    expect(names(ordinaryResponse)).toEqual(all);
  });

  it('F-1157: advertises workspace and process effects to a formerly read-only agent', async () => {
    resetGateForTests();
    const ctx = mintToken({
      label: 'read-only-reviewer',
      role: 'worker',
      missionId: TEST_MISSION_ID,
      contextRevision: TEST_CONTEXT_REVISION,
      readOnly: true,
      scope: auditScope,
      allowedTools: null,
    });
    const handler = vi.fn(async () => ({ ok: true }));
    const names = [
      'nexus_pane_read',
      'nexus_context_draft_review',
      'nexus_handoff_submit',
      'nexus_worker_heartbeat',
      'nexus_file_write',
      'nexus_terminal_run',
      'nexus_git_commit',
      'nexus_pane_spawn',
      'nexus_context_draft_apply',
    ];
    const registry: McpRegistry = {
      tools: names.map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
        handler,
      })),
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };

    const res = await handleMcpMessage(registry, ctx, req('tools/list'));
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;

    expect(tools.map((tool) => tool.name)).toEqual(names);
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes tools/call through alias names', async () => {
    const res = await handleMcpMessage(
      makeRegistry(),
      userCtx(),
      req('tools/call', { name: 'pane_read', arguments: { x: 1 } }),
    );
    const result = res?.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ echoed: { x: 1 } });
    expect(readAuditLog(auditContext)[0]).toMatchObject({
      source: 'http-mcp',
      tool: 'nexus_pane_read',
      result: 'ok',
    });
  });

  it('serializes tool results as compact JSON (pretty-printing inflated every result)', async () => {
    const res = await handleMcpMessage(
      makeRegistry(),
      userCtx(),
      req('tools/call', { name: 'pane_read', arguments: { nested: { a: [1, 2] } } }),
    );
    const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe('{"echoed":{"nested":{"a":[1,2]}}}');
  });

  it('adds image content blocks a tool attaches, without putting the bytes in the text', async () => {
    const registry: McpRegistry = {
      tools: [{
        name: 'nexus_pane_read',
        description: 'image tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => withMcpImageContent(
          { path: '/tmp/shot.png', width: 2 },
          [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        ),
      }],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const res = await handleMcpMessage(registry, userCtx(), req('tools/call', { name: 'pane_read' }));
    const content = (res?.result as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([
      { type: 'text', text: '{"path":"/tmp/shot.png","width":2}' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]);
  });

  it('does not run read or always-allowed handoff handlers after bearer revocation', async () => {
    const read = vi.fn(async () => ({ content: 'secret' }));
    const handoff = vi.fn(async () => ({ id: 'handoff-should-not-exist' }));
    const registry: McpRegistry = {
      tools: [
        {
          name: 'nexus_pane_read',
          description: 'read',
          inputSchema: { type: 'object', properties: {} },
          handler: read,
        },
        {
          name: 'nexus_handoff_submit',
          description: 'handoff',
          inputSchema: { type: 'object', properties: {} },
          handler: handoff,
        },
      ],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const ctx = userCtx();
    releaseSessionByToken(ctx.token);

    const readResponse = await handleMcpMessage(
      registry,
      ctx,
      req('tools/call', { name: 'nexus_pane_read', arguments: {} }),
    );
    const handoffResponse = await handleMcpMessage(
      registry,
      ctx,
      req('tools/call', { name: 'nexus_handoff_submit', arguments: {} }),
    );

    expect(read).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    expect(
      (readResponse?.result as { content: Array<{ text: string }> } | undefined)
        ?.content[0]?.text,
    ).toContain('session_authority_revoked');
    expect(
      (handoffResponse?.result as { content: Array<{ text: string }> } | undefined)
        ?.content[0]?.text,
    ).toContain('session_authority_revoked');
  });

  it('aborts and discards an in-flight handler when its bearer is revoked', async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let releaseHandler!: () => void;
    const continueHandler = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let signal: AbortSignal | undefined;
    let committed = false;
    const handler = vi.fn(
      async (
        _args: Record<string, unknown>,
        _ctx: unknown,
        invocation?: { signal?: AbortSignal },
      ) => {
        signal = invocation?.signal;
        releaseStarted();
        await continueHandler;
        if (signal?.aborted) throw new Error('aborted before commit');
        committed = true;
        return { secret: 'must-not-return' };
      },
    );
    const registry: McpRegistry = {
      tools: [{
        name: 'nexus_deferred_effect',
        description: 'deferred effect',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const ctx = missionCtx();
    const pending = handleMcpMessage(
      registry,
      ctx,
      req('tools/call', {
        name: 'nexus_deferred_effect',
        arguments: {},
      }),
      workflowOptions(),
    );
    await started;

    releaseSessionByToken(ctx.token);
    expect(signal?.aborted).toBe(true);
    releaseHandler();
    const response = await pending;

    expect(handler).toHaveBeenCalledOnce();
    expect(committed).toBe(false);
    const result = response?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('session_authority_revoked');
    expect(result.content[0]?.text).not.toContain('must-not-return');
  });

  it('fails HTTP MCP confirmation-required tools closed and audits denial', async () => {
    const destructive: McpToolDef = {
      name: 'nexus_terminal_run',
      description: 'terminal',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('handler should not execute');
      },
    };
    const registry: McpRegistry = {
      tools: [destructive],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };

    const res = await handleMcpMessage(
      registry,
      opsMissionCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'rm -rf /tmp/nexus-no-ui' },
      }),
      opsTerminalWorkflowOptions(undefined, { approved: false }),
    );

    const result = res?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('confirmation_ui_unavailable');
    expect(readAuditLog(auditContext)[0]).toMatchObject({
      source: 'http-mcp',
      tool: 'nexus_terminal_run',
      result: 'denied',
      error: expect.stringContaining('confirmation_ui_unavailable'),
    });
  });

  it('executes a confirmation-required HTTP MCP tool after native approval', async () => {
    let executed = false;
    let effectIntent: McpToolInvocation['effectIntent'];
    const destructive: McpToolDef = {
      name: 'nexus_terminal_run',
      description: 'terminal',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, _ctx, invocation) => {
        executed = true;
        effectIntent = invocation?.effectIntent;
        return { exitCode: 0 };
      },
    };
    const registry: McpRegistry = {
      tools: [destructive],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const confirm = vi.fn().mockResolvedValue(true);

    const res = await handleMcpMessage(
      registry,
      opsMissionCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'rm -rf /tmp/nexus-approved' },
      }),
      opsTerminalWorkflowOptions(confirm, { approved: false }),
    );

    const result = res?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeUndefined();
    expect(executed).toBe(true);
    expect(effectIntent).toMatchObject({
      toolName: 'nexus_terminal_run',
      source: 'http-mcp',
      toolCallId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
      issuedAt: expect.any(Number),
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      source: 'http-mcp',
      toolName: 'nexus_terminal_run',
      args: { command: 'rm -rf /tmp/nexus-approved' },
      reason: 'destructive command: rm -rf /tmp/nexus-approved',
      agentLabel: 'test',
    }));
    const auditEntries = readAuditLog(auditContext);
    expect(auditEntries.map((entry) => entry.result)).toEqual(['intent', 'ok']);
    expect(auditEntries[0]?.invocation_id).toBe(effectIntent?.toolCallId);
    expect(auditEntries[1]?.invocation_id).toBe(effectIntent?.toolCallId);
    expect(auditEntries.at(-1)).toMatchObject({
      source: 'http-mcp',
      tool: 'nexus_terminal_run',
      result: 'ok',
      user_authorized: true,
    });
  });

  it('exposes the possible-commit marker to HTTP MCP clients after a handler failure', async () => {
    const registry: McpRegistry = {
      tools: [{
        name: 'nexus_terminal_run',
        description: 'terminal',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          throw new Error('transport lost after command start');
        },
      }],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };

    const res = await handleMcpMessage(
      registry,
      opsMissionCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'deploy' },
      }),
      opsTerminalWorkflowOptions(async () => true),
    );
    const envelope = res?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(envelope.content[0].text) as {
      error: string;
      effectMayHaveCommitted: boolean;
    };

    expect(envelope.isError).toBe(true);
    expect(payload).toMatchObject({
      error: 'transport lost after command start',
      effectMayHaveCommitted: true,
    });
  });

  it('keeps a confirmation-required HTTP MCP tool blocked when the user denies', async () => {
    let executed = false;
    const destructive: McpToolDef = {
      name: 'nexus_terminal_run',
      description: 'terminal',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        executed = true;
      },
    };
    const registry: McpRegistry = {
      tools: [destructive],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };

    const res = await handleMcpMessage(
      registry,
      opsMissionCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'rm -rf /tmp/nexus-denied' },
      }),
      opsTerminalWorkflowOptions(async () => false, { approved: false }),
    );

    const result = res?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('user_denied');
    expect(executed).toBe(false);
    expect(readAuditLog(auditContext)[0]).toMatchObject({
      source: 'http-mcp',
      tool: 'nexus_terminal_run',
      result: 'denied',
      error: expect.stringContaining('user_denied'),
    });
  });

  it('F-1157: a tool outside the allowlist is not refused by the gate; only the remaining mission binding applies', async () => {
    resetGateForTests();
    const ctx = mintToken({
      label: 'restricted',
      role: 'worker',
      scope: testProjectScope(),
      allowedTools: ['pane_read'],
    });
    const paneWrite: McpToolDef = {
      name: 'nexus_pane_write',
      description: 'write a pane',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    };
    const registry: McpRegistry = {
      tools: [...makeRegistry().tools, paneWrite],
      serverName: 'nexus-test',
      serverVersion: '0.0.1',
    };
    const res = await handleMcpMessage(
      registry,
      ctx,
      req('tools/call', { name: 'nexus_pane_write', arguments: {} }),
    );
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    // This worker has no mission: the effect stops at the mission binding,
    // never at an allowlist.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('allowlist');
    expect(result.content[0].text).toContain('mission effect blocked');
  });

  it('wraps handler exceptions as isError results, not protocol errors', async () => {
    const res = await handleMcpMessage(
      makeRegistry(),
      userCtx(),
      req('tools/call', { name: 'nexus_pane_read_many', arguments: {} }),
    );
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('kaboom');
  });

  it('returns method-not-found for unknown request methods', async () => {
    const res = await handleMcpMessage(makeRegistry(), userCtx(), req('bogus'));
    expect(res?.error?.code).toBe(-32601);
  });
});
