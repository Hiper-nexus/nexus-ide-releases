import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { requireAccess } from '../license-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  nativeArgvAccepted: vi.fn(() => false),
  turnStartSequence: 0,
  turnStartTaps: [] as Array<
    (entry: { sessionId: string; sequence: number }) => void
  >,
  missionPanesRecord: vi.fn(),
  continuationCommit: vi.fn(),
  continuationBirth: vi.fn((..._args: unknown[]): 'authorized' | 'waiting' | 'gone' => { throw new Error('the ordinary path must not consult the continuation birth state'); }),
  physicalSessionInfo: vi.fn<() => unknown>(() => null),
  acpSessionInfo: vi.fn<() => unknown>(() => null),
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
  /** Status semântico do agente (F-926: 'working' com PTY idle não segura o Enter). */
  semanticStatus: undefined as string | undefined,
  orchSettings: {
    leanCode: false,
    seniorMode: false,
    designPro: false,
    squadCliPolicy: 'operator-choice',
    agentAttestationGate: 'off' as 'off' | 'required',
    cliPromptAutoResponderEnabled: true,
  },
  issueAgentIdentityBestEffort: vi.fn(),
}));

vi.mock('./workspace-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-path')>()),
  resolveCwdForScope: stubs.resolveCwdForScope,
}));
vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(),
  pendingSpawnAttemptSession: vi.fn(() => ({ state: 'waiting' })),
  requestPaneClose: stubs.requestPaneClose,
  requestPaneSpawn: stubs.requestPaneSpawn,
  readSessionOutput: stubs.readSessionOutput,
  resolveCurrentMissionSpawnAuthoritySeal:
    stubs.resolveMissionPaneAuthoritySeal,
  waitForIdle: stubs.waitForIdle,
}));
vi.mock('./pane-authz', () => ({ authorizePaneAccess: vi.fn() }));

vi.mock('../pty/pty-analysis-runtime', async original => {
  const { PtyAnalysisCore } = await import('../pty/pty-analysis-core');
  return { ...await original<typeof import('../pty/pty-analysis-runtime')>(),
    watchPtyAnalysisSession: (_consumer: string, id: string, config: { adapterId?: string }, callback: (value: unknown) => void) => {
      let seq = 0;
      const core = new PtyAnalysisCore([], result => { for (const event of result.events) if (event.consumer === 'paste') callback(event.value); });
      const feed = (body: object) => core.process({ sessionId: id, generation: 1, workerEpoch: 1, eventSeq: ++seq, observedAt: Date.now(), ...body } as Parameters<typeof core.process>[0]);
      feed({ kind: 'bind', binding: { adapterId: config.adapterId } });
      feed({ kind: 'arm', consumer: 'paste', registration: 1, config });
      const tap = (sessionId: string, data: string) => { if (sessionId === id) feed({ kind: 'data', data }); };
      stubs.dataTaps.push(tap);
      return () => { const index = stubs.dataTaps.indexOf(tap); if (index >= 0) stubs.dataTaps.splice(index, 1); core.close(); };
    },
  };
});

