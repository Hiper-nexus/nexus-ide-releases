import { describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  applyDriveAction,
  type ApplyActionPorts,
} from './mission-driver-apply';
import { defaultDriveConfig, type DriveState } from './mission-drive';
import {
  runDriveTick,
  type DriveDeps,
  type DriveSnapshot,
} from './mission-driver-runtime';

const NOW = 1_000_000;

function baseState(overrides: Partial<DriveState> = {}): DriveState {
  return {
    missionId: 'm',
    missionStatus: 'running',
    lastProgressAt: NOW - 10_000,
    steps: [],
    trustedEvidenceReadyForCurrent: false,
    allStepsDone: false,
    completionVerified: false,
    contextRot: false,
    paneDead: false,
    accountFailed: false,
    iteration: 0,
    startedAt: NOW - 60_000,
    stallSignalCount: 0,
    ...overrides,
  };
}

const STALLED = baseState({
  missionId: 'm-stalled',
  lastProgressAt: NOW - defaultDriveConfig.stallMs - 60_000,
});
const FRESH = baseState({
  missionId: 'm-fresh',
  lastProgressAt: NOW - 10_000,
});

interface DepsOpts {
  scopes?: ReturnType<typeof testProjectScope>[];
  missionsByScope?: Map<string, { id: string }[]>;
  statesById?: Map<string, DriveState | null>;
  loadThrowsFor?: string;
  onDecisionThrowsFor?: string;
  listRunningThrowsFor?: string;
  driveSignalById?: Map<string, number>;
  iterationById?: Map<string, number>;
  lastActionById?: Map<string, number>;
  onDecision?: (s: DriveSnapshot) => void;
  onRecordSignal?: (missionId: string, at: number) => void;
  onFinishAttempt?: (
    missionId: string,
    outcome: 'success' | 'failed',
    error?: string,
  ) => void;
  applyPorts?: ApplyActionPorts;
  mode?: 'shadow' | 'active';
}

function makeDeps(opts: DepsOpts = {}): DriveDeps {
  const scopes = opts.scopes ?? [testProjectScope({ projectId: 'p1' })];
  const missions = opts.missionsByScope ?? new Map();
  const states = opts.statesById ?? new Map();
  const signalMemory = opts.driveSignalById ?? new Map<string, number>();
  const iterationMemory = opts.iterationById ?? new Map<string, number>();
  const lastActionMemory = opts.lastActionById ?? new Map<string, number>();
  return {
    listScopes: () => scopes,
    listRunningMissions: (sc) => {
      if (opts.listRunningThrowsFor === sc.projectId) {
        throw new Error('scope-boom');
      }
      return missions.get(sc.projectId) ?? [];
    },
    loadDriveState: (id) => {
      if (opts.loadThrowsFor === id) throw new Error('boom');
      return states.get(id) ?? null;
    },
    now: () => NOW,
    onDecision: async (s) => {
      if (opts.onDecisionThrowsFor === s.missionId) {
        throw new Error('onDecision-boom');
      }
      opts.onDecision?.(s);
    },
    getDriveSignalAt: (id) => signalMemory.get(id),
    recordDriveSignal: (id, _scope, at) => {
      signalMemory.set(id, at);
      opts.onRecordSignal?.(id, at);
    },
    getIteration: (id) => iterationMemory.get(id) ?? 0,
    reserveAttempt: (id, _scope, _actionKind, at) => {
      iterationMemory.set(id, (iterationMemory.get(id) ?? 0) + 1);
      lastActionMemory.set(id, at);
    },
    getLastActionAt: (id) => lastActionMemory.get(id),
    finishAttempt: (id, _scope, outcome, _at, error) => {
      opts.onFinishAttempt?.(id, outcome, error);
    },
    ...(opts.applyPorts ? { applyPorts: opts.applyPorts } : {}),
  };
}

function fakePorts(log: string[]): ApplyActionPorts {
  return {
    submitStalledHandoff: async (missionId) => {
      log.push(`stall:${missionId}`);
    },
    respawnFreshContext: async (missionId, _s, reason) => {
      log.push(`respawn:${missionId}:${reason}`);
    },
    reRoute: async (missionId, _s, reason) => {
      log.push(`reroute:${missionId}:${reason}`);
    },
    advanceStep: async (missionId, _s, stepId) => {
      log.push(`advance:${missionId}:${stepId}`);
    },
    setMissionStatus: async (missionId, _s, status) => {
      log.push(`status:${missionId}:${status}`);
    },
    completeMission: async (missionId) => {
      log.push(`complete:${missionId}`);
    },
    appendLearning: async (missionId, _s, entry) => {
      log.push(`learn:${missionId}:${entry.slice(0, 40)}`);
    },
  };
}

