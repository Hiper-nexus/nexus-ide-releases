import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  clearMcpRendererSession,
  confirmMcpTool,
  invokeMcpTool,
} from '../../jarvis/mcp-ipc';
import { clearAll } from '../../jarvis/permissions';
import {
  clearAuditLog,
  closeAuditLog,
  readAuditLog,
} from '../../jarvis/audit-log';

const workspace = vi.hoisted(() => ({ current: '' }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-mcp-ipc');

describe('mcp-ipc security flow', () => {
  beforeAll(() => {
    workspace.current = testDir;
    fs.mkdirSync(testDir, { recursive: true });
  });

  beforeEach(() => {
    clearAll();
    clearMcpRendererSession();
    clearAuditLog();
  });

  afterAll(() => {
    closeAuditLog();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('blocks rm -rf without explicit confirmation', async () => {
    const target = path.join(testDir, 'do-not-delete');
    fs.mkdirSync(target, { recursive: true });

    const result = await invokeMcpTool({
      tool: 'nexus_terminal_run',
      args: { command: 'rm -rf do-not-delete', cwd: testDir },
    });

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      requiredConfirmation: true,
    });
    expect(result.confirmationReason).toContain('destructive command');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('blocks git push --force without explicit confirmation', async () => {
    const result = await invokeMcpTool({
      tool: 'nexus_terminal_run',
      args: { command: 'git push --force origin main', cwd: testDir },
    });

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      requiredConfirmation: true,
    });
    expect(result.confirmationReason).toContain('destructive command');
  });

  it('persists an audit entry with tool call result', async () => {
    const args = { command: 'echo audit-ok', cwd: testDir };
    expect(confirmMcpTool({ tool: 'terminal_run', args })).toEqual({ ok: true });

    const result = await invokeMcpTool({ tool: 'nexus_terminal_run', args });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.result)).toContain('audit-ok');

    const entries = readAuditLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: 'nexus_terminal_run',
      result: 'ok',
      user_authorized: true,
      args: { command: 'echo audit-ok', cwd: testDir },
    });
    expect(entries[0].timestamp).toBeTruthy();
    expect(typeof entries[0].duration_ms).toBe('number');
  });

  it('denies an action outside the user-authorized args scope', async () => {
    const allowedArgs = { command: 'echo allowed', cwd: testDir };
    const otherArgs = { command: 'echo denied', cwd: testDir };
    expect(confirmMcpTool({ tool: 'nexus_terminal_run', args: allowedArgs })).toEqual({
      ok: true,
    });

    const result = await invokeMcpTool({
      tool: 'nexus_terminal_run',
      args: otherArgs,
    });

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      requiredConfirmation: true,
    });
  });
});
