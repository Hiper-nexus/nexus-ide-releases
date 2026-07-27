import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  resolveCwdForScope: vi.fn<(_scope: unknown, value?: string) => string>(),
  requestPaneSpawn: vi.fn(async () => ({
    ok: true,
    paneId: 'pane-1',
    sessionId: 'session-1',
  })),
  requestPaneClose: vi.fn(async () => true),
  waitForIdle: vi.fn(async () => 'idle'),
  preSpawnProbe: vi.fn<
    (adapterId: string, options?: { model?: string }) => Promise<void>
  >(async () => undefined),
  writeSession: vi.fn(() => true),
  terminateSession: vi.fn(async () => true),
  sessionState: vi.fn(() => 'busy'),
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  missionPanesRecord: vi.fn(),
  missionGet: vi.fn((missionId: string) =>
    missionId === 'm1'
      ? {
          id: 'm1',
          squadId: 'squad-1',
        }
      : null,
  ),
  listSquads: vi.fn(() => [{ id: 'squad-1' }]),
  resolveMissionPaneAuthoritySeal: vi.fn(() => ({
    intentVersion: 1,
    intentContractHash: 'intent-contract-hash',
    contextRevision: 'context-revision',
    contractHash: 'contract-hash',
    squadRevisionHash: 'squad-revision-hash',
  })),
  injectable: true,
  ompRpcSpawn: vi.fn(),
  orchSettings: {
    leanCode: false,
    seniorMode: false,
    designPro: false,
    ompMissionTransport: 'pty',
    ompParticipation: 'off',
    ompAutoSpawn: false,
  },
}));

vi.mock('./workspace-path', () => ({ resolveCwdForScope: stubs.resolveCwdForScope }));
vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(),
  requestPaneClose: stubs.requestPaneClose,
  requestPaneSpawn: stubs.requestPaneSpawn,
  resolveCurrentMissionSpawnAuthoritySeal:
    stubs.resolveMissionPaneAuthoritySeal,
  waitForIdle: stubs.waitForIdle,
}));
vi.mock('./pane-authz', () => ({ authorizePaneAccess: vi.fn() }));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: stubs.writeSession,
  orchTerminateSession: stubs.terminateSession,
  getSessionState: stubs.sessionState,
  tapSessionState: vi.fn((tap: (sessionId: string, state: string) => void) => {
    stubs.stateTaps.push(tap);
    return () => {
      const index = stubs.stateTaps.indexOf(tap);
      if (index >= 0) stubs.stateTaps.splice(index, 1);
    };
  }),
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    stubs.dataTaps.push(tap);
    return () => {
      const index = stubs.dataTaps.indexOf(tap);
      if (index >= 0) stubs.dataTaps.splice(index, 1);
    };
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    stubs.exitTaps.push(tap);
    return () => {
      const index = stubs.exitTaps.indexOf(tap);
      if (index >= 0) stubs.exitTaps.splice(index, 1);
    };
  }),
}));
vi.mock('./agent-status', () => ({
  isSessionInjectableIdle: vi.fn(
    () => stubs.sessionState() === 'idle' && stubs.injectable,
  ),
}));
vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: vi.fn((id: string) =>
    id === 'codex'
      ? {
          id: 'codex',
          kind: 'cli-pty',
          bin: 'codex',
          spawn: { interactive: ['codex'], extraArgs: [] },
          models: { default: 'provider/model', list: ['provider/model'] },
          quirks: { nexusMcp: 'codex' },
          control: {
            permission: {
              arg: '--ask-for-approval',
              modes: {
                auto: 'never',
                default: 'on-request',
                untrusted: 'untrusted',
              },
              yolo: ['--dangerously-bypass-approvals-and-sandbox'],
              safe: [
                '--sandbox',
                'workspace-write',
                '--ask-for-approval',
                'on-request',
              ],
              default: '',
            },
          },
        }
      : {
          id,
          kind: 'cli-pty',
          bin: id,
          models: { default: 'provider/model', list: ['provider/model'] },
          quirks: {},
        },
  ),
  isBuiltinAdapter: vi.fn((id: string) => id === 'codex'),
  isAdapterInstalled: vi.fn(() => false),
}));
vi.mock('../adapters/omp-rpc-ipc', () => ({
  spawnMissionOmpRpcWorker: stubs.ompRpcSpawn,
  terminateOmpRpcSession: vi.fn(async () => true),
  isSafeOmpMissionPreflightFailure: (error: unknown) =>
    Boolean(
      error &&
        typeof error === 'object' &&
        (error as { sideEffectStarted?: unknown }).sideEffectStarted === false,
    ),
}));
// Keep the spawn path independent of the host's real credential state.
vi.mock('../pty/pre-spawn-probe', () => ({
  assertPreSpawnProbe: stubs.preSpawnProbe,
}));
vi.mock('./mission-pane-store', () => ({ recordMissionPane: vi.fn() }));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn(() => ({
    missions: { get: stubs.missionGet },
    missionPanes: { record: stubs.missionPanesRecord },
  })),
}));
vi.mock('./squad-store', () => ({ listSquads: stubs.listSquads }));
vi.mock('./mission-pane-authority', () => ({
  resolveMissionPaneAuthoritySeal: stubs.resolveMissionPaneAuthoritySeal,
  sameMissionPaneAuthoritySeal: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));
vi.mock('./legacy-handoff', () => ({ LEGACY_MARKER: 'marker' }));
vi.mock('./ponytail', () => ({ PONYTAIL_RULES: '' }));
vi.mock('./engineering-charter', () => ({ ENGINEERING_CHARTER: '' }));
vi.mock('./design-charter', () => ({ DESIGN_CHARTER: '' }));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: vi.fn(() => stubs.orchSettings),
}));