describe('runDriveTick', () => {
  it('itera missões running de cada scope e chama onDecision para cada', async () => {
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      scopes: [
        testProjectScope({ projectId: 'p1' }),
        testProjectScope({ projectId: 'p2' }),
      ],
      missionsByScope: new Map([
        ['p1', [{ id: 'm1' }]],
        ['p2', [{ id: 'm2' }]],
      ]),
      statesById: new Map([
        ['m1', baseState({ missionId: 'm1' })],
        ['m2', baseState({ missionId: 'm2' })],
      ]),
      onDecision: (s) => decisions.push(s),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.scanned).toBe(2);
    expect(result.loadNull).toBe(0);
    expect(result.loadErrors).toBe(0);
    expect(decisions.map((d) => d.missionId).sort()).toEqual(['m1', 'm2']);
  });

  it('decidedNonWait conta apenas non-wait (wait não conta)', async () => {
    const deps = makeDeps({
      missionsByScope: new Map([
        ['p1', [{ id: 'm-stalled' }, { id: 'm-fresh' }]],
      ]),
      statesById: new Map([
        ['m-stalled', STALLED],
        ['m-fresh', FRESH],
      ]),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.scanned).toBe(2);
    expect(result.decidedNonWait).toBe(1);
  });

  it('pula scopes sem missões running', async () => {
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      scopes: [
        testProjectScope({ projectId: 'p1' }),
        testProjectScope({ projectId: 'p-empty' }),
      ],
      missionsByScope: new Map([['p1', [{ id: 'm1' }]]]),
      statesById: new Map([['m1', baseState({ missionId: 'm1' })]]),
      onDecision: (s) => decisions.push(s),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.scanned).toBe(1);
    expect(decisions).toHaveLength(1);
  });

  it('loadDriveState null conta loadNull e é pulada sem onDecision', async () => {
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-gone' }, { id: 'm-ok' }]]]),
      statesById: new Map([
        ['m-gone', null],
        ['m-ok', baseState({ missionId: 'm-ok' })],
      ]),
      onDecision: (s) => decisions.push(s),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.scanned).toBe(2);
    expect(result.loadNull).toBe(1);
    expect(result.loadErrors).toBe(0);
    expect(decisions.map((d) => d.missionId)).toEqual(['m-ok']);
  });

  it('loadDriveState que throw conta loadErrors, loga em error e não aborta as demais', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-throw' }, { id: 'm-ok' }]]]),
      statesById: new Map([['m-ok', baseState({ missionId: 'm-ok' })]]),
      loadThrowsFor: 'm-throw',
      onDecision: (s) => decisions.push(s),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.scanned).toBe(2);
    expect(result.loadErrors).toBe(1);
    expect(decisions.map((d) => d.missionId)).toEqual(['m-ok']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('onDecision que rejeita (async) não aborta as demais missões', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-bad' }, { id: 'm-ok' }]]]),
      statesById: new Map([
        ['m-bad', baseState({ missionId: 'm-bad' })],
        ['m-ok', baseState({ missionId: 'm-ok' })],
      ]),
      onDecisionThrowsFor: 'm-bad',
      onDecision: (s) => decisions.push(s),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.scanned).toBe(2);
    expect(decisions.map((d) => d.missionId)).toEqual(['m-ok']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('listRunningMissions que throw num scope não aborta os demais scopes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      scopes: [
        testProjectScope({ projectId: 'p-bad' }),
        testProjectScope({ projectId: 'p-ok' }),
      ],
      missionsByScope: new Map([['p-ok', [{ id: 'm1' }]]]),
      statesById: new Map([['m1', baseState({ missionId: 'm1' })]]),
      listRunningThrowsFor: 'p-bad',
      onDecision: (s) => decisions.push(s),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.scanned).toBe(1);
    expect(decisions.map((d) => d.missionId)).toEqual(['m1']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('debounce próprio do drive: signal recente via getDriveSignalAt vira wait', async () => {
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      driveSignalById: new Map([['m-stalled', NOW - 60_000]]),
      onDecision: (s) => decisions.push(s),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(result.decidedNonWait).toBe(0);
    expect(decisions[0]?.action.kind).toBe('wait');
  });

  it('recordDriveSignal é chamado após signal-stall em shadow (e nunca após wait)', async () => {
    const recorded: { missionId: string; at: number }[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([
        ['p1', [{ id: 'm-stalled' }, { id: 'm-fresh' }]],
      ]),
      statesById: new Map([
        ['m-stalled', STALLED],
        ['m-fresh', FRESH],
      ]),
      onRecordSignal: (id, at) => recorded.push({ missionId: id, at }),
    });
    await runDriveTick(deps, { ...defaultDriveConfig, mode: 'shadow' });
    expect(recorded).toEqual([{ missionId: 'm-stalled', at: NOW }]);
  });

  it('active mode: recordDriveSignal só após apply bem-sucedido (não em applyError)', async () => {
    const recorded: { missionId: string; at: number }[] = [];
    const ports = fakePorts([]);
    ports.submitStalledHandoff = async () => {
      throw new Error('handoff boom');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      applyPorts: ports,
      onRecordSignal: (id, at) => recorded.push({ missionId: id, at }),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'active',
    });
    expect(result.applyErrors).toBe(1);
    expect(recorded).toEqual([]);
    warn.mockRestore();
  });

  it('config override com stallMs menor faz uma missão "fresca" virar signal-stall', async () => {
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-ish' }]]]),
      statesById: new Map([
        [
          'm-ish',
          baseState({
            missionId: 'm-ish',
            lastProgressAt: NOW - 10_000,
          }),
        ],
      ]),
      onDecision: (s) => decisions.push(s),
    });
    const shrunk = {
      ...defaultDriveConfig,
      stallMs: 5_000,
      stallResignalMs: 60_000,
      mode: 'shadow' as const,
    };
    const result = await runDriveTick(deps, shrunk);
    expect(result.decidedNonWait).toBe(1);
    expect(decisions[0]?.action.kind).toBe('signal-stall');
  });

  it('usa now() injetado para a decisão (default config, shadow)', async () => {
    const decisions: DriveSnapshot[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      onDecision: (s) => decisions.push(s),
    });
    await runDriveTick(deps, { ...defaultDriveConfig, mode: 'shadow' });
    expect(decisions[0]?.action.kind).toBe('signal-stall');
  });

  it('active mode: aplica signal-stall via ports e conta applied; shadow não aplica', async () => {
    const log: string[] = [];
    const activeDeps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      applyPorts: fakePorts(log),
    });
    const activeResult = await runDriveTick(activeDeps, {
      ...defaultDriveConfig,
      mode: 'active',
    });
    expect(activeResult.decidedNonWait).toBe(1);
    expect(activeResult.applied).toBe(1);
    expect(log).toContain('stall:m-stalled');

    const shadowLog: string[] = [];
    const shadowDeps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      applyPorts: fakePorts(shadowLog),
    });
    const shadowResult = await runDriveTick(shadowDeps, {
      ...defaultDriveConfig,
      mode: 'shadow',
    });
    expect(shadowResult.applied).toBe(0);
    expect(shadowLog).toEqual([]);
  });

  it('active mode: reserva budget antes de aplicar advance', async () => {
    const log: string[] = [];
    const iterationById = new Map<string, number>();
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-adv' }]]]),
      statesById: new Map([
        [
          'm-adv',
          baseState({
            missionId: 'm-adv',
            lastProgressAt: NOW - 1_000,
            currentStepId: 's1',
            trustedEvidenceReadyForCurrent: true,
            steps: [
              {
                id: 's1',
                label: 'A',
                status: 'in-progress',
                evidenceIds: ['e1'],
                trustedEvidenceReady: true,
              },
            ],
          }),
        ],
      ]),
      applyPorts: fakePorts(log),
      iterationById,
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'active',
    });
    expect(result.applied).toBe(1);
    expect(log).toContain('advance:m-adv:s1');
    expect(iterationById.get('m-adv')).toBe(1);
  });

  it('active mode: budget exhausted aplica block-human (setStatus blocked)', async () => {
    const log: string[] = [];
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-budget' }]]]),
      statesById: new Map([
        [
          'm-budget',
          baseState({
            missionId: 'm-budget',
            lastProgressAt: NOW - 1_000,
            iteration: defaultDriveConfig.maxIterations,
          }),
        ],
      ]),
      applyPorts: fakePorts(log),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'active',
    });
    expect(result.applied).toBe(1);
    expect(log.some((line) => line.startsWith('status:m-budget:blocked'))).toBe(
      true,
    );
  });

  it('active mode: apply que throw conta applyErrors e não aborta', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    const ports = fakePorts(log);
    const outcomes: Array<{ id: string; outcome: string; error?: string }> = [];
    ports.advanceStep = async () => {
      throw new Error('untrusted');
    };
    const deps = makeDeps({
      missionsByScope: new Map([
        ['p1', [{ id: 'm-bad' }, { id: 'm-ok' }]],
      ]),
      statesById: new Map([
        [
          'm-bad',
          baseState({
            missionId: 'm-bad',
            lastProgressAt: NOW - 1_000,
            currentStepId: 's1',
            trustedEvidenceReadyForCurrent: true,
          }),
        ],
        [
          'm-ok',
          baseState({
            missionId: 'm-ok',
            lastProgressAt: NOW - 1_000,
            allStepsDone: true,
            completionVerified: true,
            steps: [
              {
                id: 's1',
                label: 'A',
                status: 'done',
                evidenceIds: ['e1'],
                trustedEvidenceReady: true,
              },
            ],
          }),
        ],
      ]),
      applyPorts: ports,
      onFinishAttempt: (id, outcome, error) =>
        outcomes.push({ id, outcome, ...(error ? { error } : {}) }),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'active',
    });
    expect(result.applyErrors).toBe(1);
    expect(result.applied).toBe(1);
    expect(log).toContain('complete:m-ok');
    expect(outcomes).toContainEqual({
      id: 'm-bad',
      outcome: 'failed',
      error: 'untrusted',
    });
    warn.mockRestore();
  });

  it('active mode sem applyPorts conta applyErrors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'active',
    });
    expect(result.applyErrors).toBe(1);
    expect(result.applied).toBe(0);
    error.mockRestore();
  });

  it('active mode: exponential backoff skips apply until lastActionAt window elapses', async () => {
    const log: string[] = [];
    const lastActionById = new Map<string, number>([
      // last action was 500ms ago; iteration 3 → backoff 8s → must wait
      ['m-stalled', NOW - 500],
    ]);
    const iterationById = new Map<string, number>([['m-stalled', 3]]);
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      applyPorts: fakePorts(log),
      lastActionById,
      iterationById,
    });
    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'active',
      baseBackoffMs: 1_000,
    });
    expect(result.decidedNonWait).toBe(0);
    expect(result.applied).toBe(0);
    expect(log).toEqual([]);
  });

  it('active mode: records lastActionAt when reserving the attempt', async () => {
    const log: string[] = [];
    const lastActionById = new Map<string, number>();
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      applyPorts: fakePorts(log),
      lastActionById,
    });
    await runDriveTick(deps, { ...defaultDriveConfig, mode: 'active' });
    expect(log).toContain('stall:m-stalled');
    expect(lastActionById.get('m-stalled')).toBe(NOW);
  });

  it('active mode: failed apply still consumes one iteration of budget', async () => {
    const iterationById = new Map<string, number>();
    const ports = fakePorts([]);
    ports.submitStalledHandoff = async () => {
      throw new Error('delivery failed');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      missionsByScope: new Map([['p1', [{ id: 'm-stalled' }]]]),
      statesById: new Map([['m-stalled', STALLED]]),
      iterationById,
      applyPorts: ports,
    });

    const result = await runDriveTick(deps, {
      ...defaultDriveConfig,
      mode: 'active',
    });

    expect(result.applyErrors).toBe(1);
    expect(iterationById.get('m-stalled')).toBe(1);
    warn.mockRestore();
  });
});

