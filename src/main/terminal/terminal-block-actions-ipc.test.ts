import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle },
}));

const execute = vi.fn(
  async (
    _wc: unknown,
    _raw: unknown,
    _deps: unknown,
  ): Promise<{
    ok: boolean;
    action: 'rerun';
    payload: { sessionId: string };
  }> => ({
    ok: true,
    action: 'rerun',
    payload: { sessionId: 's1' },
  }),
);
vi.mock('./terminal-block-actions', () => ({
  defaultTerminalBlockActionDeps: () => ({
    writeToSession: vi.fn(() => true),
    isEnabled: () => true,
  }),
  executeTerminalBlockAction: (
    wc: unknown,
    raw: unknown,
    deps: unknown,
  ) => execute(wc, raw, deps),
}));

describe('registerTerminalBlockActionsIpc', () => {
  beforeEach(() => {
    handle.mockClear();
    execute.mockClear();
  });

  it('registers TERMINAL_BLOCK_CHANNELS.action with zod-validated product path', async () => {
    const { registerTerminalBlockActionsIpc } = await import(
      './terminal-block-actions-ipc'
    );
    const { TERMINAL_BLOCK_CHANNELS } = await import('../../shared/channels');

    registerTerminalBlockActionsIpc();

    expect(handle).toHaveBeenCalledWith(
      TERMINAL_BLOCK_CHANNELS.action,
      expect.any(Function),
    );

    const handler = handle.mock.calls[0]?.[1] as (
      event: { sender: unknown },
      raw: unknown,
    ) => Promise<unknown>;
    const sender = { id: 1 };
    await handler({ sender }, {
      action: 'rerun',
      block: {
        id: 'cb',
        sessionId: 's1',
        paneId: 'p',
        workspaceId: 'w',
        command: 'echo hi',
        cwd: '/tmp',
        shell: 'zsh',
        status: 'success',
      },
    });
    expect(execute).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({ action: 'rerun' }),
      expect.objectContaining({ writeToSession: expect.any(Function) }),
    );
  });
});