vi.mock('../pty/pty-manager', () => ({
  countLiveAgentSessions: vi.fn(() => 0),
  getAgentSessionInfo: stubs.physicalSessionInfo,
  hasAcceptedNativeArgvPrompt: stubs.nativeArgvAccepted,
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
vi.mock('../acp/acp-harness-driver', () => ({ getAcpDriverSession: stubs.acpSessionInfo }));
vi.mock('./agent-status', () => ({
  isSessionInjectableIdle: vi.fn(
    () =>
      stubs.sessionState() === 'idle' &&
      stubs.injectable &&
      // Espelha agent-status real: working fresco e awaiting-input vetam.
      stubs.semanticStatus !== 'awaiting-input' &&
      stubs.semanticStatus !== 'working',
  ),
  getAgentSemanticStatusBySession: vi.fn(() =>
    stubs.semanticStatus ? { status: stubs.semanticStatus, updatedAt: Date.now() } : undefined,
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
          : id === 'devin'
            ? {
                id: 'devin',
                kind: 'cli-pty',
                label: 'Devin CLI',
                bin: 'devin',
                spawn: {
                  interactive: ['devin'],
                  extraArgs: [],
                  initialPrompt: 'paste',
                },
                models: { default: 'swe-2-high', list: ['swe-2-high'] },
                quirks: { nexusMcp: 'none', mcpAutoload: false },
                promptInjection: {
                  method: 'arg',
                  trailingNewline: false,
                  bracketedPaste: false,
                },
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
vi.mock('../pty/pre-spawn-probe', async original => ({
  ...await original<typeof import('../pty/pre-spawn-probe')>(),
  assertPreSpawnProbe: stubs.preSpawnProbe,
}));
vi.mock('./mission-pane-store', () => ({ recordMissionPane: vi.fn() }));
vi.mock('./mission-pane-resume-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-pane-resume-ownership')>()),
  commitWorkerContinuation: stubs.continuationCommit,
  workerContinuationBirthState: stubs.continuationBirth,
}));
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
vi.mock('./legacy-handoff', async original => ({ ...await original<typeof import('./legacy-handoff')>(), LEGACY_MARKER: 'marker' }));
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
  proveNativeArgvBriefAccepted,
  deliverAgentPrompt,
  injectPrompt,
  clearAdaptiveEnterTimers,
  spawnPaneAndMaybePrompt,
  submitPendingAgentPrompt,
  withHandoffContract,
  deliverPromptAfterPendingSpawn,
} from './tool-util';
import { PASTE_INGEST_GRACE_MS, PASTE_QUIESCE_MS } from './paste-ingest';
import { startPhaseTimer } from '../observability/phase-timer';
import { cliPromptAutoResponder } from './cli-prompt-autoresponder';
import { PreSpawnProbeError } from '../pty/pre-spawn-probe';
import { getPaneAuthzInfo, pendingSpawnAttemptSession } from './pane-registry';
import { onWorkerSpawnFailed } from './spawn-fail-events';
import { adapterCircuitBreakers } from './circuit-breaker';
import { ORCH_SPAWN_GRANT_TTL_MS } from './orch-spawn-grant-recovery';
import {
  getPaneStartWatch,
  resetPaneStartWatchdogForTests,
  trackPaneStart,
} from './pane-start-watchdog';
import { testProjectScope } from './__tests__/scope-fixture';
const KIMI_COMPOSER_SCREEN = 'Welcome to Kimi Code!\n│ >   │\nAsk When Needed K3 thinking: high\ncontext: 0% (0/1M)';
/** F-956: cauda real do pane `pane-muyma29q-p` (Kimi Code 2.1.1, K3) em 07/10. */
const KIMI_211_COMPOSER_SCREEN = [
  ' ╭────────────────────────────────────────────────────────────────────────────╮',
  ' │                                                                            │',
  ' │   ▐█▛█▛█▌  Welcome to Kimi Code!                                          │',
  ' │   ▐█████▌  Send /help for help information.                               │',
  ' │                                                                            │',
  ' │   Directory: /Users/cleofaspereirarocha/Library/Application Support/NexusID…│',
  ' │   Session:                                                                 │',
  ' │   Model: K3                                                                │',
  ' │   Version: 2.1.1                                                           │',
  ' │                                                                            │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
  ' ✦ Kimi Code Desktop is here — Everything you love about Kimi Code, now on',
  '                             desktop',
  '   Run /desktop or visit https://www.kimi.com/code to install',
  '',
  '   No session yet — one will be created on your first message.',
  '',
  ' ╭────────────────────────────────────────────────────────────────────────────╮',
  ' │ >                                                                          │',
  ' ╰────────────────────────────────────────────────────────────────────────────╯',
  ' Ask When Needed  K3 thinking: high  …/project-4bd6404c5885df95fc2ad9477d576c3…',
  '                                                             context: 0% (0/1M)',
].join('\n');
/** Diálogo de trust do Kimi em dois pedaços do mesmo quadro (leitura do PTY). */
const KIMI_TRUST_DIALOG_HEAD =
  'Trust this folder?\n↑↓ navigate · Enter select · Esc exit\n\n' +
  'Project-level MCP servers are disabled until you explicitly choose Trust.\n' +
  'Trust starts the listed project MCP targets and remembers this folder.\n\n' +
  ' ❯ Trust this folder\n   Enable project MCP servers. Remembered for this folder.\n\n' +
  "   Don't trust\n";
const KIMI_TRUST_DIALOG_TAIL = '   Exit Kimi Code. Asked again next launch.\n';
import fs from 'node:fs';
import { analysisClient } from '../pty/pty-analysis-runtime';
import { PtyAnalysisCore } from '../pty/pty-analysis-core';
import { applyAttestedBusinessModel, createBarbershopRepo } from '../context/business-model/__fixtures__/barbershop';

const DEVIN_TRUST_SCREEN = `
Do you trust the authors of this directory?

Devin can read, edit, and run commands here. Only continue
with untrusted content.

> Yes, trust this folder
  No, exit
`;

const DEVIN_COMPOSER_SCREEN =
  '❭ Ask Devin to build features, fix bugs, and understand your code';

const scope = testProjectScope();
const taskExecutionScope = {
  ...scope,
  checkoutId: 'checkout-task-1',
  rootRealPath: '/workspace/.nexus/worktrees/task-1',
};

describe('agent pane workspace confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.continuationCommit.mockReset();
    stubs.continuationBirth.mockReset().mockImplementation(() => { throw new Error('the ordinary path must not consult the continuation birth state'); });
    stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
    stubs.acpSessionInfo.mockReset().mockReturnValue(null);
    stubs.stateTaps.length = 0;
    stubs.dataTaps.length = 0;
    stubs.exitTaps.length = 0;
    stubs.turnStartSequence = 0;
    stubs.nativeArgvAccepted.mockReset().mockReturnValue(false);
    stubs.turnStartTaps.length = 0;
    stubs.resolveCwdForScope.mockReturnValue('/workspace');
    stubs.preSpawnProbe.mockResolvedValue(undefined);
    stubs.waitForIdle.mockResolvedValue('idle');
    stubs.readSessionOutput.mockReturnValue('');
    stubs.requestPaneClose.mockResolvedValue(true);
    stubs.terminateSession.mockResolvedValue(true);
    stubs.taskDispatchesList.mockReturnValue([]);
    stubs.orchSettings.agentAttestationGate = 'off';
    stubs.orchSettings.cliPromptAutoResponderEnabled = true;
    cliPromptAutoResponder.clear();
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

  it('F-1151: continuation preparation keeps the original visual assignment identity', async () => {
    const visualTask = { id: 'original-visual-assignment', since: 123 };
    await spawnPaneAndMaybePrompt({ adapterId: 'codex', scope, resume: true,
      resumeFromPaneId: 'closed-original', visualTask,
      workerContinuation: { sourcePaneId: 'closed-original', attemptId: 'owned-attempt' } });
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(expect.objectContaining({ visualTask }));
  });

  it('F-736: PTY gravável não fecha o disjuntor do adapter (não prova que a CLI funciona)', async () => {
    // 02/10: o Qwen chegava ao writer-ready e morria no boot 3 s depois; o
    // sucesso registrado aqui zerava a contagem e o disjuntor nunca abria.
    adapterCircuitBreakers.reset();
    for (let i = 0; i < 3; i += 1) adapterCircuitBreakers.recordFailure('codex');
    expect(adapterCircuitBreakers.isOpen('codex')).toBe(true);
    try {
      await spawnPaneAndMaybePrompt({ adapterId: 'codex', scope });
      expect(adapterCircuitBreakers.isOpen('codex')).toBe(true);
      expect(adapterCircuitBreakers.snapshot('codex').recentFailures).toBe(3);
    } finally {
      adapterCircuitBreakers.reset();
    }
  });

  it('persists the physical Main account without trusting an account in the spawn reply', async () => {
    stubs.physicalSessionInfo.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', adapterId: 'codex', missionId: 'm1',
      accountId: 'main-selected', scope,
    });
    stubs.requestPaneSpawn.mockResolvedValueOnce(Object.assign({
      ok: true, paneId: 'pane-1', sessionId: 'session-1',
    }, { accountId: 'renderer-supplied' }));
    const requested = { adapterId: 'codex', missionId: 'm1', role: 'worker' as const, scope };
    await spawnPaneAndMaybePrompt(requested);
    expect(stubs.missionPanesRecord).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'pane-1', accountId: 'main-selected',
      authoritySeal: stubs.resolveMissionPaneAuthoritySeal(),
    }));
    expect(requested).not.toHaveProperty('accountId');
  });

  it('retains the ACP account when its physical authority uses the coordination scope', async () => {
    stubs.acpSessionInfo.mockReturnValue({ agent: {
      sessionId: 'session-1', paneId: 'pane-1', adapterId: 'codex', missionId: 'm1',
      accountId: 'acp-main-selected', scope,
    } });
    await spawnPaneAndMaybePrompt({
      adapterId: 'codex', missionId: 'm1', role: 'worker', scope, executionScope: taskExecutionScope,
    });
    expect(stubs.missionPanesRecord).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acp-main-selected' }));
  });

  it.each([
    { sessionId: 'another-session' },
    { paneId: 'another-pane' },
    { scope: { ...scope, checkoutId: 'another-checkout' } },
    { accountId: 'different-account' },
  ])('refuses a physical account binding with mismatched identity %o', async (changed) => {
    stubs.physicalSessionInfo.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', adapterId: 'codex', missionId: 'm1',
      accountId: 'pinned-account', scope, ...changed,
    });
    await expect(spawnPaneAndMaybePrompt({
      adapterId: 'codex', missionId: 'm1', role: 'worker', scope, accountId: 'pinned-account',
    })).rejects.toThrow(/physical.*account.*authority/i);
    expect(stubs.missionPanesRecord).not.toHaveBeenCalled();
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

  it('keeps the recorded model on resume instead of applying current model migrations', async () => {
    await spawnPaneAndMaybePrompt({ adapterId: 'codex', model: 'gpt-5.4', resume: true, resumeFromPaneId: 'pane-old', scope });
    expect(stubs.preSpawnProbe).toHaveBeenCalledWith('codex', expect.objectContaining({ model: 'gpt-5.4' }));
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4', resume: true }));
  });

  it('never substitutes another CLI when the resumed conversation has a credential failure', async () => {
    const error = new PreSpawnProbeError({ code: 'missing-credential', adapterId: 'codex', hint: 'fixture' });
    stubs.preSpawnProbe.mockRejectedValueOnce(error);
    await expect(spawnPaneAndMaybePrompt({ adapterId: 'codex', resume: true, resumeFromPaneId: 'pane-old', scope })).rejects.toBe(error);
    expect(stubs.preSpawnProbe).toHaveBeenCalledTimes(1);
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
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

  it('F-721: worker retomado não leva o brief no argv; ele é colado depois do boot', async () => {
    // O spawn que retoma conversa não recebe prompt nativo no pty-manager.
    // Prometer o brief no argv deixava a retomada esperando um turno que
    // nunca abria (no ACK pendente, até o vigia de início).
    vi.useFakeTimers();
    try {
      const onPromptAccepted = vi.fn();
      stubs.sessionState.mockReturnValue('idle');
      let briefPasted = false;
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data.includes('Ajuste o filtro')) briefPasted = true;
          if (data === '\r' && briefPasted) {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) tap(sessionId, 'retomado e trabalhando');
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = spawnPaneAndMaybePrompt(
        {
          adapterId: 'codex',
          missionId: 'm1',
          role: 'worker',
          prompt: 'Ajuste o filtro da lista e entregue o handoff.',
          resume: true,
          resumeFromPaneId: 'pane-old',
          scope,
          executionScope: taskExecutionScope,
        },
        { onPromptAccepted },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;

      const spawnOptions = (
        stubs.requestPaneSpawn.mock.calls as unknown as Array<[Record<string, unknown>]>
      ).at(-1)?.[0];
      expect(spawnOptions).toMatchObject({ resume: true, resumeFromPaneId: 'pane-old' });
      expect(spawnOptions?.initialPrompt).toBeUndefined();
      const written = (
        stubs.writeSession.mock.calls as unknown as Array<readonly [string, string]>
      ).map(([, data]) => data);
      expect(written.some((data) => data.includes('Ajuste o filtro'))).toBe(true);
      expect(onPromptAccepted).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('R6/F-213: subdivide o pty-spawn nos awaits internos (probe, alloc, writer, prompt)', async () => {
    stubs.sessionState.mockReturnValue('busy');
    const timer = startPhaseTimer();

    await spawnPaneAndMaybePrompt(
      {
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        prompt: 'Implemente a interface e entregue o handoff.',
        scope,
        executionScope: taskExecutionScope,
      },
      { timer },
    );

    // O timer vai junto do pedido de spawn — o runtime main-owned pode marcar
    // permit/provider-prep/pty-spawn por dentro do requestPaneSpawn.
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ spawnTimer: timer }),
    );
    const { phases } = timer.finish();
    for (const phase of [
      'credential-probe',
      'pane-alloc',
      'writer-ready',
      'prompt-delivery',
    ]) {
      expect(phases, phase).toHaveProperty(phase, expect.any(Number));
    }
  });

  it('nasce com o <business-model> do projeto no brief, antes da tarefa', async () => {
    const root = createBarbershopRepo();
    try {
      await applyAttestedBusinessModel(root, { ...taskExecutionScope, rootRealPath: root });
      stubs.sessionState.mockReturnValue('busy');
      await spawnPaneAndMaybePrompt({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
        prompt: 'Ajuste o cálculo de comissão no fechamento.',
        scope,
        executionScope: { ...taskExecutionScope, rootRealPath: root },
      });
      const spawnCalls = stubs.requestPaneSpawn.mock.calls as unknown as Array<
        [{ initialPrompt?: string }]
      >;
      const brief = spawnCalls.at(-1)?.[0].initialPrompt ?? '';
      expect(brief).toContain('<business-model fonte=');
      expect(brief).toContain('close_commanda#1');
      expect(brief.indexOf('</business-model>')).toBeLessThan(
        brief.indexOf('Ajuste o cálculo de comissão no fechamento.'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('F-1139 accepts the exact native first turn completed during boot without future activity or Enter', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.waitForIdle.mockImplementationOnce(async () => {
        // Real receipt is retained after matching native Stop; no later edge.
        stubs.nativeArgvAccepted.mockReturnValue(true);
        return 'idle';
      });
      let accepted = false;
      const pending = proveNativeArgvBriefAccepted('session-1', 'exact argv', 'claude')
        .then(() => { accepted = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(accepted).toBe(true);
      await pending;
      expect(stubs.writeSession).not.toHaveBeenCalled();
      expect(stubs.stateTaps).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('F-1139 accepts a fast matching native turn after the activity observer arms without later chunks', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      let accepted = false;
      const pending = proveNativeArgvBriefAccepted('session-1', 'exact argv', 'claude').then(() => { accepted = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(stubs.stateTaps.length).toBeGreaterThan(0);
      // The reducer emits native turn-start before endpoint receipt recording;
      // Stop then settles physical idle in the same turn without output chunks.
      for (const tap of [...stubs.turnStartTaps]) tap({ sessionId: 'session-1', sequence: 1 });
      stubs.nativeArgvAccepted.mockReturnValue(true);
      stubs.sessionState.mockReturnValue('idle');
      await vi.advanceTimersByTimeAsync(1);
      expect(accepted).toBe(true);
      await pending;
      expect(stubs.writeSession).not.toHaveBeenCalled();
      expect(stubs.turnStartTaps).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('F-1139 never treats an unrelated native turn counter as argv acceptance', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.nativeArgvAccepted.mockReturnValue(false);
      let accepted = false;
      const pending = proveNativeArgvBriefAccepted('session-1', 'exact argv', 'claude', { signal: abort.signal })
        .then(() => { accepted = true; });
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      for (const tap of [...stubs.turnStartTaps]) tap({ sessionId: 'other-sid', sequence: 1 });
      for (const tap of [...stubs.turnStartTaps]) tap({ sessionId: 'session-1', sequence: 99 });
      await vi.advanceTimersByTimeAsync(1);
      expect(accepted).toBe(false);
      expect(stubs.writeSession).not.toHaveBeenCalled();
      abort.abort(); await rejected;
      expect(stubs.turnStartTaps).toHaveLength(0);
    } finally { abort.abort(); vi.useRealTimers(); }
  });

  it.each(['idle', 'busy'])('F-1139 recognizes the launch accepted before Maestro wrapper entry (%s)', async state => {
    stubs.sessionState.mockReturnValue(state);
    stubs.nativeArgvAccepted.mockReturnValue(true);
    await proveNativeArgvBriefAccepted('session-1', 'exact argv', 'claude');
    expect(stubs.writeSession).not.toHaveBeenCalled();
    expect(stubs.stateTaps).toHaveLength(0);
  });

  it.each(['abort', 'revoke', 'exit'])('F-1139 completed receipt cannot bypass current %s guard', async mode => {
    const abort = new AbortController();
    stubs.nativeArgvAccepted.mockReturnValue(true);
    stubs.sessionState.mockReturnValue('idle');
    stubs.waitForIdle.mockImplementationOnce(async () => {
      if (mode === 'abort') abort.abort();
      return mode === 'exit' ? 'exited' : 'idle';
    });
    await expect(proveNativeArgvBriefAccepted('session-1', 'exact argv', 'claude', {
      signal: abort.signal,
      assertCurrentAuthority: () => { if (mode === 'revoke') throw new Error('revoked'); },
    })).rejects.toThrow();
    expect(stubs.writeSession).not.toHaveBeenCalled();
  });

  it.each(['request-gone', 'request-rebound', 'mission-blocked', 'seal-changed'])(
    'F-1139 pending receipt rechecks durable %s after boot and never rescues', async mode => {
      const onPendingSpawn = vi.fn();
      stubs.sessionState.mockReturnValue('idle');
      stubs.requestPaneSpawn.mockResolvedValueOnce({ ok: true, pending: true, requestId: 'pending-argv', paneId: 'pane-1' } as never);
      await expect(spawnPaneAndMaybePrompt({ adapterId: 'claude', missionId: 'm1', role: 'worker',
        readOnly: true, prompt: 'exact argv', scope, executionScope: taskExecutionScope }, { onPendingSpawn })).rejects.toThrow('pane spawn failed');
      const info = { sessionId: 'session-1', paneId: 'pane-1', adapterId: 'claude', scope, role: 'worker' };
      stubs.physicalSessionInfo.mockReturnValue(info);
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'bound', sessionId: 'session-1' });
      stubs.nativeArgvAccepted.mockReturnValue(true);
      stubs.waitForIdle.mockImplementationOnce(async () => {
        if (mode === 'request-gone') vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'gone' });
        if (mode === 'request-rebound') vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'bound', sessionId: 'other-session' });
        if (mode === 'mission-blocked') stubs.missionGet.mockReturnValue({ id: 'm1', squadId: 'squad-1', status: 'blocked' } as never);
        if (mode === 'seal-changed') stubs.resolveMissionPaneAuthoritySeal.mockReturnValue({ intentVersion: 2 } as never);
        return 'idle';
      });
      try {
        await expect(onPendingSpawn.mock.calls[0]![0].redeliver()).rejects.toThrow(/stale brief/);
        expect(stubs.writeSession).not.toHaveBeenCalled();
      } finally {
        stubs.missionGet.mockImplementation(missionId => missionId === 'm1' ? { id: 'm1', squadId: 'squad-1' } : null);
        stubs.resolveMissionPaneAuthoritySeal.mockReturnValue({ intentVersion: 1, intentContractHash: 'intent-contract-hash',
          contextRevision: 'context-revision', contractHash: 'contract-hash', squadRevisionHash: 'squad-revision-hash' });
      }
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

  it('F-1139 preserves exact durable handoff when the worker exits during Enter rescue', async () => {
    vi.useFakeTimers();
    try {
      let running = true;
      const onPromptAccepted = vi.fn();
      stubs.sessionState.mockReturnValue('idle');
      stubs.writeSession.mockImplementation(((_sid: string, data: string) => {
        if (data === '\r') queueMicrotask(() => {
          stubs.taskDispatchesList.mockReturnValue([{ missionId: 'm1', sessionId: 'session-1',
            workerIncarnationId: 'inc-rescue', handoffId: 'handoff-rescue' }]);
          running = false;
          stubs.sessionState.mockReturnValue(null as never);
          for (const tap of [...stubs.exitTaps]) tap('session-1');
        });
        return true;
      }) as typeof stubs.writeSession);
      const pending = spawnPaneAndMaybePrompt({ adapterId: 'agy', missionId: 'm1', role: 'worker',
        readOnly: true, prompt: 'Exact rescue handoff.', workerIncarnationId: 'inc-rescue', scope,
        executionScope: taskExecutionScope }, { onPromptAccepted, invocation: { assertCurrentAuthority: () => {
          if (!running) throw new Error('dispatch handoff_ready revoked running authority');
        } } });
      const result = expect(pending).resolves.toEqual({ paneId: 'pane-1', sessionId: 'session-1' });
      await vi.advanceTimersByTimeAsync(45_000);
      await result;
      expect(onPromptAccepted).toHaveBeenCalledOnce();
      expect(stubs.requestPaneClose).not.toHaveBeenCalled();
    } finally {
      stubs.writeSession.mockReset().mockReturnValue(true);
      stubs.sessionState.mockReturnValue('busy');
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
        expect.objectContaining({ markInputBusy: false }),
      );
      await vi.advanceTimersByTimeAsync(400);
      await pending;

      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        1,
        'session-1',
        '\x1b[200~line one\nline two\x1b[201~',
        expect.objectContaining({ markInputBusy: false }),
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        3,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['codex', '\x1b[200~avisa quando começar\x1b[201~'],
    // F-1411: Kimi Code 2.x entende o marcador; tecla crua + Enter vira paste-burst.
    ['kimi', '\x1b[200~avisa quando começar\x1b[201~'],
    [null, 'avisa quando começar'],
  ])('linha única em pane %s: agente com colagem recebe bracketed paste (Enter não vira newline)', async (adapterId, expected) => {
    vi.useFakeTimers();
    try {
      stubs.physicalSessionInfo.mockReturnValue(adapterId ? { adapterId } : null);
      const pending = injectPrompt('session-1', 'avisa quando começar');
      await vi.advanceTimersByTimeAsync(900);
      await pending;
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        1,
        'session-1',
        expected,
        expect.objectContaining({ markInputBusy: false }),
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
      );
    } finally {
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
      vi.useRealTimers();
    }
  });

  it('F-1282: Enter perdido na ingestão — resgate calmo reenvia UM Enter quando a TUI assenta', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      const pending = injectPrompt('session-1', 'line one\nline two');
      await vi.advanceTimersByTimeAsync(1_400);
      await pending;

      // A TUI engole os Enters da escada fixa enquanto ingere a colagem:
      // eco contínuo de ingestão, PTY idle, nenhum turno começa (campo
      // 11/10: Kimi 30 min com o brief colado e sem alarme nenhum).
      const churn = setInterval(() => {
        for (const tap of [...stubs.dataTaps]) tap('session-1', 'ingest echo');
      }, 100);
      await vi.advanceTimersByTimeAsync(12_000);
      const enterCalls = () =>
        (stubs.writeSession.mock.calls as unknown as Array<readonly [string, string]>)
          .filter(([id, data]) => id === 'session-1' && (data === '\r' || data === '\r\n'));
      const beforeQuiet = enterCalls().length;
      clearInterval(churn);

      // Saída quieta + sessão idle + nenhum turno: UM Enter depois de a TUI
      // acalmar — hoje a escada (600/1200/2000 ms) já desistiu há tempo.
      await vi.advanceTimersByTimeAsync(10_000);
      const afterQuiet = enterCalls();
      expect(afterQuiet.length).toBe(beforeQuiet + 1);
      expect(afterQuiet[afterQuiet.length - 1]![1]).toBe('\r\n');
      // Resgate concluído solta os taps.
      expect(stubs.stateTaps).toHaveLength(0);
      expect(stubs.dataTaps).toHaveLength(0);
      expect(stubs.exitTaps).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('brief de colagem com ACK pendente', () => {
    const answerEnterWithTurn = () =>
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) tap(sessionId, 'working');
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );
    const spawnPendingKimi = async () => {
      stubs.sessionState.mockReturnValue('idle');
      stubs.waitForIdle.mockResolvedValue('idle');
      stubs.requestPaneSpawn.mockResolvedValueOnce({
        requestId: 'req-kimi',
        ok: true,
        pending: true,
        paneId: 'pane-kimi',
        sessionId: null,
      } as never);
      vi.mocked(getPaneAuthzInfo).mockReturnValue(null as never);
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'waiting' });
      await expect(
        spawnPaneAndMaybePrompt({ adapterId: 'kimi', prompt: 'revise o diff', scope }),
      ).rejects.toThrow();
      expect(stubs.writeSession).not.toHaveBeenCalled();
    };
    const bindAttempt = (sessionId: string) => {
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'bound', sessionId });
      vi.mocked(getPaneAuthzInfo).mockReturnValue({ sessionId } as never);
      stubs.physicalSessionInfo.mockImplementation(((id: string) =>
        id === sessionId ? { paneId: 'pane-kimi', adapterId: 'kimi' } : null) as never);
    };
    const typedInto = (sessionId: string) =>
      (stubs.writeSession.mock.calls as unknown as Array<readonly [string, string]>)
        .filter(([id]) => id === sessionId);
    let failures: Array<{ message: string }> = [];
    let unsubscribe: () => void = () => {};

    beforeEach(() => {
      vi.useFakeTimers();
      stubs.readSessionOutput.mockReturnValue(KIMI_COMPOSER_SCREEN);
      failures = [];
      unsubscribe = onWorkerSpawnFailed((event) => failures.push(event));
    });
    afterEach(() => {
      unsubscribe();
      stubs.semanticStatus = undefined;
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
      vi.mocked(getPaneAuthzInfo).mockReset();
      vi.mocked(pendingSpawnAttemptSession).mockReset().mockReturnValue({ state: 'waiting' });
      stubs.writeSession.mockReset().mockReturnValue(true);
      vi.useRealTimers();
    });

    it('helper Kimi recebe o brief por colagem quando a sessão da tentativa nasce', async () => {
      answerEnterWithTurn();
      await spawnPendingKimi();
      // A sessão do pane nasce depois da resposta da tool.
      bindAttempt('session-kimi');
      await vi.advanceTimersByTimeAsync(3_000);

      const typed = typedInto('session-kimi');
      expect(typed[0]?.[1]).toContain('revise o diff');
      expect(typed.some(([, data]) => data === '\r')).toBe(true);
      expect(stubs.requestPaneClose).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
    });

    it('F-926: semantic "working" com PTY idle ainda recebe o Enter (Devin/Kimi colados)', async () => {
      // Campo 05/10: Devin (SWE-2) e Kimi nasciam com o prompt COLADO na
      // caixa de entrada e sem o Enter final. O paste entra com a sessão
      // idle; o eco da colagem/hook vira semantic `working` e o submitEnter
      // antigo abortava o Enter — o brief já estava no composer.
      answerEnterWithTurn();
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data.includes('revise o diff')) {
            // Eco do paste: semantic vira working, PTY continua idle.
            stubs.semanticStatus = 'working';
          }
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) tap(sessionId, 'working');
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );
      await spawnPendingKimi();
      bindAttempt('session-kimi');
      await vi.advanceTimersByTimeAsync(3_000);

      const typed = typedInto('session-kimi');
      expect(typed[0]?.[1]).toContain('revise o diff');
      expect(typed.some(([, data]) => data === '\r')).toBe(true);
      expect(failures).toEqual([]);
    });

    it.each([2, 3])('F-949: Kimi submits one pasted brief when Enter attempt %s starts the turn', async (acceptedEnter) => {
      let enters = 0;
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data.includes('revise o diff')) stubs.semanticStatus = 'working';
          if (data === '\r' || data === '\r\n') {
            enters += 1;
            if (enters === acceptedEnter) {
              queueMicrotask(() => {
                stubs.turnStartSequence += 1;
                for (const tap of [...stubs.turnStartTaps]) tap({ sessionId, sequence: stubs.turnStartSequence });
                stubs.sessionState.mockReturnValue('busy');
                for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
                for (const tap of [...stubs.dataTaps]) tap(sessionId, 'working');
              });
            }
          }
          return true;
        }) as typeof stubs.writeSession,
      );
      await spawnPendingKimi();
      bindAttempt('session-kimi');
      await vi.advanceTimersByTimeAsync(3_000);
      const typed = typedInto('session-kimi');
      expect(typed.filter(([, data]) => data.includes('revise o diff'))).toHaveLength(1);
      expect(enters).toBe(acceptedEnter);
      expect(stubs.turnStartSequence).toBe(1);
      expect(failures).toEqual([]);
    });

    it.each(['busy', 'awaiting-input'] as const)('F-949: Kimi does not retry Enter after %s', async (blockingState) => {
      let enters = 0;
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data.includes('revise o diff')) stubs.semanticStatus = 'working';
          if (data === '\r' || data === '\r\n') {
            enters += 1;
            if (blockingState === 'busy') {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
            } else stubs.semanticStatus = 'awaiting-input';
          }
          return true;
        }) as typeof stubs.writeSession,
      );
      await spawnPendingKimi();
      bindAttempt('session-kimi');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(enters).toBe(1);
      expect(typedInto('session-kimi').filter(([, data]) => data.includes('revise o diff'))).toHaveLength(1);
    });

    it('F-926: semantic "awaiting-input" (diálogo real) ainda bloqueia o Enter', async () => {
      // Mesmo com o brief já colado, um diálogo aberto (awaiting-input) faz o
      // Enter ir para o lugar errado — segue recusado.
      stubs.writeSession.mockImplementation(
        ((_sessionId: string, data: string) => {
          if (data.includes('revise o diff')) {
            stubs.semanticStatus = 'awaiting-input';
          }
          return true;
        }) as typeof stubs.writeSession,
      );
      await spawnPendingKimi();
      bindAttempt('session-kimi');
      await vi.advanceTimersByTimeAsync(3_000);

      const typed = typedInto('session-kimi');
      // Colagem entra, mas o Enter NÃO — escrever num diálogo é o lugar errado.
      expect(typed.some(([, data]) => data === '\r')).toBe(false);
    });

    it('a entrega não morre com a autoridade da requisição (a próxima tool do pane a substitui)', async () => {
      // Smoke 28/09: o Kimi abria mudo. A autoridade do invocation é por
      // chamada MCP; quando o pane nasce, a tool já respondeu e outra chamada
      // do mesmo pane a substituiu — a colagem morria em
      // session_authority_revoked. A entrega é do spawn, não da requisição.
      answerEnterWithTurn();
      stubs.sessionState.mockReturnValue('idle');
      stubs.waitForIdle.mockResolvedValue('idle');
      stubs.requestPaneSpawn.mockResolvedValueOnce({
        requestId: 'req-kimi',
        ok: true,
        pending: true,
        paneId: 'pane-kimi',
        sessionId: null,
      } as never);
      vi.mocked(getPaneAuthzInfo).mockReturnValue(null as never);
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'waiting' });
      let current = true;
      const invocation = {
        assertCurrentAuthority: () => {
          if (!current) throw new Error('session_authority_revoked');
        },
      } as never;
      await expect(
        spawnPaneAndMaybePrompt({ adapterId: 'kimi', prompt: 'revise o diff', scope }, { invocation }),
      ).rejects.toThrow();
      current = false;
      bindAttempt('session-kimi');
      await vi.advanceTimersByTimeAsync(3_000);

      expect(typedInto('session-kimi')[0]?.[1]).toContain('revise o diff');
      expect(stubs.requestPaneClose).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
    });

    it('missão bloqueada ou selo trocado enquanto o pane subia não recebe o brief velho', async () => {
      // Astra P2-8: a entrega adiada perdeu a autoridade da requisição, mas
      // mantém a DURÁVEL do spawn — missão viva e mesmo selo.
      const seal = stubs.resolveMissionPaneAuthoritySeal();
      const deliverInto = async (): Promise<boolean> => {
        answerEnterWithTurn();
        stubs.sessionState.mockReturnValue('idle');
        stubs.waitForIdle.mockResolvedValue('idle');
        bindAttempt('session-kimi');
        const delivered = deliverPromptAfterPendingSpawn(
          { requestId: 'req-kimi', paneId: 'pane-kimi' },
          'revise o diff',
          'kimi',
          undefined,
          { scope, missionId: 'm1', authoritySeal: seal },
        );
        await vi.advanceTimersByTimeAsync(3_000);
        return delivered;
      };
      stubs.missionGet.mockImplementationOnce(() => ({ id: 'm1', squadId: 'squad-1', status: 'blocked' }));
      expect(await deliverInto()).toBe(false);
      expect(typedInto('session-kimi')).toEqual([]);
      expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-kimi');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toContain('stale brief');

      stubs.requestPaneClose.mockClear();
      stubs.resolveMissionPaneAuthoritySeal.mockReturnValueOnce({ ...seal, intentVersion: 2 });
      expect(await deliverInto()).toBe(false);
      expect(typedInto('session-kimi')).toEqual([]);
      expect(failures).toHaveLength(2);

      // Missão viva e selo igual: o brief entra.
      expect(await deliverInto()).toBe(true);
      expect(typedInto('session-kimi')[0]?.[1]).toContain('revise o diff');
    });

    it('ACK pendente não conta como falha do adapter no circuit breaker', async () => {
      adapterCircuitBreakers.reset('kimi');
      await spawnPendingKimi();
      expect(adapterCircuitBreakers.snapshot('kimi').recentFailures).toBe(0);
    });

    it('sessão da tentativa com outro adapter não recebe o brief', async () => {
      answerEnterWithTurn();
      await spawnPendingKimi();
      bindAttempt('session-kimi');
      stubs.physicalSessionInfo.mockImplementation(((id: string) =>
        id === 'session-kimi' ? { paneId: 'pane-kimi', adapterId: 'codex' } : null) as never);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(typedInto('session-kimi')).toEqual([]);
      expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-kimi');
      expect(failures).toHaveLength(1);
    });

    it('brief não aceito fecha o pane da tentativa e avisa — nunca helper mudo', async () => {
      // Diálogo de boot engole o brief: nenhum Enter abre turno.
      await spawnPendingKimi();
      bindAttempt('session-kimi');
      await vi.advanceTimersByTimeAsync(120_000);

      expect(typedInto('session-kimi').length).toBeGreaterThan(0);
      expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-kimi');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toContain('briefing não foi entregue');
    });

    it('pane reciclado no mesmo paneId não recebe o brief da tentativa anterior nem é fechado', async () => {
      answerEnterWithTurn();
      await spawnPendingKimi();
      // A sessão da tentativa nasceu e morreu; o pane foi reaberto (resume)
      // com outra sessão no mesmo paneId.
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'bound', sessionId: 'session-morta' });
      vi.mocked(getPaneAuthzInfo).mockReturnValue({ sessionId: 'session-substituta' } as never);
      stubs.physicalSessionInfo.mockImplementation(((id: string) =>
        id === 'session-substituta' ? { paneId: 'pane-kimi', adapterId: 'kimi' } : null) as never);
      stubs.sessionState.mockImplementation((() => null) as never);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(stubs.writeSession).not.toHaveBeenCalled();
      expect(stubs.requestPaneClose).not.toHaveBeenCalled();
      expect(failures).toHaveLength(1);
      stubs.sessionState.mockReset().mockReturnValue('busy');
    });

    it('autoridade do chamador revogada depois do nascimento fecha o pane sem aviso extra', async () => {
      answerEnterWithTurn();
      const controller = new AbortController();
      stubs.sessionState.mockReturnValue('idle');
      stubs.waitForIdle.mockResolvedValue('idle');
      stubs.requestPaneSpawn.mockResolvedValueOnce({
        requestId: 'req-kimi', ok: true, pending: true, paneId: 'pane-kimi', sessionId: null,
      } as never);
      vi.mocked(getPaneAuthzInfo).mockReturnValue(null as never);
      await expect(
        spawnPaneAndMaybePrompt(
          { adapterId: 'kimi', prompt: 'revise o diff', scope },
          { invocation: { signal: controller.signal } },
        ),
      ).rejects.toThrow();
      bindAttempt('session-kimi');
      controller.abort('session_authority_revoked');
      await vi.advanceTimersByTimeAsync(3_000);

      expect(typedInto('session-kimi')).toEqual([]);
      expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-kimi');
      expect(failures).toEqual([]);
      // F-723: chamador revogado não é falha de início da CLI.
      expect(getPaneStartWatch('pane-kimi')).toBeNull();
    });

    describe('F-723: watchdog de início', () => {
      const watchKimi = () =>
        trackPaneStart({
          paneId: 'pane-kimi',
          requestId: 'req-kimi',
          adapterId: 'kimi',
          scope,
          role: 'helper',
          callerSessionId: 'session-operador',
          turnProof: false,
          pinnedRuntime: false,
          rerouted: false,
          createdAt: Date.now(),
        });
      afterEach(() => resetPaneStartWatchdogForTests());

      it('o ACK pendente com briefing entrega a ficha com a entrega comprovada como reenvio', async () => {
        const onPendingSpawn = vi.fn();
        stubs.sessionState.mockReturnValue('idle');
        stubs.requestPaneSpawn.mockResolvedValueOnce({
          requestId: 'req-kimi', ok: true, pending: true, paneId: 'pane-kimi', sessionId: null,
        } as never);
        vi.mocked(getPaneAuthzInfo).mockReturnValue(null as never);
        vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'waiting' });
        await expect(
          spawnPaneAndMaybePrompt(
            { adapterId: 'kimi', prompt: 'revise o diff', scope },
            { onPendingSpawn },
          ),
        ).rejects.toThrow();
        expect(onPendingSpawn).toHaveBeenCalledTimes(1);
        const attempt = onPendingSpawn.mock.calls[0]![0];
        expect(attempt).toMatchObject({
          requestId: 'req-kimi', paneId: 'pane-kimi', adapterId: 'kimi', turnProof: false,
        });
        // A ficha nunca leva o texto do brief.
        expect(JSON.stringify(attempt)).not.toContain('revise o diff');

        // Sessão ainda não vinculada à tentativa: nada a reentregar.
        await expect(attempt.redeliver()).resolves.toBe(false);
        answerEnterWithTurn();
        bindAttempt('session-kimi');
        await vi.advanceTimersByTimeAsync(3_000);
        stubs.writeSession.mockClear();
        stubs.sessionState.mockReturnValue('idle');
        answerEnterWithTurn();
        const redelivered = attempt.redeliver();
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(redelivered).resolves.toBe(true);
        expect(typedInto('session-kimi')[0]?.[1]).toContain('revise o diff');
      });

      it('brief aceito na colagem adiada dá o pane por iniciado', async () => {
        answerEnterWithTurn();
        const watch = watchKimi();
        await spawnPendingKimi();
        bindAttempt('session-kimi');
        await vi.advanceTimersByTimeAsync(3_000);
        expect(watch.accepted).toBe(true);
        expect(watch.failure).toBeNull();
      });

      it('brief não aceito vira falha de início no watchdog (antes: só toast, ninguém reenviava)', async () => {
        const watch = watchKimi();
        await spawnPendingKimi();
        bindAttempt('session-kimi');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(failures).toHaveLength(1);
        expect(watch.failure?.cause).toBe('brief-rejected');
      });

      it('missão encerrada enquanto o pane subia não é falha da CLI', async () => {
        const watch = watchKimi();
        answerEnterWithTurn();
        stubs.sessionState.mockReturnValue('idle');
        stubs.waitForIdle.mockResolvedValue('idle');
        bindAttempt('session-kimi');
        stubs.missionGet.mockImplementationOnce(() => ({ id: 'm1', squadId: 'squad-1', status: 'blocked' }));
        const delivered = deliverPromptAfterPendingSpawn(
          { requestId: 'req-kimi', paneId: 'pane-kimi' },
          'revise o diff',
          'kimi',
          undefined,
          { scope, missionId: 'm1' },
        );
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await delivered).toBe(false);
        expect(watch.failure).toBeNull();
      });
    });
  });

  describe('F-793: helper de missão com ACK pendente entra em missionPanes', () => {
    // Missão Terminais (03/10): 28 helpers abertos por nexus_pane_spawn, todos
    // com ACK pendente, e `mission_panes` só com o orquestrador — o throw de
    // compatibilidade saía antes da gravação.
    const physical = {
      sessionId: 'session-w', paneId: 'pane-w', adapterId: 'codex', missionId: 'm1',
      accountId: 'main-selected', scope,
    };
    const spawnPendingWorker = async (extra: { readonly accountId?: string } = {}) => {
      const outcomes: Array<Promise<string>> = [];
      stubs.requestPaneSpawn.mockResolvedValueOnce({
        requestId: 'req-w', ok: true, pending: true, paneId: 'pane-w', sessionId: null,
      } as never);
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'waiting' });
      // A regra do ACK pendente segue: o helper legado nunca devolve sessão
      // nula — só o nexus_pane_spawn traduz o throw em sucesso.
      await expect(
        spawnPaneAndMaybePrompt(
          { adapterId: 'codex', missionId: 'm1', role: 'worker', scope, ...extra },
          { onPendingMissionPane: (recorded) => { outcomes.push(recorded); } },
        ),
      ).rejects.toThrow();
      return outcomes;
    };
    const bind = (info: Record<string, unknown> = physical) => {
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'bound', sessionId: 'session-w' });
      stubs.physicalSessionInfo.mockImplementation(((id: string) =>
        id === 'session-w' ? info : null) as never);
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.mocked(pendingSpawnAttemptSession).mockReset().mockReturnValue({ state: 'waiting' });
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
      vi.useRealTimers();
    });

    it('grava a linha com a conta física quando a sessão da tentativa nasce', async () => {
      const outcomes = await spawnPendingWorker();
      // Sem sessão ainda: nada é gravado a partir da resposta do renderer.
      expect(stubs.missionPanesRecord).not.toHaveBeenCalled();
      bind();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(stubs.missionPanesRecord).toHaveBeenCalledTimes(1);
      expect(stubs.missionPanesRecord).toHaveBeenCalledWith(expect.objectContaining({
        missionId: 'm1',
        paneId: 'pane-w',
        adapterId: 'codex',
        role: 'worker',
        accountId: 'main-selected',
        authoritySeal: stubs.resolveMissionPaneAuthoritySeal(),
      }));
      expect(outcomes).toHaveLength(1);
      await expect(outcomes[0]).resolves.toBe('recorded');
    });

    it('sessão física que não confere não grava (mesma conferência do caminho síncrono)', async () => {
      const outcomes = await spawnPendingWorker({ accountId: 'pinned-account' });
      bind({ ...physical, accountId: 'other-account' });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(stubs.missionPanesRecord).not.toHaveBeenCalled();
      await expect(outcomes[0]).resolves.toBe('unrecorded');
    });

    it('tentativa encerrada sem sessão não grava nada', async () => {
      const outcomes = await spawnPendingWorker();
      vi.mocked(pendingSpawnAttemptSession).mockReturnValue({ state: 'gone' });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(stubs.missionPanesRecord).not.toHaveBeenCalled();
      await expect(outcomes[0]).resolves.toBe('no-session');
    });

    describe('F-1151: a worker continuation records only after its exact attempt reached the host post', () => {
      const ref = { sourcePaneId: 'closed-original', attemptId: 'owned-attempt' };
      const born = { ...physical, workerIncarnationId: 'incarnation-new' };
      beforeEach(() => { stubs.continuationCommit.mockReset(); stubs.continuationBirth.mockReset().mockReturnValue('authorized'); });

      it('pending ACK: a visible but unborn session is not committed; the commit follows the authorization once', async () => {
        const outcomes: Array<Promise<string>> = [];
        stubs.requestPaneSpawn.mockResolvedValueOnce({ requestId: 'req-w', ok: true, pending: true, paneId: 'pane-w', sessionId: null } as never);
        await expect(spawnPaneAndMaybePrompt(
          { adapterId: 'codex', missionId: 'm1', role: 'worker', scope, resume: true, resumeFromPaneId: 'closed-original', workerContinuation: ref },
          { onPendingMissionPane: (recorded) => { outcomes.push(recorded); } },
        )).rejects.toThrow();
        stubs.continuationBirth.mockReturnValue('waiting');
        bind(born);
        await vi.advanceTimersByTimeAsync(5_000);
        // Native readiness still owns the host post: session visible, nothing committed, no rebind.
        expect(stubs.continuationCommit).not.toHaveBeenCalled();
        stubs.continuationBirth.mockReturnValue('authorized');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stubs.continuationCommit).toHaveBeenCalledTimes(1);
        expect(stubs.continuationBirth).toHaveBeenCalledWith(scope, ref);
        expect(stubs.continuationCommit).toHaveBeenCalledWith(scope, ref, expect.objectContaining({ paneId: 'pane-w', workerIncarnationId: 'incarnation-new' }), 'session-w');
        await expect(outcomes[0]).resolves.toBe('recorded');
      });

      it('pending ACK: a reservation released before the birth never commits and reports no session', async () => {
        const outcomes: Array<Promise<string>> = [];
        stubs.requestPaneSpawn.mockResolvedValueOnce({ requestId: 'req-w', ok: true, pending: true, paneId: 'pane-w', sessionId: null } as never);
        await expect(spawnPaneAndMaybePrompt(
          { adapterId: 'codex', missionId: 'm1', role: 'worker', scope, resume: true, resumeFromPaneId: 'closed-original', workerContinuation: ref },
          { onPendingMissionPane: (recorded) => { outcomes.push(recorded); } },
        )).rejects.toThrow();
        stubs.continuationBirth.mockReturnValue('gone');
        bind(born);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stubs.continuationCommit).not.toHaveBeenCalled();
        await expect(outcomes[0]).resolves.toBe('no-session');
      });

      it('synchronous result: waits for the authorization before committing, then commits exactly once', async () => {
        stubs.physicalSessionInfo.mockImplementation(((id: string) => id === 'session-w' ? born : null) as never);
        stubs.requestPaneSpawn.mockResolvedValueOnce({ ok: true, paneId: 'pane-w', sessionId: 'session-w' } as never);
        stubs.continuationBirth.mockReturnValue('waiting');
        const spawning = spawnPaneAndMaybePrompt({ adapterId: 'codex', missionId: 'm1', role: 'worker', scope,
          resume: true, resumeFromPaneId: 'closed-original', workerContinuation: ref });
        let settled = false;
        void spawning.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(3_000);
        expect(settled).toBe(false);
        expect(stubs.continuationCommit).not.toHaveBeenCalled();
        stubs.continuationBirth.mockReturnValue('authorized');
        await vi.advanceTimersByTimeAsync(300);
        await expect(spawning).resolves.toMatchObject({ paneId: 'pane-w', sessionId: 'session-w' });
        expect(stubs.continuationCommit).toHaveBeenCalledTimes(1);
        expect(stubs.continuationBirth).toHaveBeenCalledWith(scope, ref);
        expect(stubs.requestPaneClose).not.toHaveBeenCalled();
      });

      it('synchronous result: a reservation released while waiting fails the call without committing', async () => {
        stubs.physicalSessionInfo.mockImplementation(((id: string) => id === 'session-w' ? born : null) as never);
        stubs.requestPaneSpawn.mockResolvedValueOnce({ ok: true, paneId: 'pane-w', sessionId: 'session-w' } as never);
        stubs.continuationBirth.mockReturnValue('waiting');
        const spawning = spawnPaneAndMaybePrompt({ adapterId: 'codex', missionId: 'm1', role: 'worker', scope,
          resume: true, resumeFromPaneId: 'closed-original', workerContinuation: ref });
        const rejected = expect(spawning).rejects.toThrow(/liberada antes do nascimento/);
        await vi.advanceTimersByTimeAsync(500);
        stubs.continuationBirth.mockReturnValue('gone');
        await vi.advanceTimersByTimeAsync(500);
        await rejected;
        expect(stubs.continuationCommit).not.toHaveBeenCalled();
        // Released before any birth: no child can ever exist, so there is nothing to close.
        expect(stubs.requestPaneClose).not.toHaveBeenCalled();
      });

      it('synchronous result: an aborted call closes the pane (the readiness could still post) and never commits', async () => {
        stubs.physicalSessionInfo.mockImplementation(((id: string) => id === 'session-w' ? born : null) as never);
        stubs.requestPaneSpawn.mockResolvedValueOnce({ ok: true, paneId: 'pane-w', sessionId: 'session-w' } as never);
        stubs.continuationBirth.mockReturnValue('waiting');
        const abort = new AbortController();
        const spawning = spawnPaneAndMaybePrompt({ adapterId: 'codex', missionId: 'm1', role: 'worker', scope,
          resume: true, resumeFromPaneId: 'closed-original', workerContinuation: ref },
        { invocation: { signal: abort.signal } } as never);
        const rejected = expect(spawning).rejects.toThrow(/session_authority_revoked/);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stubs.requestPaneClose).not.toHaveBeenCalled();
        abort.abort();
        await vi.advanceTimersByTimeAsync(200);
        await rejected;
        expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-w');
        expect(stubs.continuationCommit).not.toHaveBeenCalled();
      });

      it('synchronous result: an exhausted wait closes the pane and never commits', async () => {
        stubs.physicalSessionInfo.mockImplementation(((id: string) => id === 'session-w' ? born : null) as never);
        stubs.requestPaneSpawn.mockResolvedValueOnce({ ok: true, paneId: 'pane-w', sessionId: 'session-w' } as never);
        stubs.continuationBirth.mockReturnValue('waiting');
        const spawning = spawnPaneAndMaybePrompt({ adapterId: 'codex', missionId: 'm1', role: 'worker', scope,
          resume: true, resumeFromPaneId: 'closed-original', workerContinuation: ref });
        const rejected = expect(spawning).rejects.toThrow(/não foi autorizado a tempo/);
        await vi.advanceTimersByTimeAsync(ORCH_SPAWN_GRANT_TTL_MS + 1_000);
        await rejected;
        expect(stubs.requestPaneClose).toHaveBeenCalledWith('pane-w');
        expect(stubs.continuationCommit).not.toHaveBeenCalled();
      });

      it('the ordinary mission worker never consults the continuation birth state (pending ACK and synchronous)', async () => {
        // Default stub THROWS if consulted; a mission worker without `workerContinuation` must still be recorded.
        const outcomes: Array<Promise<string>> = [];
        stubs.requestPaneSpawn.mockResolvedValueOnce({ requestId: 'req-w', ok: true, pending: true, paneId: 'pane-w', sessionId: null } as never);
        await expect(spawnPaneAndMaybePrompt({ adapterId: 'codex', missionId: 'm1', role: 'worker', scope },
          { onPendingMissionPane: (recorded) => { outcomes.push(recorded); } })).rejects.toThrow();
        bind(born);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(outcomes[0]).resolves.toBe('recorded');
        expect(stubs.missionPanesRecord).toHaveBeenCalledTimes(1);
        stubs.missionPanesRecord.mockClear();
        stubs.physicalSessionInfo.mockImplementation(((id: string) => id === 'session-w' ? born : null) as never);
        stubs.requestPaneSpawn.mockResolvedValueOnce({ ok: true, paneId: 'pane-w', sessionId: 'session-w' } as never);
        const sync = spawnPaneAndMaybePrompt({ adapterId: 'codex', missionId: 'm1', role: 'worker', scope });
        await vi.advanceTimersByTimeAsync(300);
        await expect(sync).resolves.toMatchObject({ paneId: 'pane-w' });
        expect(stubs.missionPanesRecord).toHaveBeenCalledTimes(1);
        expect(stubs.continuationBirth).not.toHaveBeenCalled();
        expect(stubs.continuationCommit).not.toHaveBeenCalled();
      });
    });

    it('pane fora de missão ou transitório não vira composição de missão', async () => {
      const onPendingMissionPane = vi.fn();
      for (const options of [
        { adapterId: 'codex', scope },
        { adapterId: 'codex', missionId: 'm1', role: 'worker' as const, scope, transient: true as const },
      ]) {
        stubs.requestPaneSpawn.mockResolvedValueOnce({
          requestId: 'req-x', ok: true, pending: true, paneId: 'pane-x', sessionId: null,
        } as never);
        await expect(
          spawnPaneAndMaybePrompt(options, { onPendingMissionPane }),
        ).rejects.toThrow();
      }
      expect(onPendingMissionPane).not.toHaveBeenCalled();
    });
  });

  it('sends second Enter even when session was busy during paste echo if it is idle after first Enter', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValueOnce('busy').mockReturnValue('idle');
      const pending = injectPrompt('session-1', 'line one\nline two');
      await vi.advanceTimersByTimeAsync(500);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
      );
      await vi.advanceTimersByTimeAsync(400);
      await pending;
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        3,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
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
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1', {
        origin: 'tool-util:authority-revoked',
      });
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
        expect.objectContaining({ markInputBusy: false }),
      );

      current = false;
      controller.abort('session_authority_revoked');
      await vi.advanceTimersByTimeAsync(400);

      await rejected;
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1', {
        origin: 'tool-util:authority-revoked',
      });
      expect(stubs.writeSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1, 2])('F-265: direct Kimi injection stops retries when dialog appears after Enter %s', async (dialogAfter) => {
    vi.useFakeTimers();
    try {
      stubs.physicalSessionInfo.mockReturnValue({ adapterId: 'kimi' });
      stubs.sessionState.mockReturnValue('idle');
      stubs.semanticStatus = 'working';
      let enters = 0;
      stubs.writeSession.mockImplementation(((_sessionId: string, data: string) => {
        if (data === '\r' || data === '\r\n') {
          enters += 1;
          if (enters === dialogAfter) stubs.semanticStatus = 'awaiting-input';
        }
        return true;
      }) as typeof stubs.writeSession);
      const pending = injectPrompt('session-1', 'continue the task');
      await vi.advanceTimersByTimeAsync(6_000);
      await pending;
      expect(enters).toBe(dialogAfter);
    } finally {
      clearAdaptiveEnterTimers();
      stubs.semanticStatus = undefined;
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
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
        expect.objectContaining({ markInputBusy: false }),
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

  it('F-735: em pane Codex o Enter da colagem grande espera o [Pasted Content]', async () => {
    vi.useFakeTimers();
    try {
      stubs.physicalSessionInfo.mockReturnValue({ adapterId: 'codex' });
      stubs.sessionState.mockReturnValue('idle');
      const pending = injectPrompt('session-1', 'linha do brief\n'.repeat(300));
      // O Enter de 500 ms cairia no meio da ingestão (Codex 0.160, Windows).
      await vi.advanceTimersByTimeAsync(3_000);
      expect(stubs.writeSession).toHaveBeenCalledOnce();

      for (const tap of [...stubs.dataTaps]) {
        tap('session-1', '[Pasted\x1b[1CContent\x1b[1C4500\x1b[1Cchars]');
      }
      await vi.advanceTimersByTimeAsync(149);
      expect(stubs.writeSession).toHaveBeenCalledOnce();
      // F-1282: o marcador só vale com a saída quieta (PASTE_QUIESCE_MS)
      // antes da folga de sempre — a ingestão pode ter 2º bloco a caminho.
      await vi.advanceTimersByTimeAsync(PASTE_QUIESCE_MS + PASTE_INGEST_GRACE_MS + 1);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
      );
      stubs.sessionState.mockReturnValue('busy');
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
      await vi.advanceTimersByTimeAsync(400);
      await pending;
      expect(stubs.writeSession).toHaveBeenCalledTimes(2);
      expect(stubs.dataTaps).toHaveLength(0);
    } finally {
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
      vi.useRealTimers();
    }
  });

  it('F-743: em pane Devin o Enter do brief de muitas linhas espera o [Pasted text #N +M lines]', async () => {
    vi.useFakeTimers();
    try {
      stubs.physicalSessionInfo.mockReturnValue({ adapterId: 'devin' });
      stubs.sessionState.mockReturnValue('idle');
      const pending = injectPrompt('session-1', 'linha do brief\n'.repeat(117));
      // 02/10: com a máquina carregada o Enter de 500 ms entrou na colagem
      // como quebra de linha e o brief ficou largado no composer.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stubs.writeSession).toHaveBeenCalledOnce();
      // O Devin recebe o brief cru, sem bracketed paste.
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        1,
        'session-1',
        expect.not.stringMatching(/^\x1b\[200~/),
        expect.objectContaining({ markInputBusy: false }),
      );

      for (const tap of [...stubs.dataTaps]) {
        tap('session-1', '\x1b[38;5;8m❭\x1b[0m [Pasted\x1b[1Ctext #1 +117 lines]');
      }
      await vi.advanceTimersByTimeAsync(149);
      expect(stubs.writeSession).toHaveBeenCalledOnce();
      // F-1282: quietação da saída antes da folga (2º bloco pode vir depois).
      await vi.advanceTimersByTimeAsync(PASTE_QUIESCE_MS + PASTE_INGEST_GRACE_MS + 1);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
      );
      stubs.sessionState.mockReturnValue('busy');
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
      await vi.advanceTimersByTimeAsync(400);
      await pending;
      expect(stubs.writeSession).toHaveBeenCalledTimes(2);
      expect(stubs.dataTaps).toHaveLength(0);
    } finally {
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
      vi.useRealTimers();
    }
  });

  it('F-735: o UserPromptSubmit do Codex prova o aceite sem busy do PTY', async () => {
    vi.useFakeTimers();
    try {
      stubs.physicalSessionInfo.mockReturnValue({ adapterId: 'codex' });
      stubs.sessionState.mockReturnValue('idle');
      let result: boolean | undefined;
      const pending = deliverAgentPrompt('session-1', 'quick task', undefined, {
        adapterId: 'codex',
      });
      void pending.then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(500);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
      );

      stubs.turnStartSequence = 1;
      for (const tap of [...stubs.turnStartTaps]) tap({ sessionId: 'session-1', sequence: 1 });
      await vi.advanceTimersByTimeAsync(400);
      expect(result).toBe(true);
    } finally {
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
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
        expect.objectContaining({ markInputBusy: false }),
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
        '\r',
        expect.objectContaining({ markInputBusy: false }),
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
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1', {
        origin: 'tool-util:authority-revoked',
      });
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
        expect.objectContaining({ markInputBusy: false }),
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
      expect(stubs.terminateSession).toHaveBeenCalledWith('session-1', {
        origin: 'tool-util:authority-revoked',
      });
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

      await vi.advanceTimersByTimeAsync(31_000);
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

      await vi.advanceTimersByTimeAsync(31_000);
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
      await vi.advanceTimersByTimeAsync(31_000);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a Devin mission worker by pasting after boot, never native argv', async () => {
    vi.useFakeTimers();
    try {
      const onPromptAccepted = vi.fn();
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = true;
      stubs.readSessionOutput.mockReturnValue(DEVIN_COMPOSER_SCREEN);
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'running tools');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = spawnPaneAndMaybePrompt(
        {
          adapterId: 'devin',
          missionId: 'm1',
          role: 'worker',
          readOnly: true,
          prompt: 'Implemente o spawn do Devin.',
          scope,
          executionScope: taskExecutionScope,
        },
        { onPromptAccepted },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;

      const spawnCalls = stubs.requestPaneSpawn.mock.calls as unknown as Array<
        [{ initialPrompt?: string; adapterId?: string }]
      >;
      const spawnOptions = spawnCalls.at(-1)?.[0];
      expect(spawnOptions?.adapterId).toBe('devin');
      expect(spawnOptions?.initialPrompt).toBeUndefined();
      expect(stubs.waitForIdle).toHaveBeenCalledWith(
        'session-1',
        120_000,
        undefined,
      );
      expect(stubs.writeSession).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('Implemente o spawn do Devin.'),
        expect.objectContaining({ markInputBusy: false }),
      );
      expect(onPromptAccepted).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not paste a Devin brief into workspace trust; delivers after the composer', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = true;
      stubs.readSessionOutput.mockReturnValue(DEVIN_TRUST_SCREEN);
      cliPromptAutoResponder.bind('session-1', 'devin');
      expect(cliPromptAutoResponder.observe('session-1', DEVIN_TRUST_SCREEN)).toBe(
        '\r',
      );
      expect(cliPromptAutoResponder.shouldDeferInjection('session-1')).toBe(true);

      const pending = deliverAgentPrompt(
        'session-1',
        'build the feature',
        undefined,
        { adapterId: 'devin' },
      );

      await vi.advanceTimersByTimeAsync(200);
      expect(stubs.writeSession).not.toHaveBeenCalled();

      cliPromptAutoResponder.observe(
        'session-1',
        'Welcome to Devin\nAsk Devin to build features, fix bugs',
      );
      stubs.readSessionOutput.mockReturnValue(DEVIN_COMPOSER_SCREEN);
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'running tools');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBe(true);
      expect(stubs.writeSession).toHaveBeenCalledWith(
        'session-1',
        'build the feature',
        expect.objectContaining({ markInputBusy: false }),
      );
    } finally {
      cliPromptAutoResponder.clear();
      vi.useRealTimers();
    }
  });

  it('F-186: não cola briefing no menu de migração do Kimi; espera o composer real', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = true;
      stubs.readSessionOutput.mockReturnValue('Migrate from kimi-cli\nMigrate this data to kimi-code?\n❯ Migrate now\nAsk me later\nNever ask again\n↑/↓ move · ⏎ select · esc later\n│ > │');
      const pending = deliverAgentPrompt('session-1', 'revise o diff', undefined, { adapterId: 'kimi' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stubs.writeSession).not.toHaveBeenCalled();
      stubs.readSessionOutput.mockReturnValue(KIMI_COMPOSER_SCREEN);
      stubs.writeSession.mockImplementation(((sessionId: string, data: string) => {
        if (data === '\r') queueMicrotask(() => {
          stubs.sessionState.mockReturnValue('busy');
          for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
          for (const tap of [...stubs.dataTaps]) tap(sessionId, 'reviewing the diff');
        });
        return true;
      }) as typeof stubs.writeSession);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBe(true);
      expect(stubs.writeSession).toHaveBeenCalledWith('session-1', 'revise o diff', expect.objectContaining({ markInputBusy: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * F-956: produção roda o autoresponder no Worker de análise. O trust do
   * Kimi aceito no boot vira dois eventos no Main — a resposta e, com o resto
   * do quadro, a verificação — e o Worker para de publicar depois disso.
   * Nada de colar no diálogo; nada de segurar o composer pronto depois dele.
   */
  function acceptKimiTrustInAnalysisWorker(options: { readonly verify: boolean }): void {
    let seq = 0;
    const core = new PtyAnalysisCore([], (result) => {
      for (const event of result.events) {
        if (event.consumer !== 'prompt') continue;
        cliPromptAutoResponder.acceptWorker(
          'session-1',
          event.value as Parameters<typeof cliPromptAutoResponder.acceptWorker>[1],
          result.observedAt,
        );
      }
    });
    const feed = (body: object) => core.process({
      sessionId: 'session-1', generation: 1, workerEpoch: 1, eventSeq: ++seq, observedAt: Date.now(), ...body,
    } as Parameters<typeof core.process>[0]);
    feed({ kind: 'bind', binding: { adapterId: 'kimi' } });
    feed({ kind: 'arm', consumer: 'prompt', registration: 1 });
    feed({ kind: 'control', consumer: 'prompt', value: { bind: { adapterId: 'kimi', now: Date.now(), governed: true } } });
    feed({ kind: 'data', data: KIMI_TRUST_DIALOG_HEAD });
    vi.advanceTimersByTime(30);
    if (options.verify) feed({ kind: 'data', data: KIMI_TRUST_DIALOG_TAIL });
    core.close();
  }

  it('F-956: trust do Kimi aceito no Worker não trava a entrega no composer pronto do Kimi Code 2.1.1', async () => {
    vi.useFakeTimers();
    const status = vi.spyOn(analysisClient, 'status').mockReturnValue('active');
    const generation = vi.spyOn(analysisClient, 'generation').mockReturnValue(1);
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = true;
      acceptKimiTrustInAnalysisWorker({ verify: true });
      // A janela curta depois do aceite continua segurando a colagem.
      expect(cliPromptAutoResponder.shouldDeferInjection('session-1')).toBe(true);
      stubs.readSessionOutput.mockReturnValue(KIMI_211_COMPOSER_SCREEN);
      stubs.writeSession.mockImplementation(((sessionId: string, data: string) => {
        if (data === '\r') queueMicrotask(() => {
          stubs.sessionState.mockReturnValue('busy');
          for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
          for (const tap of [...stubs.dataTaps]) tap(sessionId, 'revisando o diff');
        });
        return true;
      }) as typeof stubs.writeSession);
      const pending = deliverAgentPrompt('session-1', 'revise o diff', undefined, { adapterId: 'kimi' });
      await vi.advanceTimersByTimeAsync(3_000);
      // Antes: o defer do settle ficava no cache por 180 s; 85 s depois o
      // pane era fechado com "Kimi composer did not become ready".
      expect(stubs.writeSession).toHaveBeenCalledWith('session-1', 'revise o diff', expect.objectContaining({ markInputBusy: false }));
      await expect(pending).resolves.toBe(true);
    } finally {
      cliPromptAutoResponder.drop('session-1');
      status.mockRestore();
      generation.mockRestore();
      vi.useRealTimers();
    }
  });

  /**
   * F-1411: o Kimi Code 2.1.1 (pi-tui) tem paste-burst: Enter que chega até
   * 120 ms depois de uma rajada de teclas cruas vira QUEBRA DE LINHA. Sonda em
   * PTY real (12/10, 18 KB/169 linhas): crus, o Kimi ingere a ~1,5 ms/byte
   * (28 s); o '\r' que o Nexus escreve 500 ms depois fica enfileirado atrás do
   * texto, cai na janela e vira linha vazia — tela idêntica à do campo
   * ("↑ 157 more", "No session yet", context 0%). Em bracketed paste o MESMO
   * Enter enfileirado envia e o turno começa ("● OK", context 4%).
   */
  it('F-1411: brief multilinha do Kimi Code 2.1.1 sai como bracketed paste e o turno começa', async () => {
    vi.useFakeTimers();
    try {
      stubs.physicalSessionInfo.mockReturnValue({ adapterId: 'kimi' });
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = true;
      stubs.readSessionOutput.mockReturnValue(KIMI_211_COMPOSER_SCREEN);
      stubs.writeSession.mockImplementation(((sessionId: string, data: string) => {
        if (data === '\r') queueMicrotask(() => {
          stubs.sessionState.mockReturnValue('busy');
          for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
          for (const tap of [...stubs.dataTaps]) tap(sessionId, 'turn started');
        });
        return true;
      }) as typeof stubs.writeSession);
      const brief = [
        ...Array.from({ length: 160 }, (_, i) => `linha ${i} de contexto injetado`),
        '',
        'Reutilize tokens e componentes existentes.',
      ].join('\n');
      const pending = deliverAgentPrompt('session-1', brief, undefined, { adapterId: 'kimi' });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(true);
      expect(stubs.writeSession).toHaveBeenCalledWith(
        'session-1',
        `\x1b[200~${brief}\x1b[201~`,
        expect.objectContaining({ markInputBusy: false }),
      );
    } finally {
      stubs.physicalSessionInfo.mockReset().mockReturnValue(null);
      vi.useRealTimers();
    }
  });

  it('F-956: trust do Kimi respondido sem prova de aceite segue segurando a colagem', async () => {
    vi.useFakeTimers();
    const status = vi.spyOn(analysisClient, 'status').mockReturnValue('active');
    const generation = vi.spyOn(analysisClient, 'generation').mockReturnValue(1);
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = true;
      // TUI muda depois do Enter: nada prova que o diálogo saiu da tela.
      acceptKimiTrustInAnalysisWorker({ verify: false });
      stubs.readSessionOutput.mockReturnValue(KIMI_211_COMPOSER_SCREEN);
      void deliverAgentPrompt('session-1', 'revise o diff', undefined, { adapterId: 'kimi' }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cliPromptAutoResponder.shouldDeferInjection('session-1')).toBe(true);
      expect(stubs.writeSession).not.toHaveBeenCalled();
    } finally {
      cliPromptAutoResponder.drop('session-1');
      status.mockRestore();
      generation.mockRestore();
      vi.useRealTimers();
    }
  });

  it('F-742: retomada do MiMo não cola o brief antes da TUI; espera o rodapé do composer', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = true;
      // 02/10: colado no boot, o brief caiu no aviso de bypass e o `\n` dele
      // confirmou "No, exit" — o MiMo saiu em 5 s.
      stubs.readSessionOutput.mockReturnValue(
        'Performing one time database migration, may take a few minutes...\n' +
          'Database migration complete.\n│\n▲  WARNING: Bypass Permissions mode\n' +
          '│  ● No, exit (recommended)\n│  ○ Yes, I accept the risks and want to skip permissions',
      );
      const pending = deliverAgentPrompt('session-1', 'retome a revisão', undefined, {
        adapterId: 'mimo-code',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stubs.writeSession).not.toHaveBeenCalled();
      stubs.readSessionOutput.mockReturnValue(
        '┃ \n Build · MiMo Auto (MiMo-V2.5)\n' +
          '   tab switch mode  ctrl+p settings     @ attach file  $ subagent  / commands',
      );
      stubs.writeSession.mockImplementation(((sessionId: string, data: string) => {
        if (data === '\r') queueMicrotask(() => {
          stubs.sessionState.mockReturnValue('busy');
          for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
          for (const tap of [...stubs.dataTaps]) tap(sessionId, 'revisando');
        });
        return true;
      }) as typeof stubs.writeSession);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBe(true);
      expect(stubs.writeSession).toHaveBeenCalledWith('session-1', 'retome a revisão', {
        markInputBusy: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-186: Kimi sem composer falha sem digitar nem aceitar migração', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.readSessionOutput.mockReturnValue('Migrate from kimi-cli\n│ > │');
      const pending = deliverAgentPrompt('session-1', 'não migrar', undefined, { adapterId: 'kimi' });
      const rejected = expect(pending).rejects.toThrow(/Kimi composer/);
      await vi.advanceTimersByTimeAsync(65_000);
      await rejected;
      expect(stubs.writeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-230: composer do Devin pintado com o PTY ainda busy espera a borda de idle e entrega', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('busy');
      stubs.injectable = true;
      stubs.readSessionOutput.mockReturnValue(DEVIN_COMPOSER_SCREEN);
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'running tools');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = deliverAgentPrompt(
        'session-1',
        'build the feature',
        undefined,
        { adapterId: 'devin' },
      );

      await vi.advanceTimersByTimeAsync(300);
      expect(stubs.writeSession).not.toHaveBeenCalled();

      stubs.sessionState.mockReturnValue('idle');
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toBe(true);
      expect(stubs.writeSession).toHaveBeenCalledWith(
        'session-1',
        'build the feature',
        expect.objectContaining({ markInputBusy: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-230: adapter sem regex de composer também espera o idle injetável', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('busy');
      stubs.injectable = true;
      stubs.writeSession.mockImplementation(
        ((sessionId: string, data: string) => {
          if (data === '\r') {
            queueMicrotask(() => {
              stubs.sessionState.mockReturnValue('busy');
              for (const tap of [...stubs.stateTaps]) tap(sessionId, 'busy');
              for (const tap of [...stubs.dataTaps]) {
                tap(sessionId, 'running tools');
              }
            });
          }
          return true;
        }) as typeof stubs.writeSession,
      );

      const pending = deliverAgentPrompt(
        'session-1',
        'build the feature',
        undefined,
        { adapterId: 'codex' },
      );

      await vi.advanceTimersByTimeAsync(500);
      expect(stubs.writeSession).not.toHaveBeenCalled();

      stubs.sessionState.mockReturnValue('idle');
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toBe(true);
      expect(stubs.writeSession).toHaveBeenCalledWith(
        'session-1',
        'build the feature',
        expect.objectContaining({ markInputBusy: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-230: sessão que sai durante a espera de idle falha com a cauda do PTY, sem colar', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('busy');
      stubs.injectable = true;
      stubs.readSessionOutput.mockReturnValue(DEVIN_COMPOSER_SCREEN);

      const pending = deliverAgentPrompt(
        'session-1',
        'build the feature',
        undefined,
        { adapterId: 'devin' },
      );
      const rejected = expect(pending).rejects.toThrow(/exited during boot/i);

      await vi.advanceTimersByTimeAsync(300);
      stubs.sessionState.mockReturnValue(null as unknown as string);
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(stubs.writeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never pastes a worker brief into a session that was already busy', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('busy');

      const pending = deliverAgentPrompt('session-1', 'do not interleave');
      const rejected = expect(pending).rejects.toThrow(/did not start/i);

      await vi.advanceTimersByTimeAsync(31_000);
      await rejected;

      expect(stubs.writeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never pastes a worker brief into an idle-looking permission prompt', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      stubs.injectable = false;

      const pending = deliverAgentPrompt('session-1', 'do not confirm');
      const rejected = expect(pending).rejects.toThrow(/did not start/i);

      await vi.advanceTimersByTimeAsync(31_000);
      await rejected;

      expect(stubs.writeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});


it('license denial never posts a spawn request', async () => {
  vi.mocked(requireAccess).mockReturnValue({ ok: false, reason: 'trial-ended' });
  await expect(spawnPaneAndMaybePrompt({ adapterId: 'codex', scope })).rejects.toMatchObject({ code: 'license_access_denied' });
  expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
});
