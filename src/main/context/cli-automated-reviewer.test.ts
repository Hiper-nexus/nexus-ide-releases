import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileMissionContract } from './contract-compiler';
import { AutomatedReviewSessionRegistry } from './automated-review-session';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import {
  type SpawnPaneHooks,
  type SpawnToolOptions,
} from '../orch/tool-util';
import type { DetachedReviewWorktree } from './detached-review-worktree';

const cryptoIdControl = vi.hoisted(() => ({
  ids: [] as string[],
}));

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>(
    'node:crypto',
  );
  return {
    ...actual,
    randomUUID: () => cryptoIdControl.ids.shift() ?? actual.randomUUID(),
  };
});

const persistedPaneStore = vi.hoisted(() => ({
  findByPaneId: vi.fn<(paneId: string) => Record<string, unknown> | null>(
    () => null,
  ),
  remove: vi.fn<(id: string) => boolean>(() => true),
}));

vi.mock('../orch/project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn(() => ({
    missionPanes: persistedPaneStore,
  })),
}));

import { CliAutomatedReviewer } from './cli-automated-reviewer';

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
  const scope = testProjectScope({ rootRealPath: '/project' });
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
    reviewPurpose: 'candidate' as const,
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
  beforeEach(() => {
    cryptoIdControl.ids.length = 0;
    persistedPaneStore.findByPaneId.mockReset();
    persistedPaneStore.findByPaneId.mockReturnValue(null);
    persistedPaneStore.remove.mockReset();
    persistedPaneStore.remove.mockReturnValue(true);
  });

  it('uses a detached checkout and persists buffered reports only after teardown and exact proof', async () => {
    const { sessions, input, scope } = fixture();
    const events: string[] = [];
    const checkoutPath = '/tmp/nexus-prevc-review-test/checkout';
    const persist = vi.fn(() => {
      events.push('persist');
    });
    const worktree: DetachedReviewWorktree = {
      checkoutPath,
      verify: vi.fn(async () => {
        events.push('verify');
      }),
      dispose: vi.fn(async () => {
        events.push('dispose');
      }),
    };
    const spawn = vi.fn(
      async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        events.push('spawn');
        const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        sessions.submit(
          match[1],
          {
            id: 'reviewer-claude-1',
            sessionId: 'session-review',
            provider: 'claude',
            missionId: 'mission-a',
            checkoutPath,
          },
          [],
        );
        return acceptSpawn(
          'pane-review',
          'session-review',
          hooks,
          options.prompt,
        );
      },
    );
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      createDetachedWorktree: vi.fn(async () => worktree),
      spawn,
      close: async () => {
        events.push('close');
        return true;
      },
      retirePane: async () => {
        events.push('retire');
        return true;
      },
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        checkoutPath: scope.rootRealPath,
        persist,
      }),
    ).resolves.toMatchObject({ ready: true });

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: checkoutPath,
        executionScope: expect.objectContaining({
          rootRealPath: checkoutPath,
        }),
      }),
      expect.any(Object),
    );
    expect(worktree.verify).toHaveBeenCalledWith(
      input.binding,
      undefined,
    );
    expect(events).toEqual([
      'spawn',
      'close',
      'retire',
      'verify',
      'persist',
      'dispose',
    ]);
  });

  it('documents the exact non-empty finding shape and reviewer tool boundary', async () => {
    const { sessions, input } = fixture();
    let reviewerBrief = '';
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn: async (options, hooks = {}) => {
        reviewerBrief = options.prompt ?? '';
        const match = reviewerBrief.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        sessions.submit(match[1], {
          id: options.agentName!,
          sessionId: 'session-review',
          provider: 'claude',
          missionId: 'mission-a',
          checkoutPath: '/candidate',
        }, []);
        return acceptSpawn(
          'pane-review',
          'session-review',
          hooks,
          reviewerBrief,
        );
      },
      close: () => true,
      retirePane: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(reviewer.run(input)).resolves.toMatchObject({ ready: true });

    expect(reviewerBrief).toContain(
      'nexus_handoff_list: it is not part of this reviewer profile',
    );
    expect(reviewerBrief).toContain(
      '"severity":"high","category":"correctness","file":"src/example.ts"',
    );
    expect(reviewerBrief).toContain(
      '"criterionRefs":[],"invariantRefs":[],"evidence":',
    );
    expect(reviewerBrief).toContain(
      '"recommendation":',
    );
  });

  it('reviews the frozen plan before execution without treating future deliverables as missing', async () => {
    const { sessions, input } = fixture();
    let reviewerBrief = '';
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn: async (options, hooks = {}) => {
        reviewerBrief = options.prompt ?? '';
        const match = reviewerBrief.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        sessions.submit(match[1], {
          id: options.agentName!,
          sessionId: 'session-review',
          provider: 'claude',
          missionId: 'mission-a',
          checkoutPath: '/candidate',
        }, []);
        return acceptSpawn(
          'pane-review',
          'session-review',
          hooks,
          reviewerBrief,
        );
      },
      close: () => true,
      retirePane: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        reviewPurpose: 'pre-execution',
        preExecutionPlanBinding: {
          intentVersion: 1,
          planHash: 'f'.repeat(64),
        },
        designInspection: 'deferred',
      }),
    ).resolves.toMatchObject({ ready: true });

    expect(reviewerBrief).toContain('Independent Pre-Execution Review');
    expect(reviewerBrief).toContain(
      'Worker candidates have not been constructed or integrated yet',
    );
    expect(reviewerBrief).toContain(
      'absence of requested deliverables, changed files, a candidate diff',
    );
    expect(reviewerBrief).toContain('MUST NOT be reported as a finding');
    expect(reviewerBrief).not.toContain(
      'Trace each changed behavior through callers',
    );
  });

  it('accepts detached council reports regardless of UUID sort order', async () => {
    cryptoIdControl.ids.push(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '00000000-0000-4000-8000-000000000001',
    );
    const { sessions, input, scope } = fixture();
    const checkoutPath = '/tmp/nexus-prevc-review-order/checkout';
    const persist = vi.fn();
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [
        { adapterId: 'claude' },
        { adapterId: 'codex' },
      ],
      createDetachedWorktree: async () => ({
        checkoutPath,
        verify: async () => undefined,
        dispose: async () => undefined,
      }),
      spawn: async (options, hooks = {}) => {
        const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        const sessionId = `session-${options.adapterId}`;
        sessions.submit(match[1], {
          id: options.agentName!,
          sessionId,
          provider: options.adapterId,
          missionId: 'mission-a',
          checkoutPath,
        }, []);
        return acceptSpawn(
          `pane-${options.adapterId}`,
          sessionId,
          hooks,
          options.prompt,
        );
      },
      close: () => true,
      retirePane: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        checkoutPath: scope.rootRealPath,
        contract: {
          ...input.contract,
          risk: 'critical',
        },
        persist,
      }),
    ).resolves.toMatchObject({
      ready: true,
      reports: [
        { reviewId: '00000000-0000-4000-8000-000000000001' },
        { reviewId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      ],
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('does not persist detached review reports when the checkout changes before proof', async () => {
    const { sessions, input, scope } = fixture();
    const checkoutPath = '/tmp/nexus-prevc-review-mutated/checkout';
    const persist = vi.fn();
    const dispose = vi.fn(async () => undefined);
    const spawn = vi.fn(
      async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        sessions.submit(
          match[1],
          {
            id: 'reviewer-claude-1',
            sessionId: 'session-review',
            provider: 'claude',
            missionId: 'mission-a',
            checkoutPath,
          },
          [],
        );
        return acceptSpawn(
          'pane-review',
          'session-review',
          hooks,
          options.prompt,
        );
      },
    );
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      createDetachedWorktree: async () => ({
        checkoutPath,
        verify: async () => {
          throw new Error('detached review checkout changed');
        },
        dispose,
      }),
      spawn,
      close: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        checkoutPath: scope.rootRealPath,
        persist,
      }),
    ).rejects.toThrow(/checkout changed/i);
    expect(persist).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not invalidate a verified review when disposable-clone cleanup fails', async () => {
    const { sessions, input, scope } = fixture();
    const checkoutPath = '/tmp/nexus-prevc-review-cleanup-failure/checkout';
    const persist = vi.fn();
    const spawn = vi.fn(
      async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        sessions.submit(
          match[1],
          {
            id: options.agentName!,
            sessionId: 'session-review',
            provider: 'claude',
            missionId: 'mission-a',
            checkoutPath,
          },
          [],
        );
        return acceptSpawn(
          'pane-review',
          'session-review',
          hooks,
          options.prompt,
        );
      },
    );
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      createDetachedWorktree: async () => ({
        checkoutPath,
        verify: async () => undefined,
        dispose: async () => {
          throw new Error('temporary clone busy');
        },
      }),
      spawn,
      close: () => true,
      retirePane: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        checkoutPath: scope.rootRealPath,
        persist,
      }),
    ).resolves.toMatchObject({ ready: true });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('closes a partial pane before disposing the detached checkout on spawn failure', async () => {
    const { sessions, input, scope } = fixture();
    const events: string[] = [];
    const checkoutPath = '/tmp/nexus-prevc-review-spawn-failure/checkout';
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      createDetachedWorktree: async () => ({
        checkoutPath,
        verify: async () => undefined,
        dispose: async () => {
          events.push('dispose');
        },
      }),
      spawn: async (_options, hooks = {}) => {
        hooks.onPaneCreated?.('pane-review', 'session-review');
        throw new Error('spawn failed');
      },
      close: async () => {
        events.push('close');
        return true;
      },
      retirePane: async () => {
        events.push('retire');
        return true;
      },
      spawnAttempts: 1,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        checkoutPath: scope.rootRealPath,
      }),
    ).rejects.toThrow(/spawn failed/i);
    expect(events).toEqual(['close', 'retire', 'dispose']);
  });

  it('closes panes before disposing the detached checkout after AbortSignal revocation', async () => {
    const { sessions, input, scope } = fixture();
    const events: string[] = [];
    const paneCreated = deferred<void>();
    const controller = new AbortController();
    const checkoutPath = '/tmp/nexus-prevc-review-aborted/checkout';
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      createDetachedWorktree: async () => ({
        checkoutPath,
        verify: async () => undefined,
        dispose: async () => {
          events.push('dispose');
        },
      }),
      spawn: async (_options, hooks = {}) => {
        hooks.onPaneCreated?.('pane-review', 'session-review');
        paneCreated.resolve();
        return new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new Error('session_authority_revoked'));
          hooks.invocation?.signal?.addEventListener('abort', onAbort, {
            once: true,
          });
        });
      },
      close: async () => {
        events.push('close');
        return true;
      },
      retirePane: async () => {
        events.push('retire');
        return true;
      },
      spawnAttempts: 1,
      maxIdleNudges: 0,
    });

    const running = reviewer.run({
      ...input,
      checkoutPath: scope.rootRealPath,
      signal: controller.signal,
    });
    await paneCreated.promise;
    controller.abort();

    await expect(running).rejects.toThrow(/authority_revoked/i);
    expect(events).toEqual(['close', 'retire', 'dispose']);
  });

  it('spawns a read-only independent route and waits for structured submission', async () => {
    const { sessions, input } = fixture();
    const createDetachedWorktree = vi.fn();
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
      createDetachedWorktree,
      spawn,
      close: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(reviewer.run(input)).resolves.toMatchObject({ ready: true });
    expect(createDetachedWorktree).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        executionScope: expect.objectContaining({ rootRealPath: '/candidate' }),
        omitHandoffContract: true,
        transient: true,
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

  it('defers rendered UI inspection during root pre-execution review', async () => {
    const { sessions, input, scope } = fixture();
    const checkoutPath = '/tmp/nexus-prevc-review-ui-context/checkout';
    const prepareDesignSurface = vi.fn();
    const spawn = vi.fn(
      async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        sessions.submit(
          match[1],
          {
            id: options.agentName ?? 'reviewer-claude-1',
            sessionId: 'session-review',
            provider: 'claude',
            missionId: 'mission-a',
            checkoutPath,
          },
          [],
        );
        return acceptSpawn(
          'pane-review',
          'session-review',
          hooks,
          options.prompt,
        );
      },
    );
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      createDetachedWorktree: async () => ({
        checkoutPath,
        verify: async () => undefined,
        dispose: async () => undefined,
      }),
      spawn,
      close: () => true,
      prepareDesignSurface,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        checkoutPath: scope.rootRealPath,
        contract: {
          ...input.contract,
          requiredSensors: Object.freeze(['design-system']),
        },
        designInspection: 'deferred',
      }),
    ).resolves.toMatchObject({ ready: true });

    expect(prepareDesignSurface).not.toHaveBeenCalled();
    expect(
      (spawn.mock.calls[0]?.[0] as SpawnToolOptions).prompt,
    ).toContain('Rendered UI inspection is deferred');
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.not.arrayContaining([
          'nexus_browser_screenshot',
        ]),
      }),
      expect.any(Object),
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
    const retirePane = vi.fn(async () => true);
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close,
      retirePane,
      timeoutMs: 100,
      spawnAttempts: 3,
      maxIdleNudges: 0,
    });

    await expect(reviewer.run(input)).resolves.toMatchObject({ ready: true });
    expect(attempts).toBe(2);
    expect(close).toHaveBeenCalledWith('pane-1');
    expect(retirePane).toHaveBeenCalledTimes(2);
    expect(retirePane).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ paneId: 'pane-1' }),
    );
    expect(retirePane).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ paneId: 'pane-2' }),
    );
  });

  it('keeps a healthy reviewer alive while a sibling route retries', async () => {
    const { sessions, input } = fixture();
    const firstReady = deferred<void>();
    const events: string[] = [];
    let agyAttempts = 0;
    const spawn = vi.fn(
      async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        if (options.adapterId === 'claude') {
          const spawned = acceptSpawn(
            'pane-claude',
            'session-claude',
            hooks,
            options.prompt,
          );
          sessions.submit(
            match[1],
            {
              id: options.agentName!,
              sessionId: spawned.sessionId,
              provider: 'claude',
              missionId: 'mission-a',
              checkoutPath: '/candidate',
            },
            [],
          );
          events.push('spawn:claude');
          firstReady.resolve();
          return spawned;
        }

        agyAttempts += 1;
        await firstReady.promise;
        hooks.onPaneCreated?.(
          `pane-agy-${agyAttempts}`,
          `session-agy-${agyAttempts}`,
        );
        events.push(`spawn:agy-${agyAttempts}`);
        if (agyAttempts === 1) {
          throw new Error('transient agy spawn failure');
        }
        hooks.onPromptAccepted?.(
          `pane-agy-${agyAttempts}`,
          `session-agy-${agyAttempts}`,
          options.prompt ?? '',
        );
        sessions.submit(
          match[1],
          {
            id: options.agentName!,
            sessionId: `session-agy-${agyAttempts}`,
            provider: 'agy',
            missionId: 'mission-a',
            checkoutPath: '/candidate',
          },
          [],
        );
        return {
          paneId: `pane-agy-${agyAttempts}`,
          sessionId: `session-agy-${agyAttempts}`,
        };
      },
    );
    const close = vi.fn(async (paneId: string) => {
      events.push(`close:${paneId}`);
      return true;
    });
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [
        { adapterId: 'claude' },
        { adapterId: 'agy' },
      ],
      spawn,
      close,
      retirePane: () => true,
      timeoutMs: 100,
      spawnAttempts: 2,
      maxIdleNudges: 0,
    });

    await expect(
      reviewer.run({
        ...input,
        contract: {
          ...input.contract,
          risk: 'critical',
        },
      }),
    ).resolves.toMatchObject({ ready: true });

    expect(agyAttempts).toBe(2);
    expect(events.indexOf('close:pane-agy-1')).toBeLessThan(
      events.indexOf('spawn:agy-2'),
    );
    expect(events.filter((event) => event === 'close:pane-claude'))
      .toHaveLength(1);
    expect(events.indexOf('close:pane-claude')).toBeGreaterThan(
      events.indexOf('spawn:agy-2'),
    );
  });

  it('fails closed without removing a normal persisted pane identity', async () => {
    const { sessions, input } = fixture();
    const spawn = vi.fn(
      async (options: SpawnToolOptions, hooks: SpawnPaneHooks = {}) => {
        const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
        if (!match) throw new Error('review session missing from prompt');
        sessions.submit(match[1], {
          id: 'reviewer-claude-1',
          sessionId: 'session-review',
          provider: 'claude',
          missionId: 'mission-a',
          checkoutPath: '/candidate',
        }, []);
        return acceptSpawn(
          'pane-review',
          'session-review',
          hooks,
          options.prompt,
        );
      },
    );
    persistedPaneStore.findByPaneId.mockReturnValue({
      id: 'mpane-normal',
      missionId: 'mission-a',
      paneId: 'pane-review',
      agentName: 'executor-normal',
      role: 'worker',
      readOnly: false,
      executionScope: input.scope,
      allowedTools: ['nexus_handoff_submit'],
    });
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => true,
      timeoutMs: 100,
      maxIdleNudges: 0,
    });

    await expect(reviewer.run(input)).rejects.toThrow(
      /persisted reviewer pane.*not retired/i,
    );
    expect(persistedPaneStore.remove).not.toHaveBeenCalled();
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
