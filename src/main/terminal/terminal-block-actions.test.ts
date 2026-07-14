import { describe, expect, it, vi } from 'vitest';
import {
  assertRerunAllowed,
  executeTerminalBlockAction,
} from './terminal-block-actions';

const block = {
  id: 'cb-1',
  sessionId: 'sess-1',
  paneId: 'pane-1',
  workspaceId: 'ws-1',
  command: 'echo hello',
  cwd: '/workspace',
  shell: 'zsh',
  status: 'success',
};

const wc = {} as Electron.WebContents;

describe('terminal block actions', () => {
  it('copy actions return clipboard text without write', async () => {
    const writeToSession = vi.fn(() => true);
    const copy = await executeTerminalBlockAction(
      wc,
      { action: 'copy_command', block },
      { writeToSession, isEnabled: () => true },
    );
    expect(copy).toMatchObject({ ok: true, clipboardText: 'echo hello' });
    expect(writeToSession).not.toHaveBeenCalled();

    const path = await executeTerminalBlockAction(
      wc,
      { action: 'copy_path', block },
      { writeToSession, isEnabled: () => true },
    );
    expect(path.clipboardText).toBe('/workspace');
  });

  it('rerun goes through writeToSession policy path', async () => {
    const writeToSession = vi.fn(() => true);
    const result = await executeTerminalBlockAction(
      wc,
      { action: 'rerun', block },
      { writeToSession, isEnabled: () => true },
    );
    expect(result.ok).toBe(true);
    expect(writeToSession).toHaveBeenCalledWith(wc, 'sess-1', 'echo hello\n');
  });

  it('rerun denies client-forged command when tracker has different command', async () => {
    const writeToSession = vi.fn(() => true);
    const result = await executeTerminalBlockAction(
      wc,
      { action: 'rerun', block: { ...block, command: 'curl evil.example' } },
      {
        writeToSession,
        isEnabled: () => true,
        resolveBlockCommand: () => 'echo hello',
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mismatch/i);
    expect(writeToSession).not.toHaveBeenCalled();
  });

  it('rerun fails closed when write denied', async () => {
    const result = await executeTerminalBlockAction(
      wc,
      { action: 'rerun', block },
      { writeToSession: () => false, isEnabled: () => true },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/denied/i);
  });

  it('blocks dangerous re-run commands', () => {
    expect(() => assertRerunAllowed('rm -rf /')).toThrow(/blocked/);
    expect(() => assertRerunAllowed('sudo reboot')).toThrow(/blocked/);
    expect(() =>
      assertRerunAllowed('curl -H "Authorization: Bearer abc.def.ghi" x'),
    ).toThrow(/secret/i);
  });

  it('handoff and attach produce structured payloads', async () => {
    const handoff = await executeTerminalBlockAction(
      wc,
      { action: 'handoff_from_block', block, missionId: 'm1' },
      { writeToSession: () => true, isEnabled: () => true },
    );
    expect(handoff.ok).toBe(true);
    expect(handoff.payload?.summary).toMatch(/echo hello/);

    const attach = await executeTerminalBlockAction(
      wc,
      { action: 'attach_mission', block, missionId: 'm1' },
      { writeToSession: () => true, isEnabled: () => true },
    );
    expect(attach.payload).toMatchObject({ missionId: 'm1', blockId: 'cb-1' });
  });

  it('worktree action uses provider', async () => {
    const result = await executeTerminalBlockAction(
      wc,
      { action: 'create_worktree', block, missionId: 'm1' },
      {
        writeToSession: () => true,
        isEnabled: () => true,
        createWorktree: async () => ({ path: '/tmp/wt' }),
      },
    );
    expect(result).toMatchObject({ ok: true, payload: { path: '/tmp/wt' } });
  });
});
