import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle },
}));

const runQuery = vi.fn(async (q: unknown) => ({
  generation: 1,
  query: (q as { text?: string }).text ?? '',
  hits: [],
  partial: false,
  completedSources: [],
  cancelled: false,
  elapsedMs: 0,
  projectRootSeen: (q as { projectRoot?: string }).projectRoot,
}));

vi.mock('./search-mixer-bootstrap', () => ({
  runSearchMixerQuery: (q: unknown) => runQuery(q),
}));

const requireScopedRoot = vi.fn((_sender?: unknown) => ({
  scope: {
    version: 1 as const,
    installationId: 'i',
    projectId: 'p',
    checkoutId: 'c',
    rootRealPath: '/workspace/real',
    identitySource: 'manifest' as const,
  },
  root: '/workspace/real',
}));

vi.mock('../security/scoped-workspace-fs', () => ({
  requireScopedRoot: (sender: unknown) => requireScopedRoot(sender),
}));

describe('search-mixer-ipc scope binding', () => {
  beforeEach(() => {
    handle.mockClear();
    runQuery.mockClear();
    requireScopedRoot.mockClear();
  });

  it('overwrites client projectRoot with sender workspace root', async () => {
    const { registerSearchMixerIpc } = await import('./search-mixer-ipc');
    const { SEARCH_MIXER_CHANNELS } = await import('../../shared/channels');
    registerSearchMixerIpc();

    expect(handle).toHaveBeenCalledWith(
      SEARCH_MIXER_CHANNELS.search,
      expect.any(Function),
    );
    const handler = handle.mock.calls[0]?.[1] as (
      event: { sender: unknown },
      raw: unknown,
    ) => Promise<unknown>;

    const sender = { id: 7 };
    await handler(
      { sender },
      {
        text: 'secret',
        projectRoot: '/evil/foreign/path',
        limit: 10,
      },
    );

    expect(requireScopedRoot).toHaveBeenCalledWith(sender);
    expect(runQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'secret',
        projectRoot: '/workspace/real',
      }),
    );
    const arg = runQuery.mock.calls[0]?.[0] as { projectRoot: string };
    expect(arg.projectRoot).not.toBe('/evil/foreign/path');
  });
});
