import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  resolveCwdForScope: vi.fn<(_scope: unknown, value?: string) => string>(),
  requestPaneSpawn: vi.fn(async () => ({
    ok: true,
    paneId: 'pane-1',
    sessionId: 'session-1',
  })),
  requestPaneClose: vi.fn(async () => true),
  waitForIdle: vi.fn<
    (
      sessionId: string,
      timeoutMs?: number,
      signal?: AbortSignal,
    ) => Promise<string>
  >(async () => 'idle'),
  readSessionOutput: vi.fn(() => ''),
  preSpawnProbe: vi.fn<
    (adapterId: string, options?: { model?: string }) => Promise<void>
  >(async () => undefined),
  writeSession: vi.fn(() => true),
  terminateSession: vi.fn(async () => true),
  sessionState: vi.fn(() => 'busy'),
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  turnStartSequence: 0,
  turnStartTaps: [] as Array<
    (entry: { sessionId: string; sequence: number }) => void
  >,
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
  orchSettings: {
    leanCode: false,
    seniorMode: false,
    designPro: false,
    squadCliPolicy: 'operator-choice',
  },
}));

vi.mock('./workspace-path', () => ({ resolveCwdForScope: stubs.resolveCwdForScope }));
vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(),
  requestPaneClose: stubs.requestPaneClose,
  requestPaneSpawn: stubs.requestPaneSpawn,
  readSessionOutput: stubs.readSessionOutput,
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
  getAgentTurnStartSequence: vi.fn(() => stubs.turnStartSequence),
  tapAgentTurnStart: vi.fn(
    (tap: (entry: { sessionId: string; sequence: number }) => void) => {
      stubs.turnStartTaps.push(tap);
      return () => {
        const index = stubs.turnStartTaps.indexOf(tap);
        if (index >= 0) stubs.turnStartTaps.splice(index, 1);
      };
    },
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
  submitPendingAgentPrompt,
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
    stubs.turnStartSequence = 0;
    stubs.turnStartTaps.length = 0;
    stubs.resolveCwdForScope.mockReturnValue('/workspace');
    stubs.preSpawnProbe.mockResolvedValue(undefined);
    stubs.waitForIdle.mockResolvedValue('idle');
    stubs.readSessionOutput.mockReturnValue('');
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
      failClosed: false,
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

  it('never records an ephemeral internal reviewer in mission composition', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'codex',
      missionId: 'm1',
      role: 'worker',
      readOnly: true,
      transient: true,
      scope,
      executionScope: taskExecutionScope,
    });

    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ transient: true }),
    );
    expect(stubs.missionPanesRecord).not.toHaveBeenCalled();
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

  it.each(['claude', 'kimi', 'grok'])(
    'allows authenticated %s reviewers in an autopilot task worktree',
    async (adapterId) => {
      await spawnPaneAndMaybePrompt({
        adapterId,
        missionId: 'm1',
        role: 'worker',
        readOnly: true,
        scope,
        executionScope: taskExecutionScope,
      });

      expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterId,
          executionScope: taskExecutionScope,
          readOnly: true,
        }),
      );
    },
  );

  it('keeps an unlabelled autopilot mission participant inside its task worktree', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'kimi',
      missionId: 'm1',
      readOnly: true,
      scope,
      executionScope: taskExecutionScope,
    });

    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'kimi',
        executionScope: taskExecutionScope,
      }),
    );
  });

  it('preserves a non-mission manual Kimi Terminal pane', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'kimi',
      role: 'worker',
      scope,
    });

    expect(stubs.preSpawnProbe).toHaveBeenCalledWith('kimi', {
      model: undefined,
      failClosed: false,
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
      failClosed: false,
    });
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'claude',
        missionId: 'm1',
        role: 'orchestrator',
      }),
    );
  });

  it('keeps probe infrastructure fail-closed only in explicit hardened mode', async () => {
    stubs.orchSettings.squadCliPolicy = 'governed';

    try {
      await spawnPaneAndMaybePrompt({
        adapterId: 'claude',
        missionId: 'm1',
        role: 'orchestrator',
        scope,
      });
    } finally {
      stubs.orchSettings.squadCliPolicy = 'operator-choice';
    }

    expect(stubs.preSpawnProbe).toHaveBeenCalledWith('claude', {
      model: undefined,
      failClosed: true,
    });
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
    const reason = new Error('participant mission-scheduler exceeded 30000ms');
    stubs.waitForIdle.mockImplementationOnce(
      (
        _sessionId: string,
        _timeoutMs?: number,
        signal?: AbortSignal,
      ) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
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
          assertCurrentAuthority: vi.fn(),
        },
      },
    );
    await vi.waitFor(() => expect(stubs.waitForIdle).toHaveBeenCalledOnce());

    expect(stubs.waitForIdle).toHaveBeenCalledWith(
      'session-1',
      expect.any(Number),
      controller.signal,
    );
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-1');
  });

  it('preserves the physical PTY exit cause before the blocked dispatch fence', async () => {
    let current = true;
    stubs.waitForIdle.mockImplementationOnce(async () => {
      current = false;
      return 'exited';
    });
    stubs.readSessionOutput.mockReturnValueOnce(
      'Error: model glm-5.2 is unavailable for this account',
    );
    const assertCurrentAuthority = vi.fn(() => {
      if (!current) {
        throw new Error('dispatch sem autoridade de efeito no estado blocked');
      }
    });

    await expect(
      spawnPaneAndMaybePrompt(
        {
          adapterId: 'codex',
          missionId: 'm1',
          role: 'worker',
          prompt: 'never pasted',
          scope,
          executionScope: taskExecutionScope,
        },
        {
          invocation: { assertCurrentAuthority },
        },
      ),
    ).rejects.toThrow(
      /agent session exited during boot.*model glm-5\.2 is unavailable/is,
    );

    expect(assertCurrentAuthority).toHaveBeenCalled();
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

  it('does not append handoff_submit to merge-council reviewer briefs', async () => {
    stubs.sessionState.mockReturnValue('idle');
    const writes: string[] = [];
    stubs.writeSession.mockImplementation(
      ((sessionId: string, data: string) => {
        writes.push(String(data));
        if (data === '\r') {
          queueMicrotask(() => {
            stubs.sessionState.mockReturnValue('busy');
            for (const tap of stubs.stateTaps) tap(sessionId, 'busy');
            for (const tap of stubs.dataTaps) tap(sessionId, 'ok');
          });
        }
        return true;
      }) as typeof stubs.writeSession,
    );

    await spawnPaneAndMaybePrompt({
      adapterId: 'codex',
      missionId: 'm1',
      role: 'worker',
      readOnly: true,
      prompt: 'Call nexus_merge_review_submit when done.',
      allowedTools: [
        'nexus_git_diff',
        'nexus_merge_review_submit',
      ],
      scope,
      executionScope: taskExecutionScope,
    });

    const pasted = writes.join('\n');
    expect(pasted).toContain('nexus_merge_review_submit');
    expect(pasted).not.toContain('nexus_handoff_submit');
  });
});