import {
  deliverAgentPrompt,
  injectPrompt,
  spawnPaneAndMaybePrompt,
  withHandoffContract,
} from './tool-util';
import { testProjectScope } from './__tests__/scope-fixture';

const scope = testProjectScope();
const taskExecutionScope = {
  ...scope,
  checkoutId: 'checkout-task-1',
  rootRealPath: '/workspace/.nexus/worktrees/task-1',
};

describe('agent pane workspace confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.stateTaps.length = 0;
    stubs.dataTaps.length = 0;
    stubs.exitTaps.length = 0;
    stubs.resolveCwdForScope.mockReturnValue('/workspace');
    stubs.preSpawnProbe.mockResolvedValue(undefined);
    stubs.waitForIdle.mockResolvedValue('idle');
    stubs.requestPaneClose.mockResolvedValue(true);
    stubs.terminateSession.mockResolvedValue(true);
  });

  it('pins every orchestration spawn to the canonical active workspace', async () => {
    await spawnPaneAndMaybePrompt({ adapterId: 'codex', scope });

    expect(stubs.resolveCwdForScope).toHaveBeenCalledWith(scope, undefined);
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith({
      adapterId: 'codex',
      cwd: '/workspace',
      executionScope: scope,
      scope,
    });
  });

  it('passes the resolved selected model into the credential probe', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'codex',
      model: 'provider/model',
      scope,
    });

    expect(stubs.preSpawnProbe).toHaveBeenCalledWith('codex', {
      model: 'provider/model',
      failClosed: true,
    });
  });

  it('binds main-owned mission workers to the durable pane seal revision', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'codex',
      missionId: 'm1',
      role: 'worker',
      scope,
      executionScope: taskExecutionScope,
    });

    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'm1',
        role: 'worker',
        contextRevision: 'context-revision',
        authoritySeal: {
          intentVersion: 1,
          intentContractHash: 'intent-contract-hash',
          contextRevision: 'context-revision',
          contractHash: 'contract-hash',
          squadRevisionHash: 'squad-revision-hash',
        },
      }),
    );
  });

  it('rejects revision-bound writable workers without a distinct execution worktree before probing', async () => {
    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        scope,
      }),
    ).rejects.toThrow(/physically distinct.*execution worktree/i);

    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        scope,
        executionScope: scope,
      }),
    ).rejects.toThrow(/physically distinct.*execution worktree/i);

    expect(stubs.preSpawnProbe).not.toHaveBeenCalled();
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });

  it('rejects revision-bound writable OMP at the release boundary before RPC, credential probe or PTY', async () => {
    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'omp',
        missionId: 'm1',
        role: 'worker',
        scope,
        executionScope: taskExecutionScope,
      }),
    ).rejects.toThrow(/governed_worker_spawn_unsupported/i);

    expect(stubs.ompRpcSpawn).not.toHaveBeenCalled();
    expect(stubs.preSpawnProbe).not.toHaveBeenCalled();
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });

  it.each(['claude', 'kimi', 'omp', 'grok'])(
    'rejects legacy %s mission workers even when read-only bypassed the old contextRevision gate',
    async (adapterId) => {
      await expect(
        spawnPaneAndMaybePrompt({
          adapterId,
          missionId: 'm1',
          role: 'worker',
          readOnly: true,
          scope,
          executionScope: scope,
        }),
      ).rejects.toThrow(/governed_worker_spawn_unsupported.*codex/i);
    },
  );

  it('treats an unlabelled mission pane as a worker instead of a role bypass', async () => {
    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'omp',
        missionId: 'm1',
        readOnly: true,
        scope,
      }),
    ).rejects.toThrow(/governed_worker_spawn_unsupported/i);

    expect(stubs.ompRpcSpawn).not.toHaveBeenCalled();
    expect(stubs.preSpawnProbe).not.toHaveBeenCalled();
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });

  it('preserves a non-mission manual Kimi Terminal pane', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'kimi',
      role: 'worker',
      scope,
    });

    expect(stubs.preSpawnProbe).toHaveBeenCalledWith('kimi', {
      model: undefined,
      failClosed: true,
    });
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: 'kimi' }),
    );
  });

  it('preserves an explicitly identified mission Maestro outside the worker boundary', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'claude',
      missionId: 'm1',
      role: 'orchestrator',
      scope,
    });

    expect(stubs.preSpawnProbe).toHaveBeenCalledWith('claude', {
      model: undefined,
      failClosed: true,
    });
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'claude',
        missionId: 'm1',
        role: 'orchestrator',
      }),
    );
  });

  it('rejects a stale caller contextRevision before any pane process exists', async () => {
    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        contextRevision: 'stale-context-revision',
        scope,
      }),
    ).rejects.toThrow(/contextRevision is stale/i);

    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });

  it('does not request a pane when no safe workspace can be resolved', async () => {
    stubs.resolveCwdForScope.mockImplementation(() => {
      throw new Error('no workspace open');
    });

    await expect(spawnPaneAndMaybePrompt({ adapterId: 'codex', scope })).rejects.toThrow(
      /no workspace open/,
    );
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });

  it('revalidates authority after deferred pre-spawn probe before creating a pane', async () => {
    let finishProbe: (() => void) | undefined;
    stubs.preSpawnProbe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const controller = new AbortController();
    let current = true;
    const pending = spawnPaneAndMaybePrompt(
      { adapterId: 'codex', scope },
      {
        invocation: {
          signal: controller.signal,
          assertCurrentAuthority: () => {
            if (!current) throw new Error('session_authority_revoked');
          },
        },
      },
    );
    await vi.waitFor(() => expect(stubs.preSpawnProbe).toHaveBeenCalledOnce());

    current = false;
    controller.abort('session_authority_revoked');
    finishProbe?.();

    await expect(pending).rejects.toThrow('session_authority_revoked');
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });

  it('revalidates after boot wait and closes the pane before a revoked prompt paste', async () => {
    let finishBoot: ((state: string) => void) | undefined;
    stubs.waitForIdle.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishBoot = resolve;
        }),
    );
    const controller = new AbortController();
    let current = true;
    const pending = spawnPaneAndMaybePrompt(
      {
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        prompt: 'do not paste after revoke',
        scope,
        executionScope: taskExecutionScope,
      },
      {
        invocation: {
          signal: controller.signal,
          assertCurrentAuthority: () => {
            if (!current) throw new Error('session_authority_revoked');
          },
        },
      },
    );
    await vi.waitFor(() => expect(stubs.waitForIdle).toHaveBeenCalledOnce());

    current = false;
    controller.abort('session_authority_revoked');
    finishBoot?.('idle');

    await expect(pending).rejects.toThrow('session_authority_revoked');
    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-1');
  });

  it('reports the pane before later mission persistence can fail', async () => {
    const onPaneCreated = vi.fn();
    stubs.missionPanesRecord.mockImplementationOnce(() => {
      expect(onPaneCreated).toHaveBeenCalledWith('pane-1', 'session-1');
      throw new Error('database unavailable');
    });

    await expect(
      spawnPaneAndMaybePrompt(
        { adapterId: 'codex', missionId: 'm1', scope },
        { onPaneCreated },
      ),
    ).rejects.toThrow('database unavailable');

    expect(onPaneCreated).toHaveBeenCalledWith('pane-1', 'session-1');
  });

  it('does not schedule an OMP auto-companion for a revision-bound writable worker', async () => {
    stubs.orchSettings.ompAutoSpawn = true;
    try {
      await spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        scope,
        executionScope: taskExecutionScope,
      });

      expect(stubs.requestPaneSpawn).toHaveBeenCalledOnce();
      expect(stubs.ompRpcSpawn).not.toHaveBeenCalled();
    } finally {
      stubs.orchSettings.ompAutoSpawn = false;
    }
  });
});

