import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REAL_MISSION_E2E_PLANNER_TASK_ID,
  REAL_MISSION_E2E_RESULT_CONTENT,
  REAL_MISSION_E2E_RESULT_FILE,
  REAL_MISSION_E2E_SQUAD_ID,
  REAL_MISSION_E2E_WORKER_ID,
  REAL_MISSION_E2E_WORKER_NAME,
} from '../shared/real-mission-e2e';

const isCurrentProcessRealMissionE2E = vi.fn(() => true);
const requestMissionSchedulerTick = vi.fn();
const requireWorktreeRuntimeRegistry = vi.fn();

vi.mock('../shared/real-mission-e2e', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/real-mission-e2e')>();
  return {
    ...actual,
    isCurrentProcessRealMissionE2E: () => isCurrentProcessRealMissionE2E(),
  };
});

vi.mock('./orch/mission-scheduler-production', () => ({
  requestMissionSchedulerTick: () => requestMissionSchedulerTick(),
}));

vi.mock('./runtime/worktree-runtime-registry', () => ({
  requireWorktreeRuntimeRegistry: () => requireWorktreeRuntimeRegistry(),
}));

import { advanceRealMissionE2EMainOwnedChain } from './real-mission-e2e-main-owned';

const scope = {
  installationId: 'install',
  projectId: 'project',
  checkoutId: 'checkout',
  rootRealPath: '/tmp/e2e-root',
};

function makeWorktree(worktreePath: string) {
  return {
    get: vi.fn(() => ({
      status: 'ready',
      worktreePath,
      missionId: 'mission-e2e',
      taskId: REAL_MISSION_E2E_PLANNER_TASK_ID,
    })),
  };
}

function suiteHarness(options: {
  mission?: Record<string, unknown> | null;
  dispatches?: readonly Record<string, unknown>[];
  handoffs?: Array<Record<string, unknown>>;
  kickoffAccepted?: boolean;
}) {
  const handoffs = [...(options.handoffs ?? [])];
  const submit = vi.fn((input: Record<string, unknown>) => {
    const handoff = {
      id: 'handoff-main',
      status: 'success',
      deliveryState: 'queued',
      sessionId: input.sessionId,
      workerIncarnationId: input.workerIncarnationId,
      ...input,
    };
    handoffs.push(handoff);
    return handoff;
  });
  const acceptHandoff = vi.fn(() => ({ state: 'handoff_ready' }));
  const reserveDeliveryAttempt = vi.fn(() => ({ id: 'attempt-1' }));
  const markDeliveryAttemptPasted = vi.fn();
  const acceptDeliveryAttempt = vi.fn(() => true);

  return {
    suite: {
      scope,
      missions: {
        get: vi.fn(() =>
          options.mission === null
            ? null
            : (options.mission ?? {
                id: 'mission-e2e',
                status: 'running',
                squadId: REAL_MISSION_E2E_SQUAD_ID,
                orchestratorSessionId: 'orch-session',
              }),
        ),
        hasCurrentKickoffAcceptance: vi.fn(
          () => options.kickoffAccepted ?? true,
        ),
      },
      taskDispatches: {
        list: vi.fn(() => options.dispatches ?? []),
        acceptHandoff,
      },
      handoffs: {
        list: vi.fn(() => handoffs),
        submit,
        reserveDeliveryAttempt,
        markDeliveryAttemptPasted,
        acceptDeliveryAttempt,
      },
    } as never,
    submit,
    acceptHandoff,
    reserveDeliveryAttempt,
    markDeliveryAttemptPasted,
    acceptDeliveryAttempt,
  };
}

describe('advanceRealMissionE2EMainOwnedChain', () => {
  let worktreePath = '';

  beforeEach(() => {
    isCurrentProcessRealMissionE2E.mockReturnValue(true);
    requestMissionSchedulerTick.mockReset();
    worktreePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-main-owned-wt-'),
    );
    // Minimal git repo so commit works.
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    spawnSync('git', ['init', '--quiet'], { cwd: worktreePath });
    spawnSync('git', ['config', 'user.name', 'E2E'], { cwd: worktreePath });
    spawnSync('git', ['config', 'user.email', 'e2e@test'], {
      cwd: worktreePath,
    });
    spawnSync('git', ['config', 'commit.gpgSign', 'false'], {
      cwd: worktreePath,
    });
    fs.writeFileSync(path.join(worktreePath, 'README.md'), 'base\n');
    spawnSync('git', ['add', '.'], { cwd: worktreePath });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: worktreePath });
    requireWorktreeRuntimeRegistry.mockReturnValue(makeWorktree(worktreePath));
  });

  afterEach(() => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('no-ops outside the real-mission process flag', () => {
    isCurrentProcessRealMissionE2E.mockReturnValue(false);
    const { suite } = suiteHarness({});
    expect(advanceRealMissionE2EMainOwnedChain(suite, 'mission-e2e', scope)).toEqual({
      advanced: false,
      reason: 'not-e2e-process',
    });
  });

  it('writes the exact result, submits handoff, and accepts dispatch', () => {
    const { suite, submit, acceptHandoff } = suiteHarness({
      dispatches: [
        {
          state: 'running',
          agentRef: REAL_MISSION_E2E_WORKER_ID,
          taskId: REAL_MISSION_E2E_PLANNER_TASK_ID,
          sessionId: 'worker-session',
          workerIncarnationId: 'inc-1',
          handoffId: null,
        },
      ],
    });

    const result = advanceRealMissionE2EMainOwnedChain(
      suite,
      'mission-e2e',
      scope,
    );

    expect(result).toEqual({
      advanced: true,
      reason: 'worker-handoff-accepted',
    });
    expect(
      fs.readFileSync(path.join(worktreePath, REAL_MISSION_E2E_RESULT_FILE), 'utf8'),
    ).toBe(REAL_MISSION_E2E_RESULT_CONTENT);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        sessionId: 'worker-session',
        workerIncarnationId: 'inc-1',
        fromAgent: REAL_MISSION_E2E_WORKER_NAME,
      }),
    );
    expect(acceptHandoff).toHaveBeenCalledWith({
      sessionId: 'worker-session',
      workerIncarnationId: 'inc-1',
      handoffId: 'handoff-main',
    });
    expect(requestMissionSchedulerTick).toHaveBeenCalled();
  });

  it('main-accepts queued handoff delivery without orchestrator TUI', () => {
    const { suite, reserveDeliveryAttempt, acceptDeliveryAttempt } =
      suiteHarness({
        dispatches: [
          {
            state: 'handoff_ready',
            agentRef: REAL_MISSION_E2E_WORKER_ID,
            taskId: REAL_MISSION_E2E_PLANNER_TASK_ID,
            sessionId: 'worker-session',
            workerIncarnationId: 'inc-1',
            handoffId: 'handoff-existing',
          },
        ],
        handoffs: [
          {
            id: 'handoff-existing',
            status: 'success',
            deliveryState: 'queued',
            sessionId: 'worker-session',
            workerIncarnationId: 'inc-1',
          },
        ],
      });

    const result = advanceRealMissionE2EMainOwnedChain(
      suite,
      'mission-e2e',
      scope,
    );

    expect(result).toEqual({ advanced: true, reason: 'delivery-accepted' });
    expect(reserveDeliveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffId: 'handoff-existing',
        orchestratorSessionId: 'orch-session',
      }),
    );
    expect(acceptDeliveryAttempt).toHaveBeenCalled();
    expect(requestMissionSchedulerTick).toHaveBeenCalled();
  });
});