describe('agent prompt injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.writeSession.mockReturnValue(true);
    stubs.sessionState.mockReturnValue('busy');
    stubs.injectable = true;
    stubs.turnStartSequence = 0;
    stubs.turnStartTaps.length = 0;
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

  it('resubmits the prompt already restored in an idle agent editor', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'restored turn accepted');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = submitPendingAgentPrompt(
        'session-1',
        { assertCurrentAuthority: vi.fn() },
        { adapterId: 'kimi' },
      );
      await vi.advanceTimersByTimeAsync(900);

      await expect(pending).resolves.toBe(true);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        1,
        'session-1',
        '',
        { markInputBusy: false },
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        { markInputBusy: false },
      );
      expect(stubs.writeSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a resumed turn when authority is lost after Enter acceptance', async () => {
    vi.useFakeTimers();
    try {
      let isCurrent = true;
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              isCurrent = false;
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'turn accepted after handoff race');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = submitPendingAgentPrompt(
        'session-1',
        {
          assertCurrentAuthority: () => {
            if (!isCurrent) throw new Error('handoff won the race');
          },
        },
        { adapterId: 'kimi' },
      );
      const rejected = expect(pending).rejects.toThrow(/handoff won the race/i);
      await vi.advanceTimersByTimeAsync(900);

      await rejected;
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not press Enter when recovery authority changes at submit time', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');

      const pending = submitPendingAgentPrompt(
        'session-1',
        { assertCurrentAuthority: vi.fn() },
        { adapterId: 'kimi', canSubmit: () => false },
      );
      await vi.advanceTimersByTimeAsync(900);

      await expect(pending).resolves.toBe(false);
      expect(stubs.writeSession).toHaveBeenCalledOnce();
      expect(stubs.writeSession).toHaveBeenCalledWith(
        'session-1',
        '',
        { markInputBusy: false },
      );
      expect(stubs.writeSession).not.toHaveBeenCalledWith(
        'session-1',
        '\r',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks recovery authority before a retry Enter', async () => {
    vi.useFakeTimers();
    try {
      let checks = 0;
      stubs.sessionState.mockReturnValue('idle');

      const pending = submitPendingAgentPrompt(
        'session-1',
        { assertCurrentAuthority: vi.fn() },
        {
          adapterId: 'kimi',
          canSubmit: () => {
            checks += 1;
            return checks === 1;
          },
        },
      );
      await vi.advanceTimersByTimeAsync(4_100);

      await expect(pending).resolves.toBe(false);
      const enterWrites = (
        stubs.writeSession.mock.calls as unknown as Array<
          readonly [sessionId: string, data: string]
        >
      ).filter(([, data]) => data === '\r');
      expect(checks).toBe(2);
      expect(enterWrites).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences a resumed turn when authority is lost without acceptance proof', async () => {
    vi.useFakeTimers();
    try {
      let isCurrent = true;
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(
        ((_sessionId: string, data: string) => {
          if (data === '\r') isCurrent = false;
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = submitPendingAgentPrompt(
        'session-1',
        {
          assertCurrentAuthority: () => {
            if (!isCurrent) throw new Error('recovery authority expired');
          },
        },
        { adapterId: 'kimi' },
      );
      const rejected = expect(pending).rejects.toThrow(
        /recovery authority expired/i,
      );
      await vi.advanceTimersByTimeAsync(4_100);

      await rejected;
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat Claude paste echo plus a false busy edge as prompt acceptance', async () => {
    vi.useFakeTimers();
    const previous = process.env.NEXUS_REAL_MISSION_E2E;
    process.env.NEXUS_REAL_MISSION_E2E = '1';
    try {
      stubs.sessionState.mockReturnValue('idle');
      const pending = deliverAgentPrompt(
        'session-1',
        'review this task',
        undefined,
        { adapterId: 'claude' },
      );
      const rejected = expect(pending).rejects.toThrow(/did not start/i);

      await vi.advanceTimersByTimeAsync(0);
      expect(stubs.writeSession).toHaveBeenCalledTimes(1);
      for (const tap of [...stubs.dataTaps]) {
        tap('session-1', 'local paste repaint only');
      }
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
      stubs.sessionState.mockReturnValue('busy');

      await vi.advanceTimersByTimeAsync(13_000);
      await rejected;
      expect(stubs.requestPaneClose).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.NEXUS_REAL_MISSION_E2E;
      } else {
        process.env.NEXUS_REAL_MISSION_E2E = previous;
      }
      vi.useRealTimers();
    }
  });

  it('requires Claude UserPromptSubmit even when plugin bootstrap emits busy and output after Enter', async () => {
    vi.useFakeTimers();
    const previous = process.env.NEXUS_REAL_MISSION_E2E;
    process.env.NEXUS_REAL_MISSION_E2E = '1';
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'updating plugin marketplace');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );
      const pending = deliverAgentPrompt(
        'session-1',
        'review this task',
        undefined,
        { adapterId: 'claude' },
      );
      const rejected = expect(pending).rejects.toThrow(/did not start/i);

      await vi.advanceTimersByTimeAsync(13_000);
      await rejected;
      expect(stubs.turnStartSequence).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.NEXUS_REAL_MISSION_E2E;
      } else {
        process.env.NEXUS_REAL_MISSION_E2E = previous;
      }
      vi.useRealTimers();
    }
  });

  it('accepts Claude only after the exact session emits UserPromptSubmit', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.turnStartSequence += 1;
              for (const tap of [...stubs.turnStartTaps]) {
                tap({ sessionId, sequence: stubs.turnStartSequence });
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );
      const pending = deliverAgentPrompt(
        'session-1',
        'review this task',
        undefined,
        { adapterId: 'claude' },
      );

      await vi.advanceTimersByTimeAsync(900);

      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the release-only Codex silent busy proof bounded to Codex', async () => {
    vi.useFakeTimers();
    const previous = process.env.NEXUS_REAL_MISSION_E2E;
    process.env.NEXUS_REAL_MISSION_E2E = '1';
    try {
      stubs.sessionState.mockReturnValue('idle');
      const pending = deliverAgentPrompt(
        'session-1',
        'run the task',
        undefined,
        { adapterId: 'codex' },
      );

      await vi.advanceTimersByTimeAsync(500);
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
      stubs.sessionState.mockReturnValue('busy');
      await vi.advanceTimersByTimeAsync(400);

      await expect(pending).resolves.toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.NEXUS_REAL_MISSION_E2E;
      } else {
        process.env.NEXUS_REAL_MISSION_E2E = previous;
      }
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