describe('worker handoff capability contract', () => {
  it('uses the MCP handoff for every declaratively wired adapter', () => {
    const prompt = withHandoffContract('task', {
      quirks: { nexusMcp: 'opencode' },
    });
    expect(prompt).toContain('nexus_handoff_submit');
    expect(prompt).not.toContain('marker');
  });

  it('keeps Aider operational as a legacy-handoff worker', () => {
    const prompt = withHandoffContract('task', {
      quirks: { nexusMcp: 'none' },
    });
    expect(prompt).toContain('marker');
    expect(prompt).not.toContain('nexus_handoff_submit');
  });
});

describe('omp rpc spawn transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.resolveCwdForScope.mockReturnValue('/workspace');
    stubs.orchSettings.ompMissionTransport = 'auto';
    stubs.ompRpcSpawn.mockReset();
  });
  afterEach(() => {
    stubs.orchSettings.ompMissionTransport = 'pty';
  });

  it('propagates the trusted worktree execution scope to rpc-ui', async () => {
    const executionScope = {
      ...scope,
      rootRealPath: '/workspace/task-worktree',
    };
    stubs.resolveCwdForScope.mockReturnValue(
      '/workspace/task-worktree/src',
    );
    stubs.ompRpcSpawn.mockResolvedValueOnce({
      paneId: 'omp-rpc:pane-1',
      sessionId: 'omp-session-1',
    });

    await spawnPaneAndMaybePrompt({
      adapterId: 'omp',
      role: 'worker',
      prompt: 'execute',
      scope,
      executionScope,
    });

    expect(stubs.ompRpcSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        executionScope,
      }),
    );
    expect(stubs.ompRpcSpawn.mock.calls[0]?.[0]).not.toHaveProperty(
      'workspaceRoot',
    );
  });

  it('exposes the exact wrapped prompt only after OMP proves acceptance', async () => {
    const onPaneCreated = vi.fn();
    const onPromptAccepted = vi.fn();
    stubs.ompRpcSpawn.mockImplementationOnce(
      async (input: {
        prompt?: string;
        onSessionReady?: (paneId: string, sessionId: string) => void;
        onAccepted?: (paneId: string, sessionId: string) => void;
      }) => {
        input.onSessionReady?.('omp-rpc:pane-accepted', 'omp-session-accepted');
        expect(onPromptAccepted).not.toHaveBeenCalled();
        input.onAccepted?.('omp-rpc:pane-accepted', 'omp-session-accepted');
        return {
          paneId: 'omp-rpc:pane-accepted',
          sessionId: 'omp-session-accepted',
        };
      },
    );

    await spawnPaneAndMaybePrompt(
      {
        adapterId: 'omp',
        role: 'worker',
        prompt: 'Use o resultado advisory confirmado.',
        scope,
      },
      { onPaneCreated, onPromptAccepted },
    );

    expect(onPaneCreated).toHaveBeenCalledWith(
      'omp-rpc:pane-accepted',
      'omp-session-accepted',
    );
    expect(onPromptAccepted).toHaveBeenCalledOnce();
    expect(onPromptAccepted).toHaveBeenCalledWith(
      'omp-rpc:pane-accepted',
      'omp-session-accepted',
      expect.stringContaining('Use o resultado advisory confirmado.'),
    );
    expect(onPromptAccepted.mock.calls[0]?.[2]).toContain('marker');
  });

  it('fails closed before any OMP spawn when read-only is required', async () => {
    for (const transport of ['auto', 'pty'] as const) {
      stubs.orchSettings.ompMissionTransport = transport;
      await expect(
        spawnPaneAndMaybePrompt({
          adapterId: 'omp',
          missionId: 'm1',
          role: 'worker',
          prompt: 'review only',
          readOnly: true,
          scope,
        }),
      ).rejects.toThrow(/governed_worker_spawn_unsupported/i);
    }

    expect(stubs.ompRpcSpawn).not.toHaveBeenCalled();
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
    expect(stubs.missionPanesRecord).not.toHaveBeenCalled();
  });

  it('não persiste pane nem abre fallback PTY após uma morte pós-spawn ambígua', async () => {
    const onPaneCreated = vi.fn();
    const ambiguousFailure = Object.assign(
      new Error('omp encerrou durante o aceite'),
      { sideEffectStarted: true },
    );
    stubs.ompRpcSpawn.mockImplementationOnce(
      async (input: {
        onSessionReady?: (paneId: string, sessionId: string) => void;
      }) => {
        // O bind da dispatch já ocorreu; só o onAccepted poderia persistir a
        // composição. A falha depois desse ponto jamais pode abrir outro PTY.
        input.onSessionReady?.('omp-rpc:pane-1', 'omp-session-1');
        throw ambiguousFailure;
      },
    );

    await expect(
      spawnPaneAndMaybePrompt(
        {
          adapterId: 'omp',
          role: 'worker',
          prompt: 'execute',
          scope,
        },
        { onPaneCreated },
      ),
    ).rejects.toBe(ambiguousFailure);

    expect(onPaneCreated).toHaveBeenCalledWith(
      'omp-rpc:pane-1',
      'omp-session-1',
    );
    expect(stubs.ompRpcSpawn).toHaveBeenCalledOnce();
    expect(stubs.missionPanesRecord).not.toHaveBeenCalled();
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });
});

