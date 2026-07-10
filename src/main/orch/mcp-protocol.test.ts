import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintToken, resetGateForTests } from './gate';
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
} from './mcp-protocol';
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
    role: 'orchestrator',
    missionId: TEST_MISSION_ID,
    contextRevision: TEST_CONTEXT_REVISION,
    scope: auditScope,
  });
}

function workflowOptions(
  confirm?: McpDispatchOptions['confirm'],
): McpDispatchOptions {
  return {
    confirm,
    resolveWorkflowAuthority: () => ({
      contextRevision: TEST_CONTEXT_REVISION,
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

  it('lists only allowlisted tools', async () => {
    resetGateForTests();
    const ctx = mintToken({
      label: 'restricted',
      role: 'worker',
      scope: testProjectScope(),
      allowedTools: ['pane_read'],
    });
    const res = await handleMcpMessage(makeRegistry(), ctx, req('tools/list'));
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['nexus_pane_read']);
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
      missionCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'echo no-ui' },
      }),
      workflowOptions(),
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
    const destructive: McpToolDef = {
      name: 'nexus_terminal_run',
      description: 'terminal',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        executed = true;
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
      missionCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'npm test' },
      }),
      workflowOptions(confirm),
    );

    const result = res?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeUndefined();
    expect(executed).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      source: 'http-mcp',
      toolName: 'nexus_terminal_run',
      args: { command: 'npm test' },
      reason: 'run command: npm test',
      agentLabel: 'test',
    }));
    const auditEntries = readAuditLog(auditContext);
    expect(auditEntries.map((entry) => entry.result)).toEqual(['intent', 'ok']);
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
      missionCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'deploy' },
      }),
      workflowOptions(async () => true),
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
      name: 'nexus_file_write',
      description: 'write',
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
      missionCtx(),
      req('tools/call', {
        name: 'nexus_file_write',
        arguments: { path: 'src/a.ts', content: 'secret' },
      }),
      workflowOptions(async () => false),
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
      tool: 'nexus_file_write',
      result: 'denied',
      error: expect.stringContaining('user_denied'),
    });
  });

  it('refuses tools outside the allowlist (server-side skill-gate)', async () => {
    resetGateForTests();
    const ctx = mintToken({
      label: 'restricted',
      role: 'worker',
      scope: testProjectScope(),
      allowedTools: ['pane_read'],
    });
    const res = await handleMcpMessage(
      makeRegistry(),
      ctx,
      req('tools/call', { name: 'nexus_pane_read_many', arguments: {} }),
    );
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('allowlist');
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
