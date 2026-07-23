import { describe, expect, it, vi } from 'vitest';
import {
  buildMissionSchedulerTaskPrompt,
  MISSION_SCHEDULER_WORKER_LEASE_POLICY,
  missionAccountQuotaScores,
  missionSchedulerHasKickoffAuthority,
  projectTerminalMergeFailure,
  reconcileInterruptedWorktreeReservationFailuresForScope,
  reconcileTerminalMergeFailureForScope,
  validateMissionMergeWithLifecycleFence,
} from './mission-scheduler-production';
import {
  runBoundedMissionSchedulerPass,
} from './mission-scheduler-concurrency';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER,
} from '../runtime/worktree-manager';

describe('mission scheduler worker lease contract', () => {
  it('does not serialize an independent scope behind a slow reconciliation', async () => {
    let releaseSlowScope!: () => void;
    const slowScopeGate = new Promise<void>((resolve) => {
      releaseSlowScope = resolve;
    });
    const reconciled = new Set<string>();
    const startedMissions: string[] = [];

    const pass = runBoundedMissionSchedulerPass({
      scopes: ['slow', 'fast'],
      scopeConcurrency: 2,
      missionConcurrency: 2,
      reconcileScope: async (scope) => {
        if (scope === 'slow') await slowScopeGate;
        reconciled.add(scope);
      },
      listMissions: (scope) => [`${scope}-one`, `${scope}-two`],
      runMission: async (scope, mission) => {
        expect(reconciled.has(scope)).toBe(true);
        startedMissions.push(mission);
      },
    });

    await vi.waitFor(() => {
      expect(startedMissions).toEqual(['fast-one', 'fast-two']);
    });
    expect(startedMissions).not.toContain('slow-one');

    releaseSlowScope();
    await pass;
    expect(startedMissions).toEqual([
      'fast-one',
      'fast-two',
      'slow-one',
      'slow-two',
    ]);
  });

  it('enforces explicit scope and per-scope mission concurrency limits', async () => {
    let releaseScopes!: () => void;
    const scopeGate = new Promise<void>((resolve) => {
      releaseScopes = resolve;
    });
    const reconcilingScopes: string[] = [];

    const scopePass = runBoundedMissionSchedulerPass({
      scopes: ['one', 'two', 'three'],
      scopeConcurrency: 2,
      missionConcurrency: 2,
      reconcileScope: async (scope) => {
        reconcilingScopes.push(scope);
        await scopeGate;
      },
      listMissions: () => [],
      runMission: async () => undefined,
    });

    await vi.waitFor(() => {
      expect(reconcilingScopes).toEqual(['one', 'two']);
    });
    releaseScopes();
    await scopePass;
    expect(reconcilingScopes).toEqual(['one', 'two', 'three']);

    let releaseMissions!: () => void;
    const missionGate = new Promise<void>((resolve) => {
      releaseMissions = resolve;
    });
    const startedMissions: string[] = [];
    const missionPass = runBoundedMissionSchedulerPass({
      scopes: ['scope'],
      scopeConcurrency: 1,
      missionConcurrency: 2,
      reconcileScope: async () => undefined,
      listMissions: () => ['one', 'two', 'three', 'four'],
      runMission: async (_scope, mission) => {
        startedMissions.push(mission);
        await missionGate;
      },
    });

    await vi.waitFor(() => {
      expect(startedMissions).toEqual(['one', 'two']);
    });
    releaseMissions();
    await missionPass;
    expect(startedMissions).toEqual(['one', 'two', 'three', 'four']);
  });

  it('builds account-only quota scores for the selected adapter', () => {
    const scores = missionAccountQuotaScores('claude', [
      {
        id: 'claude:work',
        adapterId: 'claude',
        accountId: 'work',
        label: 'Work',
        installed: true,
        onCooldown: false,
        windows: [
          {
            kind: 'session',
            label: 'Sessão',
            usedRatio: 0.8,
            source: 'provider-api',
            confidence: 'high',
          },
        ],
        updatedAt: 1,
      },
      {
        id: 'claude:unknown',
        adapterId: 'claude',
        accountId: 'unknown',
        label: 'Unknown',
        installed: true,
        onCooldown: false,
        windows: [
          {
            kind: 'weekly',
            label: 'Semanal',
            usedRatio: null,
            source: 'unknown',
            confidence: 'low',
          },
        ],
        updatedAt: 1,
      },
      {
        id: 'codex:other',
        adapterId: 'codex',
        accountId: 'other',
        label: 'Other',
        installed: true,
        onCooldown: false,
        windows: [],
        updatedAt: 1,
      },
    ]);

    expect([...scores.keys()]).toEqual(['work', 'unknown']);
    expect(scores.get('work')).toBeCloseTo(0.2);
    expect(scores.get('unknown')).toBe(0.55);
  });

  it('leaves a bounded margin between the requested heartbeat and claim expiry', () => {
    expect(MISSION_SCHEDULER_WORKER_LEASE_POLICY).toEqual({
      claimLeaseMs: 10 * 60_000,
      heartbeatIntervalMs: 4 * 60_000,
    });
    expect(
      MISSION_SCHEDULER_WORKER_LEASE_POLICY.heartbeatIntervalMs,
    ).toBeLessThan(
      MISSION_SCHEDULER_WORKER_LEASE_POLICY.claimLeaseMs,
    );

    const prompt = buildMissionSchedulerTaskPrompt(
      {
        id: 'task-heartbeat',
        status: 'pending',
        dependsOn: [],
        ownership: {
          files: ['src/main/orch/task-dispatch-lifecycle.ts'],
          symbols: [],
          domains: ['orchestration'],
        },
        merged: false,
        parallelEligible: true,
      },
      {
        agentName: 'worker-orch',
        category: 'implementation',
        executionMode: 'isolated_worktree',
      },
    );

    expect(prompt).toContain(
      'nexus_worker_heartbeat no máximo a cada 4 minutos',
    );
  });

  it('holds dispatch until the durable kickoff receipt is current', () => {
    const missions = {
      hasCurrentKickoffAcceptance: () => false,
    };
    expect(
      missionSchedulerHasKickoffAuthority(missions, 'mission-a'),
    ).toBe(false);

    missions.hasCurrentKickoffAcceptance = () => true;
    expect(
      missionSchedulerHasKickoffAuthority(missions, 'mission-a'),
    ).toBe(true);
  });

  it('rechecks lifecycle after paused validation before any merge/receipt effect', async () => {
    let authorized = true;
    let resumeValidation!: () => void;
    const pausedValidation = new Promise<void>((resolve) => {
      resumeValidation = resolve;
    });
    const integrate = vi.fn();
    const complete = vi.fn();
    const persistReceipt = vi.fn();

    const pipeline = validateMissionMergeWithLifecycleFence({
      assertCurrentAuthority: () => {
        if (!authorized) {
          throw new Error('mission lifecycle authority revoked');
        }
      },
      validate: async () => {
        await pausedValidation;
        return { approved: true };
      },
    }).then((result) => {
      integrate(result);
      complete(result);
      persistReceipt(result);
    });

    authorized = false;
    resumeValidation();

    await expect(pipeline).rejects.toThrow(/authority revoked/i);
    expect(integrate).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(persistReceipt).not.toHaveBeenCalled();
  });

  it('projects a runtime merge failure through the current dispatch CAS', () => {
    const blockMergeFailureByCoordinator = vi.fn(() => ({
      state: 'blocked',
    }));
    const dispatches = {
      get: vi.fn(() => ({
        taskId: 'task-runtime',
        missionId: 'mission-runtime',
        state: 'merging',
        revision: 7,
      })),
      blockMergeFailureByCoordinator,
    };

    expect(projectTerminalMergeFailure({
      missionId: 'mission-runtime',
      taskId: 'task-runtime',
      reason: 'A validação obrigatória não existe para esta execução.',
    }, dispatches as never)).toBe(true);
    expect(blockMergeFailureByCoordinator).toHaveBeenCalledWith({
      taskId: 'task-runtime',
      revision: 7,
      reason: expect.stringMatching(/validação obrigatória/i),
    });
  });

  it('projects a blocked-interrupted merge on restart through the scheduler reconciler', () => {
    const scope = testProjectScope();
    const blockMergeFailureByCoordinator = vi.fn(() => ({
      state: 'blocked',
    }));
    const dispatches = {
      get: vi.fn(() => ({
        taskId: 'task-restart',
        missionId: 'mission-restart',
        state: 'merging',
        revision: 11,
      })),
      blockMergeFailureByCoordinator,
    };
    const registry = {
      reconcile: vi.fn(() => ({
        action: 'blocked-interrupted',
        taskKey: 'task-key-restart',
        block: {
          taskKey: 'task-key-restart',
          errorName: 'MergeInterruptedError',
          reason: 'merge interrompido durante post-validating',
          blockedAt: 10,
        },
      })),
      mergeSnapshot: vi.fn(() => ({
        revision: 2,
        activeTaskKey: null,
        blocked: {
          taskKey: 'task-key-restart',
          errorName: 'MergeInterruptedError',
          reason: 'merge interrompido durante post-validating',
          blockedAt: 10,
        },
        events: [],
        entries: [{
          id: 'merge-task-key-restart',
          taskKey: 'task-key-restart',
          missionId: 'mission-restart',
          taskId: 'task-restart',
          attempt: 1,
          status: 'blocked',
          evidenceIds: [],
          createdAt: 1,
          updatedAt: 10,
        }],
      })),
    };

    expect(reconcileTerminalMergeFailureForScope(scope, {
      registry: registry as never,
      getDispatches: () => dispatches as never,
    })).toBe(true);
    expect(blockMergeFailureByCoordinator).toHaveBeenCalledWith({
      taskId: 'task-restart',
      revision: 11,
      reason: expect.stringMatching(/merge interrompido durante post-validating/i),
    });
  });

  it('projects a failed interrupted worktree reservation before its lease expires', () => {
    const scope = testProjectScope();
    const blockWorktreeCreationFailureByCoordinator = vi.fn(() => ({
      state: 'blocked',
    }));
    const dispatches = {
      get: vi.fn(() => ({
        taskId: 'task-reserved-restart',
        missionId: 'mission-reserved-restart',
        state: 'blocked',
        revision: 4,
      })),
      list: vi.fn(() => [{
        taskId: 'task-reserved-restart',
        missionId: 'mission-reserved-restart',
        state: 'claimed',
        revision: 3,
      }]),
      blockWorktreeCreationFailureByCoordinator,
    };
    const registry = {
      get: vi.fn(() => ({
        taskId: 'task-reserved-restart',
        missionId: 'mission-reserved-restart',
        status: 'failed',
        failureReason:
          `${INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER} ` +
          'linked worktree identity was ambiguous',
      })),
    };

    expect(reconcileInterruptedWorktreeReservationFailuresForScope(scope, {
      registry: registry as never,
      getDispatches: () => dispatches as never,
    })).toBe(1);
    expect(blockWorktreeCreationFailureByCoordinator).toHaveBeenCalledWith({
      taskId: 'task-reserved-restart',
      revision: 3,
      reason: expect.stringMatching(/após restart.*ambiguous/i),
    });
  });
});
