import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle },
  app: { getPath: () => '/user-data' },
}));

// handleTrusted (QLT-07) delega ao ipcMain.handle depois de checar a janela.
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: unknown) => handle(channel, handler),
}));

const blockStoreConstruct = vi.fn();
const blockStoreSearch = vi.fn();
const blockStoreInsert = vi.fn();
const blockStorePrune = vi.fn();
vi.mock('./command-block-store', () => ({
  CommandBlockStore: class {
    constructor(runtimeManager: unknown, scope: unknown) {
      blockStoreConstruct(runtimeManager, scope);
    }
    search(query: unknown) {
      return blockStoreSearch(query);
    }
    insertWithOutcome(input: unknown) {
      return blockStoreInsert(input);
    }
    prune() {
      return blockStorePrune();
    }
    enforceSizeBudget() {
      return 0;
    }
  },
}));

const importForScope = vi.fn();
vi.mock('./cli-history-import-service', () => ({
  importCliHistoryForScope: (deps: unknown) => importForScope(deps),
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
    blockStoreConstruct.mockReset();
    blockStoreSearch.mockReset();
    blockStoreInsert.mockReset();
    blockStorePrune.mockReset();
    importForScope.mockReset();
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

  describe('F-1171: histórico persistido', () => {
    const sender = { id: 11 };
    const scope = {
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: '/workspace',
    };
    const request = { sessionId: 'session-a', paneId: 'pane-a' };

    async function setup(enabled = true) {
      const { getFeatureFlagRegistry } = await import(
        '../feature-flags/feature-flag-registry'
      );
      const { FEATURE_FLAG_IDS } = await import('../../shared/feature-flags');
      getFeatureFlagRegistry().setOverride(
        FEATURE_FLAG_IDS.terminalCommandBlocks,
        enabled,
      );
      const { registerTerminalBlockActionsIpc } = await import(
        './terminal-block-actions-ipc'
      );
      const { TERMINAL_BLOCK_CHANNELS } = await import('../../shared/channels');
      isSessionOwnedBy.mockReturnValue(true);
      getSessionContext.mockReturnValue({
        paneId: 'pane-a',
        workspaceId: 'checkout-a',
        cwd: '/workspace/app',
        projectRoot: '/workspace',
      });
      resolveCommandBlockScope.mockReturnValue(scope);
      registerTerminalBlockActionsIpc({ marker: 'runtime' } as never);
      const byChannel = new Map(
        handle.mock.calls.map((call) => [call[0], call[1]]),
      );
      return {
        importHistory: byChannel.get(
          TERMINAL_BLOCK_CHANNELS.importCliHistory,
        ) as Function,
        searchHistory: byChannel.get(
          TERMINAL_BLOCK_CHANNELS.searchHistory,
        ) as Function,
      };
    }

    const counts = {
      files: 2,
      filesSkipped: 0,
      found: 3,
      imported: 3,
      duplicates: 0,
      skipped: 0,
      capped: false,
    };

    it('importa no escopo do pane dono e devolve as contagens', async () => {
      const { importHistory } = await setup();
      importForScope.mockResolvedValue(counts);
      await expect(importHistory({ sender }, request)).resolves.toEqual({
        ok: true,
        counts,
      });
      expect(blockStoreConstruct).toHaveBeenCalledWith({ marker: 'runtime' }, scope);
      expect(importForScope).toHaveBeenCalledWith(
        expect.objectContaining({
          userDataPath: '/user-data',
          checkoutId: 'checkout-a',
          target: { workspaceId: 'checkout-a', projectRoot: '/workspace' },
          // Raiz do escopo, não o cwd vivo do pane ('/workspace/app').
          fallbackCwd: '/workspace',
        }),
      );
      expect(blockStorePrune).toHaveBeenCalled();
    });

    it('valida o pedido (zod estrito) e recusa sessão alheia', async () => {
      const { importHistory, searchHistory } = await setup();
      const bad = await importHistory({ sender }, { ...request, extra: 1 });
      expect(bad.ok).toBe(false);
      expect(bad.error).toBe('Não foi possível importar o histórico');
      const badSearch = searchHistory({ sender }, { ...request, limit: 500 });
      expect(badSearch.entries).toEqual([]);
      expect(badSearch.error).toBeTruthy();
      isSessionOwnedBy.mockReturnValue(false);
      const foreign = await importHistory({ sender }, request);
      expect(foreign.ok).toBe(false);
      expect(importForScope).not.toHaveBeenCalled();
      expect(blockStoreSearch).not.toHaveBeenCalled();
    });

    it('não roda duas importações do mesmo checkout ao mesmo tempo', async () => {
      const { importHistory } = await setup();
      let release: (value: unknown) => void = () => {};
      importForScope.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const first = importHistory({ sender }, request);
      const second = await importHistory({ sender }, request);
      expect(second).toEqual({ ok: false, error: 'Importação já em andamento' });
      release(counts);
      await expect(first).resolves.toEqual({ ok: true, counts });
    });

    it('com a flag desligada não importa nem busca', async () => {
      const { importHistory, searchHistory } = await setup(false);
      expect((await importHistory({ sender }, request)).ok).toBe(false);
      expect(searchHistory({ sender }, request).entries).toEqual([]);
      expect(importForScope).not.toHaveBeenCalled();
    });

    it('busca paginada no SQLite com origem de cada comando', async () => {
      const { searchHistory } = await setup();
      const row = (id: string, sessionId: string) => ({
        id,
        sessionId,
        paneId: 'p',
        workspaceId: 'checkout-a',
        command: `echo ${id}`,
        cwd: '/workspace',
        shell: 'zsh',
        startedAt: 10,
        status: 'unknown',
        redaction: { redacted: false, denylisted: false, secretHits: 0 },
        idempotencyKey: 'a'.repeat(64),
      });
      blockStoreSearch.mockReturnValue([
        row('a', 'cli-import:claude:abc'),
        row('b', 'live-session'),
        row('c', 'live-session'),
      ]);
      const result = searchHistory(
        { sender },
        { ...request, query: ' echo ', limit: 2, offset: 4 },
      );
      expect(blockStoreSearch).toHaveBeenCalledWith({
        commandContains: 'echo',
        limit: 3,
        offset: 4,
      });
      expect(result.hasMore).toBe(true);
      expect(result.entries).toEqual([
        { id: 'a', command: 'echo a', cwd: '/workspace', status: 'unknown', startedAt: 10, origin: 'imported' },
        { id: 'b', command: 'echo b', cwd: '/workspace', status: 'unknown', startedAt: 10, origin: 'recorded' },
      ]);
    });
  });
});
