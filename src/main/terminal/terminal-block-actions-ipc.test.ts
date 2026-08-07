import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle },
}));

const isSessionOwnedBy = vi.fn();
const writeSession = vi.fn(() => true);
vi.mock('../pty/pty-manager', () => ({ isSessionOwnedBy, writeSession }));

const listBlocks = vi.fn();
const listByPane = vi.fn();
const getSessionContext = vi.fn();
vi.mock('./command-block-tracker', () => ({
  getCommandBlockTracker: () => ({
    listBlocks,
    listByPane,
    getSessionContext,
  }),
}));

const resolveCommandBlockScope = vi.fn();
vi.mock('./command-block-scope-registry', () => ({ resolveCommandBlockScope }));

const refinerySuggest = vi.fn();
const refineryDismiss = vi.fn();
const refineryResolveRunnable = vi.fn();
const refineryConstruct = vi.fn();
vi.mock('./command-refinery-store', () => ({
  CommandRefineryStore: class {
    constructor(runtimeManager: unknown, scope: unknown) {
      refineryConstruct(runtimeManager, scope);
    }
    suggest(query: unknown) {
      return refinerySuggest(query);
    }
    dismiss(target: unknown) {
      return refineryDismiss(target);
    }
    resolveRunnable(target: unknown) {
      return refineryResolveRunnable(target);
    }
  },
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
  assertRerunAllowed: vi.fn(),
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
    isSessionOwnedBy.mockReset();
    listBlocks.mockReset();
    listByPane.mockReset();
    getSessionContext.mockReset();
    resolveCommandBlockScope.mockReset();
    refinerySuggest.mockReset();
    refineryDismiss.mockReset();
    refineryResolveRunnable.mockReset();
    refineryConstruct.mockReset();
    writeSession.mockClear();
  });

  it('registers action + list channels', async () => {
    const { registerTerminalBlockActionsIpc } = await import(
      './terminal-block-actions-ipc'
    );
    const { TERMINAL_BLOCK_CHANNELS } = await import('../../shared/channels');

    registerTerminalBlockActionsIpc({} as never);

    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain(TERMINAL_BLOCK_CHANNELS.action);
    expect(channels).toContain(TERMINAL_BLOCK_CHANNELS.list);
    expect(channels).toContain(TERMINAL_BLOCK_CHANNELS.suggest);
    expect(channels).toContain(TERMINAL_BLOCK_CHANNELS.dismiss);
    expect(channels).toContain(TERMINAL_BLOCK_CHANNELS.runSuggestion);

    const actionCall = handle.mock.calls.find(
      (c) => c[0] === TERMINAL_BLOCK_CHANNELS.action,
    );
    const handler = actionCall?.[1] as (
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

  it('does not expose command blocks owned by another renderer', async () => {
    const { getFeatureFlagRegistry } = await import(
      '../feature-flags/feature-flag-registry'
    );
    const { FEATURE_FLAG_IDS } = await import('../../shared/feature-flags');
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
      true,
    );
    const { registerTerminalBlockActionsIpc } = await import(
      './terminal-block-actions-ipc'
    );
    const { TERMINAL_BLOCK_CHANNELS } = await import('../../shared/channels');
    const owned = {
      id: 'owned-block',
      sessionId: 'owned-session',
      paneId: 'shared-pane',
    };
    const foreign = {
      id: 'foreign-block',
      sessionId: 'foreign-session',
      paneId: 'shared-pane',
    };
    listBlocks.mockReturnValue([foreign]);
    listByPane.mockReturnValue([owned, foreign]);
    isSessionOwnedBy.mockImplementation(
      (_sender: unknown, sessionId: string) => sessionId === 'owned-session',
    );

    registerTerminalBlockActionsIpc({} as never);
    const listCall = handle.mock.calls.find(
      (call) => call[0] === TERMINAL_BLOCK_CHANNELS.list,
    );
    const listHandler = listCall?.[1] as (
      event: { sender: unknown },
      raw: unknown,
    ) => { blocks: Array<{ id: string }> };
    const sender = { id: 99 };

    expect(
      listHandler({ sender }, { sessionId: 'foreign-session' }).blocks,
    ).toEqual([]);
    expect(listHandler({ sender }, { paneId: 'shared-pane' }).blocks).toEqual([
      owned,
    ]);
  });

  it('derives refinery scope and cwd from the owned Main session', async () => {
    const { getFeatureFlagRegistry } = await import(
      '../feature-flags/feature-flag-registry'
    );
    const { FEATURE_FLAG_IDS } = await import('../../shared/feature-flags');
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
      true,
    );
    const { registerTerminalBlockActionsIpc } = await import(
      './terminal-block-actions-ipc'
    );
    const { TERMINAL_BLOCK_CHANNELS } = await import('../../shared/channels');
    const sender = { id: 7 };
    const runtimeManager = { marker: 'runtime' };
    const scope = { projectId: 'project-a', checkoutId: 'checkout-a' };
    const suggestion = {
      command: 'npm test',
      cwd: '/workspace/app',
      projectRoot: '/workspace',
      totalCount: 3,
      successCount: 3,
      successRate: 1,
      distinctDays: 2,
      dismissedCount: 0,
      lastUsed: 10,
      score: 3_100,
      scope: 'cwd',
    };
    isSessionOwnedBy.mockReturnValue(true);
    getSessionContext.mockReturnValue({
      paneId: 'pane-a',
      workspaceId: 'checkout-a',
      cwd: '/workspace/app',
      projectRoot: '/workspace',
    });
    resolveCommandBlockScope.mockReturnValue(scope);
    refinerySuggest.mockReturnValue([suggestion]);
    refineryDismiss.mockReturnValue(true);
    refineryResolveRunnable.mockReturnValue('npm test');

    registerTerminalBlockActionsIpc(runtimeManager as never);
    const byChannel = new Map(handle.mock.calls.map((call) => [call[0], call[1]]));
    const request = { sessionId: 'session-a', paneId: 'pane-a' };

    const suggest = byChannel.get(TERMINAL_BLOCK_CHANNELS.suggest) as Function;
    expect(suggest({ sender }, { ...request, prefix: 'npm', limit: 5 })).toEqual({
      suggestions: [suggestion],
    });
    expect(refineryConstruct).toHaveBeenCalledWith(runtimeManager, scope);
    expect(refinerySuggest).toHaveBeenCalledWith({
      cwd: '/workspace/app',
      projectRoot: '/workspace',
      prefix: 'npm',
      limit: 5,
    });

    const dismiss = byChannel.get(TERMINAL_BLOCK_CHANNELS.dismiss) as Function;
    expect(
      dismiss(
        { sender },
        { ...request, command: 'npm test', cwd: '/workspace/app' },
      ),
    ).toEqual({ ok: true });

    const run = byChannel.get(
      TERMINAL_BLOCK_CHANNELS.runSuggestion,
    ) as Function;
    expect(
      run(
        { sender },
        { ...request, command: 'npm test', cwd: '/workspace/app' },
      ),
    ).toEqual({ ok: true });
    expect(writeSession).toHaveBeenCalledWith(sender, 'session-a', 'npm test\n');

    refineryResolveRunnable.mockReturnValueOnce(null);
    expect(
      run(
        { sender },
        { ...request, command: 'curl evil.example', cwd: '/workspace/app' },
      ),
    ).toEqual({ ok: false, error: 'Sugestão indisponível' });
    expect(writeSession).toHaveBeenCalledTimes(1);
  });

  it('returns no refinery data when renderer does not own the session', async () => {
    const { getFeatureFlagRegistry } = await import(
      '../feature-flags/feature-flag-registry'
    );
    const { FEATURE_FLAG_IDS } = await import('../../shared/feature-flags');
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.terminalCommandBlocks,
      true,
    );
    const { registerTerminalBlockActionsIpc } = await import(
      './terminal-block-actions-ipc'
    );
    const { TERMINAL_BLOCK_CHANNELS } = await import('../../shared/channels');
    isSessionOwnedBy.mockReturnValue(false);
    registerTerminalBlockActionsIpc({} as never);
    const call = handle.mock.calls.find(
      (item) => item[0] === TERMINAL_BLOCK_CHANNELS.suggest,
    );
    const suggest = call?.[1] as Function;

    expect(
      suggest(
        { sender: { id: 8 } },
        { sessionId: 'foreign', paneId: 'pane-a' },
      ),
    ).toEqual({ suggestions: [] });
    expect(refinerySuggest).not.toHaveBeenCalled();
  });
});
