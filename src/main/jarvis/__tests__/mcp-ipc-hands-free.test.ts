/**
 * Mão do operador por voz, de ponta a ponta no despachante real (registro e
 * handlers reais): a Jarvis grava arquivo no workspace SEM missão e SEM modal,
 * enquanto o que continua exigindo autoridade (push, comando de shell,
 * ferramenta fora da lista) segue barrado exatamente como antes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  clearMcpRendererSession,
  confirmMcpTool,
  invokeMcpTool,
} from '../mcp-ipc';
import { clearAll } from '../permissions';
import {
  clearAuditLogForTests,
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
  readAuditLog,
  type AuditContext,
} from '../audit-log';
import { clearConfirmationTokensForTests } from '../confirmation-tokens';
import { ProjectRuntimeManager } from '../../runtime/project-runtime-manager';
import type { ProjectExecutionScope } from '../../../shared/types';

const dialog = vi.hoisted(() => ({ showMessageBox: vi.fn(async () => ({ response: 1 })) }));

vi.mock('electron', () => {
  const win = { isDestroyed: () => false, isVisible: () => true, isFocusable: () => true };
  return {
    ipcMain: { handle: vi.fn() },
    BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => null },
    dialog,
  };
});

const testDir = path.join(os.tmpdir(), 'nexus-jarvis-hands-free-mcp-ipc');
let auditManager: ProjectRuntimeManager;
let auditContext: AuditContext;
let projectScope: ProjectExecutionScope;

describe('Jarvis mãos-livres no despachante real (sem missão)', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    projectScope = {
      version: 1,
      installationId: 'installation-hands-free-test',
      projectId: 'project-hands-free-test',
      checkoutId: 'checkout-hands-free-test',
      rootRealPath: fs.realpathSync(testDir),
      identitySource: 'manifest',
    };
    auditManager = new ProjectRuntimeManager({
      baseDir: path.join(testDir, 'audit-runtime'),
      appVersion: 'hands-free-test',
    });
    configureAuditLogRuntime(auditManager);
    auditContext = { scope: projectScope };
  });

  beforeEach(() => {
    clearAll();
    clearConfirmationTokensForTests();
    clearMcpRendererSession();
    clearAuditLogForTests(auditContext);
    dialog.showMessageBox.mockClear();
  });

  afterAll(() => {
    disposeAuditLogRuntime();
    auditManager.closeAll();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('grava um arquivo do workspace sem missão e sem abrir diálogo', async () => {
    const result = await invokeMcpTool(
      { tool: 'nexus_file_write', args: { path: 'jarvis-hands-free.txt', content: 'ola' } },
      projectScope,
    );

    expect(result).toMatchObject({ ok: true, tool: 'nexus_file_write' });
    expect(fs.readFileSync(path.join(testDir, 'jarvis-hands-free.txt'), 'utf8')).toBe('ola');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();

    const entries = readAuditLog(auditContext);
    expect(entries).toHaveLength(2); // intent + ok
    expect(entries.at(-1)).toMatchObject({
      source: 'ipc-renderer',
      tool: 'nexus_file_write',
      result: 'ok',
      user_authorized: false,
    });
  });

  it('a contenção de caminho do handler continua valendo (nada fora do workspace)', async () => {
    const outside = path.join(os.tmpdir(), 'nexus-hands-free-escape.txt');
    fs.rmSync(outside, { force: true });

    const result = await invokeMcpTool(
      { tool: 'nexus_file_write', args: { path: '../nexus-hands-free-escape.txt', content: 'x' } },
      projectScope,
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('o confirm do renderer não abre diálogo para o que a política libera', async () => {
    await expect(
      confirmMcpTool(
        { tool: 'nexus_file_write', args: { path: 'a.txt', content: 'x' } },
        projectScope,
      ),
    ).resolves.toEqual({ ok: true });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('push remoto segue barrado sem missão e pede diálogo no confirm', async () => {
    const denied = await invokeMcpTool({ tool: 'nexus_git_push', args: {} }, projectScope);
    expect(denied).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });

    await confirmMcpTool({ tool: 'nexus_git_push', args: {} }, projectScope);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('comando de shell via MCP segue preso à autoridade de missão (a Jarvis usa run_command / pane)', async () => {
    const result = await invokeMcpTool(
      { tool: 'nexus_terminal_run', args: { command: 'echo oi', cwd: testDir } },
      projectScope,
    );

    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: expect.stringContaining('missionId and contextRevision'),
    });
  });

  it('ferramenta efetiva fora da lista mãos-livres segue barrada sem missão', async () => {
    for (const [tool, args] of [
      ['nexus_cron_schedule', {}],
      ['nexus_skills', { op: 'list' }],
      ['nexus_harness', {}],
    ] as const) {
      const result = await invokeMcpTool({ tool, args: { ...args } }, projectScope);
      expect(result, tool).toMatchObject({
        ok: false,
        denied: true,
        error: expect.stringContaining('missionId and contextRevision'),
      });
    }
  });
});
