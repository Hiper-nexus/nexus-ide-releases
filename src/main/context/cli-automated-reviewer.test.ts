import { describe, expect, it, vi } from 'vitest';
import { compileMissionContract } from './contract-compiler';
import { CliAutomatedReviewer } from './cli-automated-reviewer';
import { AutomatedReviewSessionRegistry } from './automated-review-session';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import {
  type SpawnPaneHooks,
  type SpawnToolOptions,
} from '../orch/tool-util';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const sessions = new AutomatedReviewSessionRegistry();
  const scope = testProjectScope({ rootRealPath: '/candidate' });
  const contract = compileMissionContract({
    schemaVersion: 1,
    scope,
    missionId: 'mission-a',
    baseCommit: 'a'.repeat(40),
    contextRevision: 'c'.repeat(64),
    goal: 'Review behavior',
    acceptanceCriteria: [{ id: 'works', statement: 'Works' }],
  }, { invariantRefs: new Set(), availableSensorIds: new Set(), blockingConflictIds: [] });
  const binding = {
    projectId: scope.projectId, checkoutId: scope.checkoutId, missionId: 'mission-a',
    contractHash: contract.contractHash, contextHash: contract.contextRevision,
    baseSha: contract.baseCommit, headSha: 'b'.repeat(40), diffHash: 'd'.repeat(64),
  };
  const input = {
    scope,
    checkoutPath: '/candidate',
    contract,
    binding,
    author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
    contextMarkdown: '# Context',
    persist: () => {},
  };
  return { sessions, scope, contract, binding, input };
}

describe('CLI automated reviewer', () => {
  it('spawns a read-only independent route and waits for structured submission', async () => {
    const { sessions, input } = fixture();
    const spawn = vi.fn(async (options: SpawnToolOptions) => {
      const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
      if (!match) throw new Error('review session missing from prompt');
      sessions.submit(match[1], {
        id: 'reviewer-claude-1', sessionId: 'session-review', provider: 'claude',
        missionId: 'mission-a', checkoutPath: '/candidate',
      }, []);
      return { paneId: 'pane-review', sessionId: 'session-review' };
    });
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => true,
      timeoutMs: 100,
    });

    await expect(reviewer.run(input)).resolves.toMatchObject({ ready: true });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        executionScope: expect.objectContaining({ rootRealPath: '/candidate' }),
        allowedTools: expect.not.arrayContaining(['nexus_file_write', 'nexus_terminal_run']),
      }),
      expect.objectContaining({
        onPaneCreated: expect.any(Function),
        invocation: expect.any(Object),
      }),
    );
  });

  it('does not spawn after authority is revoked during deferred route selection', async () => {
    const { sessions, input } = fixture();
    const routes = deferred<readonly [{ readonly adapterId: string }]>();
    const spawn = vi.fn();
    const controller = new AbortController();
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => routes.promise,
      spawn,
      close: () => true,
    });

    const running = reviewer.run({ ...input, signal: controller.signal });
    controller.abort();
    routes.resolve([{ adapterId: 'claude' }]);

    await expect(running).rejects.toThrow(/authority_revoked/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('waits for physical pane teardown when revoked during spawn', async () => {
    const { sessions, input } = fixture();
    const paneCreated = deferred<void>();
    const closeResult = deferred<boolean>();
    const controller = new AbortController();
    const spawn = vi.fn(
      async (_options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        hooks.onPaneCreated?.('pane-review', 'session-review');
        paneCreated.resolve();
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new Error('session_authority_revoked'));
          hooks.invocation?.signal?.addEventListener('abort', onAbort, {
            once: true,
          });
          if (hooks.invocation?.signal?.aborted) onAbort();
        });
        throw new Error('unreachable');
      },
    );
    const close = vi.fn(() => closeResult.promise);
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close,
      isSessionLive: () => true,
    });

    let settled = false;
    const running = reviewer.run({ ...input, signal: controller.signal });
    void running.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await paneCreated.promise;
    controller.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith('pane-review'));
    expect(settled).toBe(false);

    closeResult.resolve(true);
    await expect(running).rejects.toThrow(/authority_revoked/i);
    expect(settled).toBe(true);
  });

  it('fails closed when a live reviewer pane has no physical exit proof', async () => {
    const { sessions, input } = fixture();
    const controller = new AbortController();
    const spawn = vi.fn(
      async (_options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        hooks.onPaneCreated?.('pane-review', 'session-review');
        controller.abort();
        throw new Error('session_authority_revoked');
      },
    );
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => false,
      isSessionLive: () => true,
    });

    await expect(
      reviewer.run({ ...input, signal: controller.signal }),
    ).rejects.toThrow(/physical exit proof/i);
  });

  it('waits for sibling spawn flights and closes every late-created pane', async () => {
    const { sessions, input } = fixture();
    const lateSpawn = deferred<void>();
    const firstSpawned = deferred<void>();
    const controller = new AbortController();
    const close = vi.fn(async () => true);
    const spawn = vi.fn(
      async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        if (options.title?.endsWith('-1')) {
          hooks.onPaneCreated?.('pane-first', 'session-first');
          firstSpawned.resolve();
          await new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(new Error('session_authority_revoked'));
            hooks.invocation?.signal?.addEventListener('abort', onAbort, {
              once: true,
            });
            if (hooks.invocation?.signal?.aborted) onAbort();
          });
        }
        await lateSpawn.promise;
        hooks.onPaneCreated?.('pane-late', 'session-late');
        return { paneId: 'pane-late', sessionId: 'session-late' };
      },
    );
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [
        { adapterId: 'claude' },
        { adapterId: 'agy' },
      ],
      spawn,
      close,
      isSessionLive: () => true,
    });

    let settled = false;
    const running = reviewer.run({ ...input, signal: controller.signal });
    void running.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await firstSpawned.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);

    lateSpawn.resolve();
    await expect(running).rejects.toThrow(/authority_revoked/i);
    expect(close).toHaveBeenCalledWith('pane-first');
    expect(close).toHaveBeenCalledWith('pane-late');
    expect(close).toHaveBeenCalledTimes(2);
  });
});
