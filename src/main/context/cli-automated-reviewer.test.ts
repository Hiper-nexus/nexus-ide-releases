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

function acceptSpawn(
  paneId: string,
  sessionId: string,
  hooks: SpawnPaneHooks = {},
  prompt = 'review brief',
): { paneId: string; sessionId: string } {
  hooks.onPaneCreated?.(paneId, sessionId);
  hooks.onPromptAccepted?.(paneId, sessionId, prompt);
  return { paneId, sessionId };
}

describe('CLI automated reviewer', () => {
  it('spawns a read-only independent route and waits for structured submission', async () => {
    const { sessions, input } = fixture();
    const spawn = vi.fn(async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
      const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
      if (!match) throw new Error('review session missing from prompt');
      sessions.submit(match[1], {
        id: 'reviewer-claude-1', sessionId: 'session-review', provider: 'claude',
        missionId: 'mission-a', checkoutPath: '/candidate',
      }, []);
      return acceptSpawn('pane-review', 'session-review', hooks, options.prompt);
    });
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(reviewer.run(input)).resolves.toMatchObject({ ready: true });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        executionScope: expect.objectContaining({ rootRealPath: '/candidate' }),
        omitHandoffContract: true,
        allowedTools: expect.not.arrayContaining(['nexus_file_write', 'nexus_terminal_run']),
        prompt: expect.stringContaining(
          'dead or unreachable code, abandoned compatibility paths, duplicate implementations',
        ),
      }),
      expect.objectContaining({
        onPaneCreated: expect.any(Function),
        onPromptAccepted: expect.any(Function),
        invocation: expect.any(Object),
      }),
    );
  });

  it('provisions and binds one real render pane before a design reviewer starts', async () => {
    const { sessions, input, scope } = fixture();
    const designInput = {
      ...input,
      contract: {
        ...input.contract,
        requiredSensors: Object.freeze(['design-system']),
      },
    };
    const closeDesignSurface = vi.fn(async () => undefined);
    const prepareDesignSurface = vi.fn(async (prepared: {
      reviewSessionId: string;
      missionId: string;
      scope: typeof scope;
      executionScope: typeof scope;
    }) => ({
      paneId: 'browser-review',
      previewId: 'preview-review',
      url: 'http://127.0.0.1:1234/',
      missionId: prepared.missionId,
      scope: prepared.scope,
      executionScope: prepared.executionScope,
    }));
    const spawn = vi.fn(async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
      const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
      if (!match) throw new Error('review session missing from prompt');
      sessions.recordDesignInspection(
        match[1],
        'session-review',
        'browser-review',
        'read',
      );
      sessions.recordDesignInspection(
        match[1],
        'session-review',
        'browser-review',
        'screenshot',
      );
      sessions.submit(match[1], {
        id: 'reviewer-claude-1',
        sessionId: 'session-review',
        provider: 'claude',
        missionId: 'mission-a',
        checkoutPath: '/candidate',
      }, []);
      return acceptSpawn('pane-review', 'session-review', hooks, options.prompt);
    });
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => true,
      prepareDesignSurface,
      closeDesignSurface,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(reviewer.run(designInput)).resolves.toMatchObject({ ready: true });
    expect(prepareDesignSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-a',
        executionScope: expect.objectContaining({ rootRealPath: '/candidate' }),
      }),
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.arrayContaining([
          'nexus_browser_read',
          'nexus_browser_screenshot',
        ]),
        allowedSkills: expect.arrayContaining(['impeccable']),
        prompt: expect.stringContaining(
          'Main-provisioned browser paneId: browser-review',
        ),
      }),
      expect.any(Object),
    );
    expect(
      (spawn.mock.calls[0]?.[0] as SpawnToolOptions).prompt,
    ).toContain('Approved local preview: http://127.0.0.1:1234/');
    expect(closeDesignSurface).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'browser-review' }),
    );
  });

  it('fails closed before spawning when a design render cannot be provisioned', async () => {
    const { sessions, input } = fixture();
    const spawn = vi.fn();
    const closeDesignSurface = vi.fn();
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => true,
      prepareDesignSurface: async () => {
        throw new Error('exactly one Nexus-owned local preview; found 0');
      },
      closeDesignSurface,
    });

    await expect(
      reviewer.run({
        ...input,
        contract: {
          ...input.contract,
          requiredSensors: Object.freeze(['design-system']),
        },
      }),
    ).rejects.toThrow(/exactly one Nexus-owned local preview/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(closeDesignSurface).not.toHaveBeenCalled();
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
      spawnAttempts: 1,
      maxIdleNudges: 0,
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
      spawnAttempts: 1,
      maxIdleNudges: 0,
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
        if (options.adapterId === 'claude') {
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
        return acceptSpawn('pane-late', 'session-late', hooks, options.prompt);
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
      spawnAttempts: 1,
      maxIdleNudges: 0,
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

  it('retries spawn when prompt acceptance is unproven, then waits for submit', async () => {
    const { sessions, input } = fixture();
    let attempts = 0;
    const spawn = vi.fn(async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
      attempts += 1;
      const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
      if (!match) throw new Error('review session missing from prompt');
      hooks.onPaneCreated?.(`pane-${attempts}`, `session-${attempts}`);
      if (attempts < 2) {
        throw new Error(
          'agent prompt remained live without physical acceptance proof',
        );
      }
      sessions.submit(match[1], {
        id: 'reviewer-claude-1',
        sessionId: `session-${attempts}`,
        provider: 'claude',
        missionId: 'mission-a',
        checkoutPath: '/candidate',
      }, []);
      hooks.onPromptAccepted?.(
        `pane-${attempts}`,
        `session-${attempts}`,
        options.prompt ?? '',
      );
      return { paneId: `pane-${attempts}`, sessionId: `session-${attempts}` };
    });
    const close = vi.fn(async () => true);
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close,
      timeoutMs: 100,
      spawnAttempts: 3,
      maxIdleNudges: 0,
    });

    await expect(reviewer.run(input)).resolves.toMatchObject({ ready: true });
    expect(attempts).toBe(2);
    expect(close).toHaveBeenCalledWith('pane-1');
  });

  it('re-delivers a short nudge when the reviewer pane returns to idle', async () => {
    vi.useFakeTimers();
    const { sessions, input } = fixture();
    const deliverPrompt = vi.fn(
      async (_sessionId: string, _prompt: string) => true,
    );
    let reviewSessionId = '';
    const spawn = vi.fn(async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
      const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
      if (!match) throw new Error('review session missing from prompt');
      reviewSessionId = match[1];
      return acceptSpawn('pane-review', 'session-review', hooks, options.prompt);
    });
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => true,
      deliverPrompt,
      isInjectableIdle: () => true,
      timeoutMs: 5_000,
      idleNudgeMs: 50,
      maxIdleNudges: 2,
    });

    const running = reviewer.run(input);
    await vi.advanceTimersByTimeAsync(60);
    expect(deliverPrompt).toHaveBeenCalled();
    expect(String(deliverPrompt.mock.calls[0]?.[1])).toContain('resume');
    sessions.submit(reviewSessionId, {
      id: 'reviewer-claude-1',
      sessionId: 'session-review',
      provider: 'claude',
      missionId: 'mission-a',
      checkoutPath: '/candidate',
    }, []);
    await expect(running).resolves.toMatchObject({ ready: true });
    vi.useRealTimers();
  });
});
