import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dialog } from 'electron';
import { confirmMcpTool, clearMcpRendererSession } from '../mcp-ipc';
import { clearConfirmationTokensForTests } from '../confirmation-tokens';
import { clearAll } from '../permissions';
import { testProjectScope } from '../../orch/__tests__/scope-fixture';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-jarvis-mcp-ipc');
const projectScope = testProjectScope({ rootRealPath: testDir });

describe('mcp-ipc confirmation grant hardening', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  beforeEach(() => {
    clearAll();
    clearConfirmationTokensForTests();
    clearMcpRendererSession();
    vi.mocked(dialog.showMessageBox).mockClear();
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects a renderer-forged grant without a valid main token', async () => {
    await expect(
      confirmMcpTool({
        tool: 'nexus_terminal_run',
        args: { command: 'echo forged', cwd: testDir },
        granted: true,
      }, projectScope),
    ).resolves.toEqual({ ok: false, error: 'invalid_confirmation_token' });
  });

  it('does not prompt for central read-only or PREVC authority', async () => {
    await expect(
      confirmMcpTool({
        tool: 'nexus_context_doctor',
        args: {},
        granted: false,
      }, projectScope),
    ).resolves.toEqual({ ok: true });

    await expect(
      confirmMcpTool({
        tool: 'nexus_context_scaffold',
        args: {},
        granted: false,
      }, projectScope),
    ).resolves.toEqual({ ok: true });

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('keeps Nexus UI actions behind main-owned native confirmation', async () => {
    await expect(
      confirmMcpTool({
        tool: 'nexus_ui_action',
        args: { action: 'click', ref: 'u1e1' },
        granted: false,
      }, projectScope),
    ).resolves.toEqual({ ok: true });

    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });
});
