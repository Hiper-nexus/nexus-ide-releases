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
  taskDispatchesList: vi.fn((): Array<unknown> => []),
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
    agentAttestationGate: 'off' as 'off' | 'required',
  },
  issueAgentIdentityBestEffort: vi.fn(),
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
  isSessionStdinWritable: vi.fn(() => true),
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
      : id === 'agy'
        ? {
            id: 'agy',
            kind: 'cli-pty',
            label: 'Antigravity (agy)',
            bin: 'agy',
            spawn: {
              interactive: ['agy'],
              extraArgs: [],
              initialPrompt: 'oneshot',
              initialPromptArgs: ['--print'],
            },
            models: { default: 'provider/model', list: ['provider/model'] },
            quirks: {},
          }
        : id === 'opencode'
          ? {
              id: 'opencode',
              kind: 'cli-pty',
              label: 'OpenCode',
              bin: 'opencode',
              spawn: {
                interactive: ['opencode'],
                extraArgs: [],
                initialPrompt: 'oneshot',
                initialPromptArgs: ['run'],
              },
              models: { default: 'provider/model', list: ['provider/model'] },
              quirks: { nexusMcp: 'opencode' },
            }
          : {
              id,
              kind: 'cli-pty',
              bin: id,
              spawn: { interactive: [id], extraArgs: [] },
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
    taskDispatches: { list: stubs.taskDispatchesList },
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
vi.mock('./agent-identity-spawn', () => ({
  issueAgentIdentityBestEffort: stubs.issueAgentIdentityBestEffort,
}));
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
    stubs.taskDispatchesList.mockReturnValue([]);
    stubs.orchSettings.agentAttestationGate = 'off';
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
      silentRemint: true,
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

  it('best-effort issues identity before a renderer-backed mission spawn', async () => {
    stubs.orchSettings.agentAttestationGate = 'required';

    await spawnPaneAndMaybePrompt({
      adapterId: 'codex',
      missionId: 'm1',
      role: 'worker',
      agentName: 'Worker A',
      scope,
      executionScope: taskExecutionScope,
    });

    expect(stubs.issueAgentIdentityBestEffort).toHaveBeenCalledWith({
      missionId: 'm1',
      scope,
      agentId: 'Worker A',
    });
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

  it('rejects isolated_worktree writers without a distinct execution worktree before probing', async () => {
    // Caminho simples (default): same root é permitido — paridade Overclock.
    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        executionMode: 'same_checkout',
        scope,
        executionScope: scope,
      }),
    ).resolves.toBeDefined();

    stubs.requestPaneSpawn.mockClear();
    stubs.preSpawnProbe.mockClear();

    // Fan-out isolado: same root é recusa fail-closed.
    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        executionMode: 'isolated_worktree',
        scope,
      }),
    ).rejects.toThrow(/physically distinct.*execution worktree/i);

    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        executionMode: 'isolated_worktree',
        scope,
        executionScope: scope,
      }),
    ).rejects.toThrow(/physically distinct.*execution worktree/i);

    expect(stubs.preSpawnProbe).not.toHaveBeenCalled();
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
      silentRemint: true,
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
      silentRemint: true,
    });
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'claude',
        missionId: 'm1',
        role: 'orchestrator',
      }),
    );
  });

  it('starts an AGY worker with the final brief in main-owned argv instead of typing into its booting TUI', async () => {
    const onPromptAccepted = vi.fn();
    // Provider already streaming the turn when boot settles: physical proof,
    // no extra input.
    stubs.sessionState.mockReturnValue('busy');

    await spawnPaneAndMaybePrompt(
      {
        adapterId: 'agy',
        missionId: 'm1',
        role: 'worker',
        readOnly: true,
        prompt: 'Mapeie os panes e entregue o parecer.',
        scope,
        executionScope: taskExecutionScope,
      },
      { onPromptAccepted },
    );

    const spawnCalls = stubs.requestPaneSpawn.mock.calls as unknown as Array<
      [{ initialPrompt?: string }]
    >;
    const spawnOptions = spawnCalls.at(-1)?.[0];
    expect(spawnOptions).toEqual(
      expect.objectContaining({
        adapterId: 'agy',
        initialPrompt: expect.stringContaining(
          'Mapeie os panes e entregue o parecer.',
        ),
      }),
    );
    expect(spawnOptions?.initialPrompt).toContain('marker');
    expect(stubs.waitForIdle).toHaveBeenCalledWith(
      'session-1',
      120_000,
      undefined,
    );
    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(onPromptAccepted).toHaveBeenCalledOnce();
    expect(onPromptAccepted).toHaveBeenCalledWith(
      'pane-1',
      'session-1',
      spawnOptions?.initialPrompt,
    );
  });

  it('starts a Codex mission worker with its sealed brief in native argv', async () => {
    const onPromptAccepted = vi.fn();
    stubs.sessionState.mockReturnValue('busy');

    await spawnPaneAndMaybePrompt(
      {
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        prompt: 'Implemente a interface da página e entregue o handoff.',
        scope,
        executionScope: taskExecutionScope,
      },
      { onPromptAccepted },
    );

    const spawnCalls = stubs.requestPaneSpawn.mock.calls as unknown as Array<
      [{ initialPrompt?: string }]
    >;
    const spawnOptions = spawnCalls.at(-1)?.[0];
    expect(spawnOptions).toEqual(
      expect.objectContaining({
        adapterId: 'codex',
        initialPrompt: expect.stringContaining(
          'Implemente a interface da página e entregue o handoff.',
        ),
      }),
    );
    expect(spawnOptions?.initialPrompt).toContain('nexus_handoff_submit');
    expect(spawnOptions?.initialPrompt).toContain('Regra de design do projeto');
    expect(spawnOptions?.initialPrompt).toContain('AGENTS.md');
    expect(stubs.orchSettings.designPro).toBe(false);
    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(onPromptAccepted).toHaveBeenCalledWith(
      'pane-1',
      'session-1',
      spawnOptions?.initialPrompt,
    );
  });

  it('starts an OpenCode mission worker with its final brief in main-owned argv', async () => {
    const onPromptAccepted = vi.fn();
    stubs.sessionState.mockReturnValue('busy');

    await spawnPaneAndMaybePrompt(
      {
        adapterId: 'opencode',
        missionId: 'm1',
        role: 'worker',
        readOnly: true,
        prompt: 'Revise o projeto e entregue o parecer.',
        scope,
        executionScope: taskExecutionScope,
      },
      { onPromptAccepted },
    );

    const spawnCalls = stubs.requestPaneSpawn.mock.calls as unknown as Array<
      [{ initialPrompt?: string }]
    >;
    const spawnOptions = spawnCalls.at(-1)?.[0];
    expect(spawnOptions).toEqual(
      expect.objectContaining({
        adapterId: 'opencode',
        initialPrompt: expect.stringContaining(
          'Revise o projeto e entregue o parecer.',
        ),
      }),
    );
    expect(spawnOptions?.initialPrompt).toContain('nexus_handoff_submit');
    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(onPromptAccepted).toHaveBeenCalledWith(
      'pane-1',
      'session-1',
      spawnOptions?.initialPrompt,
    );
  });

  it('accepts the AGY argv brief when the turn opens after boot settles', async () => {
    const onPromptAccepted = vi.fn();
    stubs.sessionState.mockReturnValue('idle');

    const pending = spawnPaneAndMaybePrompt(
      {
        adapterId: 'agy',
        missionId: 'm1',
        role: 'worker',
        readOnly: true,
        prompt: 'Mapeie os panes e entregue o parecer.',
        scope,
        executionScope: taskExecutionScope,
      },
      { onPromptAccepted },
    );
    await vi.waitFor(() =>
      expect(stubs.stateTaps.length).toBeGreaterThan(0),
    );
    // Busy edge alone is not enough (a lone repaint also edges): the turn is
    // confirmed by the output stream that follows it.
    for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
    for (const tap of [...stubs.dataTaps]) tap('session-1', 'spinner frame');
    for (const tap of [...stubs.dataTaps]) tap('session-1', 'more output');
    await pending;

    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(onPromptAccepted).toHaveBeenCalledOnce();
  });

  it('presses a single Enter when the AGY argv brief sits quiet past the activity window', async () => {
    vi.useFakeTimers();
    try {
      const onPromptAccepted = vi.fn();
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'turn accepted after composer submit');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = spawnPaneAndMaybePrompt(
        {
          adapterId: 'agy',
          missionId: 'm1',
          role: 'worker',
          readOnly: true,
          prompt: 'Mapeie os panes e entregue o parecer.',
          scope,
          executionScope: taskExecutionScope,
        },
        { onPromptAccepted },
      );
      // 30s quiet window, then the Enter rescue proves acceptance.
      await vi.advanceTimersByTimeAsync(45_000);
      await pending;

      const written = (
        stubs.writeSession.mock.calls as unknown as Array<
          readonly [string, string]
        >
      ).map(([, data]) => data);
      expect(written).toEqual(['', '\r']);
      expect(onPromptAccepted).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the legacy typed brief when the Enter rescue gets no response', async () => {
    vi.useFakeTimers();
    try {
      const onPromptAccepted = vi.fn();
      stubs.sessionState.mockReturnValue('idle');
      let briefPasted = false;
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          // The argv brief never starts; only the typed legacy delivery opens
          // a turn — and acceptance output must follow the submit Enter.
          if (data.includes('Mapeie os panes')) briefPasted = true;
          if (data === '\r' && briefPasted) {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'typed brief accepted');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = spawnPaneAndMaybePrompt(
        {
          adapterId: 'agy',
          missionId: 'm1',
          role: 'worker',
          readOnly: true,
          prompt: 'Mapeie os panes e entregue o parecer.',
          scope,
          executionScope: taskExecutionScope,
        },
        { onPromptAccepted },
      );
      // 30s window + Enter proof window (12s) + typed delivery proof.
      await vi.advanceTimersByTimeAsync(90_000);
      await pending;

      const written = (
        stubs.writeSession.mock.calls as unknown as Array<
          readonly [string, string]
        >
      ).map(([, data]) => data);
      // Enter rescue first, then the legacy bracketed-paste brief.
      expect(written[0]).toBe('');
      expect(written.some((data) => data.includes('Mapeie os panes'))).toBe(
        true,
      );
      expect(onPromptAccepted).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the AGY pane when neither the Enter rescue nor the typed fallback start a turn', async () => {
    vi.useFakeTimers();
    try {
      const onPromptAccepted = vi.fn();
      stubs.sessionState.mockReturnValue('idle');
      // writeSession never produces activity: the brief is swallowed twice.
      stubs.writeSession.mockImplementation(
        (() => true) as typeof stubs.writeSession,
      );

      const pending = spawnPaneAndMaybePrompt(
        {
          adapterId: 'agy',
          missionId: 'm1',
          role: 'worker',
          readOnly: true,
          prompt: 'Mapeie os panes e entregue o parecer.',
          scope,
          executionScope: taskExecutionScope,
        },
        { onPromptAccepted },
      );
      const rejected = expect(pending).rejects.toThrow(/did not start/i);
      await vi.advanceTimersByTimeAsync(120_000);

      await rejected;
      expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-1');
      expect(onPromptAccepted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the AGY argv brief when the worker self-exits after delivering its handoff', async () => {
    const onPromptAccepted = vi.fn();
    // AGY exits by itself right after printing the handoff block: the boot
    // wait observes the physical exit, but the handoff is already durably
    // bound to this exact worker incarnation — a stronger acceptance proof.
    stubs.waitForIdle.mockResolvedValue('exited');
    stubs.taskDispatchesList.mockReturnValue([
      {
        missionId: 'm1',
        sessionId: 'session-1',
        workerIncarnationId: 'inc-1',
        handoffId: 'handoff-1',
      },
    ]);

    await spawnPaneAndMaybePrompt(
      {
        adapterId: 'agy',
        missionId: 'm1',
        role: 'worker',
        readOnly: true,
        prompt: 'Mapeie os panes e entregue o parecer.',
        workerIncarnationId: 'inc-1',
        scope,
        executionScope: taskExecutionScope,
      },
      { onPromptAccepted },
    );

    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(stubs.requestPaneClose).not.toHaveBeenCalled();
    expect(onPromptAccepted).toHaveBeenCalledOnce();
  });

  it('accepts a fast Codex handoff before the running-dispatch authority fence', async () => {
    const onPromptAccepted = vi.fn();
    let running = true;
    stubs.waitForIdle.mockImplementationOnce(async () => {
      running = false;
      return 'idle';
    });
    stubs.taskDispatchesList.mockReturnValue([
      {
        missionId: 'm1',
        sessionId: 'session-1',
        workerIncarnationId: 'inc-fast',
        handoffId: 'handoff-fast',
      },
    ]);

    await expect(
      spawnPaneAndMaybePrompt(
        {
          adapterId: 'codex',
          missionId: 'm1',
          role: 'worker',
          prompt: 'Conclua e entregue imediatamente.',
          workerIncarnationId: 'inc-fast',
          scope,
          executionScope: taskExecutionScope,
        },
        {
          invocation: {
            assertCurrentAuthority: () => {
              if (!running) {
                throw new Error(
                  'dispatch sem autoridade de efeito no estado handoff_ready',
                );
              }
            },
          },
          onPromptAccepted,
        },
      ),
    ).resolves.toEqual({ paneId: 'pane-1', sessionId: 'session-1' });

    expect(stubs.requestPaneClose).not.toHaveBeenCalled();
    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(onPromptAccepted).toHaveBeenCalledOnce();
  });

  it('closes the AGY pane when the session exits during boot without a handoff', async () => {
    const onPromptAccepted = vi.fn();
    stubs.waitForIdle.mockResolvedValue('exited');
    // No handoff bound anywhere: the exit is a plain boot failure.
    stubs.taskDispatchesList.mockReturnValue([
      {
        missionId: 'm1',
        sessionId: 'session-1',
        workerIncarnationId: 'inc-1',
      },
      {
        missionId: 'm1',
        sessionId: 'session-1',
        workerIncarnationId: 'inc-OTHER',
        handoffId: 'handoff-other-incarnation',
      },
      {
        missionId: 'm1',
        sessionId: 'session-OTHER',
        workerIncarnationId: 'inc-1',
        handoffId: 'handoff-other-session',
      },
    ]);

    await expect(
      spawnPaneAndMaybePrompt(
        {
          adapterId: 'agy',
          missionId: 'm1',
          role: 'worker',
          readOnly: true,
          prompt: 'Mapeie os panes e entregue o parecer.',
          workerIncarnationId: 'inc-1',
          scope,
          executionScope: taskExecutionScope,
        },
        { onPromptAccepted },
      ),
    ).rejects.toThrow(/exited during boot/i);

    expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-1');
    expect(onPromptAccepted).not.toHaveBeenCalled();
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
      silentRemint: true,
    });
  });

  it('rejects a stale caller contextRevision before any pane process exists in Hardened', async () => {
    stubs.orchSettings.squadCliPolicy = 'governed';
    try {
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
    } finally {
      stubs.orchSettings.squadCliPolicy = 'operator-choice';
    }
  });

  it('Autopilot soft-accepts a drifted contextRevision and keeps spawning', async () => {
    await spawnPaneAndMaybePrompt({
      adapterId: 'codex',
      missionId: 'm1',
      role: 'worker',
      contextRevision: 'stale-context-revision',
      scope,
      executionScope: taskExecutionScope,
    });

    expect(stubs.requestPaneSpawn).toHaveBeenCalled();
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
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[spawn\] agent boot failed \(session-1\):.*model glm-5\.2 is unavailable/is,
      ),
    );
    errorLog.mockRestore();
  });

  it('logs a bounded redacted PTY tail when native prompt acceptance fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubs.waitForIdle.mockRejectedValueOnce(new Error('prompt proof failed'));
    stubs.readSessionOutput.mockReturnValueOnce(
      'authorization: Bearer this-must-never-appear\nlast safe line',
    );

    await expect(
      spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        prompt: 'never accepted',
        scope,
        executionScope: taskExecutionScope,
      }),
    ).rejects.toThrow('prompt proof failed');

    const logged = errorLog.mock.calls.flat().join('\n');
    expect(logged).toContain(
      '[spawn] agent prompt failed (codex/session-1)',
    );
    expect(logged).toContain('last safe line');
    expect(logged).not.toContain('this-must-never-appear');
    expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-1');
    errorLog.mockRestore();
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
    // 19/08: nexus_handoff_submit agora EXISTE como comando de shell no PATH
    // do pane (shim) — o contrato do worker sem MCP cita a forma shell.
    expect(prompt).toContain('nexus_handoff_submit --status');
  });

  it('does not append handoff_submit to merge-council reviewer briefs', async () => {
    stubs.sessionState.mockReturnValue('busy');

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

    const spawnCalls = stubs.requestPaneSpawn.mock.calls as unknown as Array<
      [{ initialPrompt?: string }]
    >;
    const initialPrompt = spawnCalls.at(-1)?.[0].initialPrompt;
    expect(initialPrompt).toContain('nexus_merge_review_submit');
    expect(initialPrompt).not.toContain('nexus_handoff_submit');
    expect(stubs.writeSession).not.toHaveBeenCalled();
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

  it('retries Enter after a paste-echo busy that settled back to idle', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('busy');
      const pending = injectPrompt('session-1', 'go');
      await vi.advanceTimersByTimeAsync(499);
      stubs.sessionState.mockReturnValue('idle');
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'idle');
      await vi.advanceTimersByTimeAsync(1);
      expect(
        (
          stubs.writeSession.mock.calls as unknown as Array<
            readonly [string, string]
          >
        ).filter((call) => call[1] === '\r'),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(400);
      await pending;
      expect(
        (
          stubs.writeSession.mock.calls as unknown as Array<
            readonly [string, string]
          >
        ).filter((call) => call[1] === '\r'),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails visibly when Enter cannot be written to the PTY', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(((_sessionId: string, data: string) => {
        return data !== '\r';
      }) as typeof stubs.writeSession);
      const pending = injectPrompt('session-1', 'go');
      const rejected = expect(pending).rejects.toThrow(
        'agent prompt Enter was not delivered to the PTY',
      );
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
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
      vi.useRealTimers();
    }
  });

  it('requires Claude UserPromptSubmit even when plugin bootstrap emits busy and output after Enter', async () => {
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
      vi.useRealTimers();
    }
  });

  it('accepts a sustained Claude turn when hook wiring is absent but PTY work is physical', async () => {
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
                tap(sessionId, 'reading workspace');
                tap(sessionId, 'running command');
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

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toBe(true);
      expect(stubs.turnStartSequence).toBe(0);
      expect(stubs.writeSession).toHaveBeenCalledTimes(2);
    } finally {
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

  it('não aceita busy silencioso do Codex sem fluxo de saída', async () => {
    vi.useFakeTimers();
    try {
      // Não existe mais atalho de release: nenhum adapter fora da família
      // Claude é aceito por uma borda busy sozinha. Codex também precisa do
      // fluxo de saída que prova a abertura física do turno.
      stubs.sessionState.mockReturnValue('idle');
      const pending = deliverAgentPrompt(
        'session-1',
        'run the task',
        undefined,
        { adapterId: 'codex' },
      );
      const rejected = expect(pending).rejects.toThrow(/did not start/i);

      await vi.advanceTimersByTimeAsync(500);
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
      stubs.sessionState.mockReturnValue('busy');
      await vi.advanceTimersByTimeAsync(13_000);

      await rejected;
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