describe('agent prompt injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.writeSession.mockReturnValue(true);
    stubs.sessionState.mockReturnValue('busy');
    stubs.injectable = true;
  });

  it('submits multiline briefs as one bracketed-paste transaction', async () => {
    vi.useFakeTimers();
    try {
      // First CR leaves the session idle → second CR retries (boot-menu recovery).
      stubs.sessionState.mockReturnValue('idle');
      const pending = injectPrompt('session-1', 'line one\nline two');
      await vi.advanceTimersByTimeAsync(499);
      expect(stubs.writeSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        { markInputBusy: false },
      );
      await vi.advanceTimersByTimeAsync(400);
      await pending;

      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        1,
        'session-1',
        '\x1b[200~line one\nline two\x1b[201~',
        { markInputBusy: false },
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        { markInputBusy: false },
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        3,
        'session-1',
        '\r',
        { markInputBusy: false },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a pane if authority is revoked after paste but before the first Enter', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      const controller = new AbortController();
      let current = true;
      const pending = injectPrompt('session-1', 'staged prompt', {
        signal: controller.signal,
        assertCurrentAuthority: () => {
          if (!current) throw new Error('session_authority_revoked');
        },
      });
      const rejected = expect(pending).rejects.toThrow(
        'session_authority_revoked',
      );
      expect(stubs.writeSession).toHaveBeenCalledOnce();

      current = false;
      controller.abort('session_authority_revoked');
      await vi.advanceTimersByTimeAsync(500);

      await rejected;
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1');
      expect(stubs.writeSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revalidates before the bounded retry Enter and terminates on revocation', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      const controller = new AbortController();
      let current = true;
      const pending = injectPrompt('session-1', 'retry prompt', {
        signal: controller.signal,
        assertCurrentAuthority: () => {
          if (!current) throw new Error('session_authority_revoked');
        },
      });
      const rejected = expect(pending).rejects.toThrow(
        'session_authority_revoked',
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        { markInputBusy: false },
      );

      current = false;
      controller.abort('session_authority_revoked');
      await vi.advanceTimersByTimeAsync(400);

      await rejected;
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1');
      expect(stubs.writeSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips retry Enter once the session turns busy', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('busy');
      const pending = injectPrompt('session-1', 'go');
      await vi.advanceTimersByTimeAsync(900);
      await pending;
      expect(stubs.writeSession).toHaveBeenCalledTimes(2); // paste + one CR
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate a prompt when a fast busy→idle turn finishes during submit', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      const pending = deliverAgentPrompt('session-1', 'quick task');
      await vi.advanceTimersByTimeAsync(500);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        { markInputBusy: false },
      );

      for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
      for (const tap of [...stubs.dataTaps]) tap('session-1', 'accepted output');
      stubs.sessionState.mockReturnValue('idle');
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'idle');
      await vi.advanceTimersByTimeAsync(400);
      await expect(pending).resolves.toBe(true);

      expect(stubs.writeSession).toHaveBeenCalledTimes(2); // prompt + one CR
      expect(stubs.stateTaps).toHaveLength(0);
      expect(stubs.dataTaps).toHaveLength(0);
      expect(stubs.exitTaps).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never pastes a worker brief into a session that was already busy', async () => {
    stubs.sessionState.mockReturnValue('busy');

    await expect(deliverAgentPrompt('session-1', 'do not interleave')).rejects.toThrow(
      /did not start/i,
    );

    expect(stubs.writeSession).not.toHaveBeenCalled();
  });

  it('never pastes a worker brief into an idle-looking permission prompt', async () => {
    stubs.sessionState.mockReturnValue('idle');
    stubs.injectable = false;

    await expect(deliverAgentPrompt('session-1', 'do not confirm')).rejects.toThrow(
      /did not start/i,
    );

    expect(stubs.writeSession).not.toHaveBeenCalled();
  });
});
