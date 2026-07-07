import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirmMcpTool, clearMcpRendererSession } from '../mcp-ipc';
import { clearConfirmationTokensForTests } from '../confirmation-tokens';
import { clearAll } from '../permissions';
import {
  clearAuditLog,
  setAuditLogPathForTests,
} from '../audit-log';

const workspace = vi.hoisted(() => ({ current: '' }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
}));

vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-jarvis-mcp-ipc');
const testAuditLog = path.join(testDir, 'jarvis-actions.log');

describe('mcp-ipc confirmation grant hardening', () => {
  beforeAll(() => {
    workspace.current = testDir;
    fs.mkdirSync(testDir, { recursive: true });
    setAuditLogPathForTests(testAuditLog);
  });

  beforeEach(() => {
    clearAll();
    clearConfirmationTokensForTests();
    clearMcpRendererSession();
    clearAuditLog();
  });

  afterAll(() => {
    setAuditLogPathForTests(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects a renderer-forged grant without a valid main token', async () => {
    await expect(
      confirmMcpTool({
        tool: 'nexus_terminal_run',
        args: { command: 'echo forged', cwd: testDir },
        granted: true,
      }),
    ).resolves.toEqual({ ok: false, error: 'invalid_confirmation_token' });
  });
});