describe('applyDriveAction', () => {
  const scope = testProjectScope({ projectId: 'p1' });

  it('wait não aplica efeito', async () => {
    const log: string[] = [];
    const result = await applyDriveAction(
      {
        missionId: 'm1',
        scope,
        action: { kind: 'wait', reason: 'ok' },
      },
      fakePorts(log),
    );
    expect(result).toEqual({ applied: false, kind: 'wait' });
    expect(log).toEqual([]);
  });

  it('signal-stall só chama submitStalledHandoff (nunca kill)', async () => {
    const log: string[] = [];
    const result = await applyDriveAction(
      {
        missionId: 'm1',
        scope,
        action: {
          kind: 'signal-stall',
          reason: 'silent',
          silentForMs: 600_000,
        },
      },
      fakePorts(log),
    );
    expect(result.applied).toBe(true);
    expect(log).toEqual(['stall:m1']);
  });

  it('complete chama completeMission port', async () => {
    const log: string[] = [];
    await applyDriveAction(
      {
        missionId: 'm1',
        scope,
        action: { kind: 'complete', reason: 'all done' },
      },
      fakePorts(log),
    );
    expect(log).toContain('complete:m1');
  });

  it('advance rejeitado pelo port propaga erro (fail-closed)', async () => {
    const ports = fakePorts([]);
    ports.advanceStep = async () => {
      throw new Error('advance rejected: evidence not nexus-trusted');
    };
    await expect(
      applyDriveAction(
        {
          missionId: 'm1',
          scope,
          action: {
            kind: 'advance',
            reason: 'ready',
            stepId: 's1',
          },
        },
        ports,
      ),
    ).rejects.toThrow(/nexus-trusted/);
  });
});
