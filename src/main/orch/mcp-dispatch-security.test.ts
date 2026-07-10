import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearAuditLog,
  readAuditLog,
  setAuditLogPathForTests,
} from '../jarvis/audit-log';
import { clearAll as clearAllPermissions } from '../jarvis/permissions';
import { mintToken, resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import type { McpRegistry, McpToolDef } from './mcp-protocol';

const testDir = path.join(os.tmpdir(), 'nexus-mcp-dispatch-security');
const testAuditLog = path.join(testDir, 'jarvis-actions.log');

function registryWith(tool: McpToolDef): McpRegistry {
  return {
    tools: [tool],
    serverName: 'nexus-security-test',
    serverVersion: '0.0.1',
  };
}

function userContext() {
  resetGateForTests();
  return mintToken({ label: 'security-test', role: 'user' });
}

describe('MCP dispatch effect safety', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    setAuditLogPathForTests(testAuditLog);
  });

  beforeEach(() => {
    setAuditLogPathForTests(testAuditLog);
    clearAuditLog();
    clearAllPermissions();
  });

  afterAll(() => {
    setAuditLogPathForTests(null);
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
    const context = userContext();
    const args = { command: 'npm test' };

    const first = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_terminal_run',
      args,
      context,
      { confirm },
    );
    const second = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_terminal_run',
      args,
      context,
      { confirm },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
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

  it('persists a correlated intent before starting an effectful handler', async () => {
    let entriesSeenByHandler = readAuditLog();
    const registry = registryWith({
      name: 'nexus_file_write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        entriesSeenByHandler = readAuditLog();
        return { bytes: 1 };
      },
    });

    const result = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_file_write',
      { path: 'src/a.ts', content: 'x' },
      userContext(),
      { confirm: async () => true },
    );

    expect(result.ok).toBe(true);
    expect(entriesSeenByHandler).toHaveLength(1);
    expect(entriesSeenByHandler[0]).toMatchObject({
      tool: 'nexus_file_write',
      result: 'intent',
      user_authorized: true,
    });
    const entries = readAuditLog();
    expect(entries.map((entry) => entry.result)).toEqual(['intent', 'ok']);
    expect(entries[0].invocation_id).toBeTruthy();
    expect(entries[1].invocation_id).toBe(entries[0].invocation_id);
  });

  it('reports effectMayHaveCommitted when outcome auditing fails after the handler ran', async () => {
    const auditBlocker = path.join(testDir, 'not-a-directory');
    fs.writeFileSync(auditBlocker, 'block child paths', 'utf8');
    let effectApplied = false;
    const registry = registryWith({
      name: 'nexus_file_write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        effectApplied = true;
        setAuditLogPathForTests(path.join(auditBlocker, 'audit.log'));
        return { bytes: 1 };
      },
    });

    const result = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_file_write',
      { path: 'src/a.ts', content: 'x' },
      userContext(),
      { confirm: async () => true },
    );
    setAuditLogPathForTests(testAuditLog);

    expect(effectApplied).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      tool: 'nexus_file_write',
      effectMayHaveCommitted: true,
      error: expect.stringContaining('audit_unavailable'),
    });
    expect(readAuditLog().map((entry) => entry.result)).toEqual(['intent']);
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
      userContext(),
      { confirm: async () => true },
    );

    expect(result).toMatchObject({
      ok: false,
      effectMayHaveCommitted: true,
      error: 'connection dropped after write',
    });
    const entries = readAuditLog();
    expect(entries.map((entry) => entry.result)).toEqual(['intent', 'error']);
    expect(entries[1].invocation_id).toBe(entries[0].invocation_id);
  });
});
