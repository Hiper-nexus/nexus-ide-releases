import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  REAL_MISSION_E2E_SQUAD_ID,
  REAL_MISSION_E2E_WORKER_ID,
  createRealMissionE2EPlanTasks,
  createRealMissionE2ESquadFixture,
} from '../shared/real-mission-e2e';
import { snapshotSquadAuthority } from './orch/squad-authority-snapshot';
import { compileIntentContract } from '../shared/mission-intent';
import type { ProjectDomainStoreSuite } from './orch/project-domain-store-registry';
import type { AgentGateContext } from './orch/gate';

const getContextBySession = vi.fn();
const planMissionTasks = vi.fn();

vi.mock('./orch/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orch/gate')>();
  return {
    ...actual,
    getContextBySession: (...args: unknown[]) => getContextBySession(...args),
  };
});

vi.mock('./orch/mission-task-plan-authority', () => ({
  planMissionTasks: (...args: unknown[]) => planMissionTasks(...args),
}));

import { sealRealMissionE2EPlanIfNeeded } from './real-mission-e2e-plan';

const scope = {
  installationId: 'install',
  projectId: 'project',
  checkoutId: 'checkout',
  rootRealPath: '/tmp/e2e',
} as AgentGateContext['scope'];

function orchContext(missionId: string): AgentGateContext {
  return {
    token: 'tok',
    label: 'E2E Orquestrador',
    role: 'orchestrator',
    sessionId: 'pty-orch',
    missionId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function suiteHarness(options: {
  mission?: Record<string, unknown> | null;
  planned?: readonly unknown[];
  tasks?: readonly unknown[];
  kickoffAccepted?: boolean;
}) {
  const squad = createRealMissionE2ESquadFixture();
  const contract = compileIntentContract({
    goal: 'e2e',
    intentVersion: 1,
  });
  const mission =
    options.mission === null
      ? null
      : (options.mission ?? {
          id: 'mission-e2e',
          status: 'running',
          squadId: REAL_MISSION_E2E_SQUAD_ID,
          intentVersion: 1,
          orchestratorSessionId: 'pty-orch',
          intentContract: {
            ...contract,
            approvedAt: 1,
            dispatchedAt: 1,
            squadRevisionHash: snapshotSquadAuthority(squad).hash,
          },
        });

  return {
    missions: {
      get: vi.fn(() => mission),
      hasCurrentKickoffAcceptance: vi.fn(
        () => options.kickoffAccepted ?? true,
      ),
    },
    tasks: {
      list: vi.fn(() => options.tasks ?? []),
      listPlannedTasks: vi.fn(() => options.planned ?? []),
      createPlanAtomically: vi.fn(),
    },
  } as unknown as Pick<ProjectDomainStoreSuite, 'missions' | 'tasks'>;
}

describe('sealRealMissionE2EPlanIfNeeded', () => {
  beforeEach(() => {
    getContextBySession.mockReset();
    planMissionTasks.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('seals the canonical plan through planMissionTasks when kickoff is accepted', () => {
    const suite = suiteHarness({});
    getContextBySession.mockReturnValue(orchContext('mission-e2e'));
    planMissionTasks.mockReturnValue({ missionId: 'mission-e2e', tasks: [] });

    const result = sealRealMissionE2EPlanIfNeeded(suite, 'mission-e2e');

    expect(result).toEqual({ sealed: true, reason: 'sealed' });
    expect(planMissionTasks).toHaveBeenCalledOnce();
    const [args, ctx] = planMissionTasks.mock.calls[0]!;
    expect(args).toMatchObject({
      action: 'plan',
      missionId: 'mission-e2e',
    });
    expect(args.tasks[0]).toMatchObject({
      id: 'resultado-worker',
      agentRef: REAL_MISSION_E2E_WORKER_ID,
      category: 'executor',
      executionMode: 'isolated_worktree',
      ownership: { files: ['resultado.txt'] },
    });
    expect(ctx.role).toBe('orchestrator');
    expect(ctx.sessionId).toBe('pty-orch');
  });

  it('is idempotent when a plan already exists', () => {
    const suite = suiteHarness({ planned: [{ taskId: 'task-1' }] });
    const result = sealRealMissionE2EPlanIfNeeded(suite, 'mission-e2e');
    expect(result).toEqual({ sealed: false, reason: 'already-sealed' });
    expect(planMissionTasks).not.toHaveBeenCalled();
  });

  it('waits for kickoff acceptance', () => {
    const suite = suiteHarness({ kickoffAccepted: false });
    const result = sealRealMissionE2EPlanIfNeeded(suite, 'mission-e2e');
    expect(result).toEqual({ sealed: false, reason: 'kickoff-pending' });
    expect(planMissionTasks).not.toHaveBeenCalled();
  });

  it('exposes the same rows as the shared plan fixture', () => {
    const tasks = createRealMissionE2EPlanTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agentRef).toBe(REAL_MISSION_E2E_WORKER_ID);
    expect(tasks[0]?.ownership.files).toEqual(['resultado.txt']);
  });
});
