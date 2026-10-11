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
  clearAuditLogForTests,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  readAuditLog,
  type AuditContext,
} from '../../jarvis/audit-log';
import { clearConfirmationTokensForTests } from '../../jarvis/confirmation-tokens';
import { ProjectRuntimeManager } from '../../runtime/project-runtime-manager';
import type { ProjectExecutionScope } from '../../../shared/types';

vi.mock('electron', () => {
  // F-1202: the native confirmation is a sheet on a live window.
  const win = { isDestroyed: () => false, isVisible: () => true, isFocusable: () => true };
  return {
    ipcMain: { handle: vi.fn() },
    BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => null },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    },
  };
});

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-mcp-ipc');
let auditManager: ProjectRuntimeManager;
let auditContext: AuditContext;
let projectScope: ProjectExecutionScope;

describe('mcp-ipc security flow', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    projectScope = {
      version: 1,
      installationId: 'installation-mcp-ipc-test',
      projectId: 'project-mcp-ipc-test',
      checkoutId: 'checkout-mcp-ipc-test',
      rootRealPath: fs.realpathSync(testDir),
      identitySource: 'manifest',
    };
    auditManager = new ProjectRuntimeManager({
      baseDir: path.join(testDir, 'audit-runtime'),
      appVersion: 'mcp-ipc-test',
    });
    configureAuditLogRuntime(auditManager);
    auditContext = { scope: projectScope };
  });

  beforeEach(() => {
    clearAll();
    clearConfirmationTokensForTests();
    clearMcpRendererSession();
    clearAuditLogForTests(auditContext);
  });

  afterAll(() => {
    disposeAuditLogRuntime();
    auditManager.closeAll();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('blocks rm -rf without a frozen mission context', async () => {
    const target = path.join(testDir, 'do-not-delete');
    fs.mkdirSync(target, { recursive: true });

    const result = await invokeMcpTool(
      {
        tool: 'nexus_terminal_run',
        args: { command: 'rm -rf do-not-delete', cwd: testDir },
      },
      projectScope,
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });
    expect(fs.existsSync(target)).toBe(true);
  });

  it('blocks git push --force without a frozen mission context', async () => {
    const result = await invokeMcpTool(
      {
        tool: 'nexus_terminal_run',
        args: { command: 'git push --force origin main', cwd: testDir },
      },
      projectScope,
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });
  });

  it('does not let native confirmation substitute for workflow authority', async () => {
    const args = { command: 'echo audit-ok', cwd: testDir };
    await expect(confirmMcpTool({ tool: 'terminal_run', args }, projectScope)).resolves.toEqual({
      ok: true,
    });

    const result = await invokeMcpTool(
      { tool: 'nexus_terminal_run', args },
      projectScope,
    );
    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });

    const entries = readAuditLog(auditContext);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'ipc-renderer',
      tool: 'nexus_terminal_run',
      result: 'denied',
      user_authorized: false,
      args: { command: 'echo audit-ok', cwd: testDir },
    });
    expect(entries[0].timestamp).toBeTruthy();
    expect(typeof entries[0].duration_ms).toBe('number');
  });

  it('keeps repeated confirmed renderer effects fail-closed', async () => {
    const args = { command: 'echo one-shot', cwd: testDir };
    await expect(
      confirmMcpTool({ tool: 'nexus_terminal_run', args }, projectScope),
    ).resolves.toEqual({ ok: true });

    const first = await invokeMcpTool(
      { tool: 'nexus_terminal_run', args },
      projectScope,
    );
    const second = await invokeMcpTool(
      { tool: 'nexus_terminal_run', args },
      projectScope,
    );

    expect(first).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });
    expect(second).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });
  });

  it('denies an action outside the user-authorized args scope', async () => {
    const allowedArgs = { command: 'echo allowed', cwd: testDir };
    const otherArgs = { command: 'echo denied', cwd: testDir };
    await expect(confirmMcpTool({
      tool: 'nexus_terminal_run',
      args: allowedArgs,
    }, projectScope)).resolves.toEqual({
      ok: true,
    });

    const result = await invokeMcpTool(
      {
        tool: 'nexus_terminal_run',
        args: otherArgs,
      },
      projectScope,
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });
  });

  it('blocks high-impact Jarvis tools before their confirmation boundary', async () => {
    const result = await invokeMcpTool(
      {
        tool: 'nexus_remote_spawn',
        args: { target: 'build-host', cli: 'codex' },
      },
      projectScope,
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      tool: 'nexus_remote_spawn',
      error: expect.stringContaining('missionId and contextRevision'),
    });
  });
});
