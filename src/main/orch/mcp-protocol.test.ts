import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintToken, resetGateForTests } from './gate';
import {
  clearAuditLog,
  readAuditLog,
  setAuditLogPathForTests,
} from '../jarvis/audit-log';
import {
  handleMcpMessage,
  MCP_PROTOCOL_VERSION,
  resolveTool,
  type JsonRpcRequest,
  type McpRegistry,
  type McpToolDef,
} from './mcp-protocol';

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
  return mintToken({ label: 'test', role: 'user' });
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
  const testAuditLog = path.join(testDir, 'jarvis-actions.log');

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    setAuditLogPathForTests(testAuditLog);
  });

  beforeEach(() => {
    clearAuditLog();
  });

  afterAll(() => {
    setAuditLogPathForTests(null);
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
    expect(readAuditLog()[0]).toMatchObject({
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
      userCtx(),
      req('tools/call', {
        name: 'nexus_terminal_run',
        arguments: { command: 'echo no-ui' },
      }),
    );

    const result = res?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('confirmation_ui_unavailable');
    expect(readAuditLog()[0]).toMatchObject({
      source: 'http-mcp',
      tool: 'nexus_terminal_run',
      result: 'denied',
      error: expect.stringContaining('confirmation_ui_unavailable'),
    });
  });

  it('refuses tools outside the allowlist (server-side skill-gate)', async () => {
    resetGateForTests();
    const ctx = mintToken({
      label: 'restricted',
      role: 'worker',
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
