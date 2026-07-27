import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { MissionPaneAuthoritySeal } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  mission: null as any,
  hasPlan: false,
  pane: null as any,
  live: null as any,
  gate: null as any,
  squad: { id: 'saved-squad' } as any,
  seal: null as MissionPaneAuthoritySeal | null,
  enqueue: vi.fn(),
  retry: vi.fn(),
  validate: vi.fn(),
  taskUpdate: vi.fn(),
  assertMutationAllowed: vi.fn(),
  listPersistedEvidenceIds: vi.fn(() => ['evidence-a']),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn(() => ({
    missions: { get: () => mocks.mission },
    tasks: {
      hasPlan: () => mocks.hasPlan,
      update: mocks.taskUpdate,
    },
    missionPanes: { findByPaneId: () => mocks.pane },
  })),
}));

vi.mock('../runtime/worktree-runtime-registry', () => ({
  requireWorktreeRuntimeRegistry: vi.fn(() => ({
    enqueue: mocks.enqueue,
    retry: mocks.retry,
  })),
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextKnowledgeService: vi.fn(),
  getContextWorkflowService: vi.fn(() => ({
    assertMutationAllowed: mocks.assertMutationAllowed,
    listPersistedEvidenceIds: mocks.listPersistedEvidenceIds,
  })),
}));

vi.mock('../context/merge-validation-coordinator', () => ({
  MergeValidationCoordinator: class {
    validate = mocks.validate;
  },
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: vi.fn(() => mocks.live),
  getSessionState: vi.fn(() => null),
}));

vi.mock('./gate', () => ({
  assertOrchestratorMission: vi.fn((ctx: any, missionId: string) => {
    if (ctx.role !== 'orchestrator' || ctx.missionId !== missionId) {
      throw new Error('only the mission orchestrator is authorized');
    }
  }),
  executionScopeFor: vi.fn((ctx: any) => ctx.executionScope ?? ctx.scope),
  getContextBySession: vi.fn(() => mocks.gate),
  releaseSession: vi.fn(),
  rotateContextRevisionAuthority: vi.fn(),
}));

vi.mock('./squad-store', () => ({
  getSquad: vi.fn(() => mocks.squad),
}));

vi.mock('./mission-pane-authority', () => ({
  resolveMissionPaneAuthoritySeal: vi.fn(() => mocks.seal),
  sameMissionPaneAuthoritySeal: vi.fn((left: unknown, right: unknown) =>
    Boolean(left && right && JSON.stringify(left) === JSON.stringify(right))),
}));

import { buildContextTools } from './tools-context';

const scope = testProjectScope({ checkoutId: 'manual-merge-authority' });
const ctx = {
  token: 'orchestrator-token',
  label: 'orchestrator',
  role: 'orchestrator' as const,
  sessionId: 'orchestrator-session',
  missionId: 'mission-merge',
  contextRevision: 'context-revision-a',
  scope,
  allowedTools: null,
  allowedSkills: null,
  stopAttempts: 0,
  handoffSubmitted: false,
};
const result = {
  taskKey: 'mission-merge:task-a',
  taskHeadSha: 'a'.repeat(40),
  integrationBaseSha: 'b'.repeat(40),
  candidateSha: 'c'.repeat(40),
  integratedSha: 'c'.repeat(40),
  diffHash: 'd'.repeat(64),
  evidenceIds: ['evidence-a'],
};

function tool(name: string) {
  const found = buildContextTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function installQueueAttempt(
  method: 'enqueue' | 'retry',
  pausePhase: 'candidate' | 'post-integration',
) {
  const started = deferred();
  const resume = deferred();
  mocks.validate.mockImplementation(async (context: { phase: string }) => {
    if (context.phase === pausePhase) {
      started.resolve();
      await resume.promise;
    }
    return { sensorsPassed: true, reviewPassed: true, evidenceIds: [] };
  });
  mocks[method].mockImplementation(async (input: any) => {
    input.assertCurrentAuthority();
    await input.validate({ phase: 'candidate' });
    input.assertCurrentAuthority();
    await input.validate({ phase: 'post-integration' });
    input.assertCurrentAuthority();
    await input.finalize(result);
    input.assertCurrentAuthority();
    return result;
  });
  return { started: started.promise, resume: resume.resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPlan = false;
  const contract = compileIntentContract({
    goal: 'Integrar somente sob a autoridade aprovada',
    intentVersion: 2,
  });
  mocks.mission = {
    id: 'mission-merge',
    title: 'Merge authority',
    description: contract.goal,
    status: 'running',
    squadId: 'saved-squad',
    milestones: [],
    learnings: '',
    intentState: 'dispatched',
    intentVersion: 2,
    intentContract: { ...contract, approvedAt: 1, dispatchedAt: 2 },
    orchestratorSessionId: 'orchestrator-session',
    createdAt: 1,
    updatedAt: 2,
  };
  mocks.seal = {
    intentVersion: 2,
    intentContractHash: 'a'.repeat(64),
    contextRevision: 'context-revision-a',
    contractHash: 'b'.repeat(64),
    squadRevisionHash: 'c'.repeat(64),
  };
  mocks.pane = {
    missionId: 'mission-merge',
    paneId: 'orchestrator-pane',
    role: 'orchestrator',
    authoritySeal: mocks.seal,
  };
  mocks.live = {
    sessionId: 'orchestrator-session',
    paneId: 'orchestrator-pane',
    role: 'orchestrator',
    missionId: 'mission-merge',
    scope,
  };
  mocks.gate = { ...ctx };
  mocks.taskUpdate.mockReturnValue({ id: 'task-a', status: 'done' });
});

describe('manual merge lifecycle authority', () => {
  it('wires mission revocation into candidate validation for nexus_merge_task', async () => {
    const attempt = installQueueAttempt('enqueue', 'candidate');
    const pending = tool('nexus_merge_task').handler({
      missionId: 'mission-merge',
      taskId: 'task-a',
    }, ctx);

    await attempt.started;
    mocks.mission = { ...mocks.mission, status: 'blocked' };
    attempt.resume();

    await expect(pending).rejects.toThrow(/merge authority revoked/i);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('wires mission revocation into post-integration validation for nexus_merge_retry', async () => {
    const attempt = installQueueAttempt('retry', 'post-integration');
    const pending = tool('nexus_merge_retry').handler({
      missionId: 'mission-merge',
      taskId: 'task-a',
      expectedStateRevision: 7,
    }, ctx);

    await attempt.started;
    mocks.mission = { ...mocks.mission, intentVersion: 3 };
    attempt.resume();

    await expect(pending).rejects.toThrow(/merge authority revoked/i);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('keeps both manual entry points outside a main-managed task plan', async () => {
    mocks.hasPlan = true;
    await expect(tool('nexus_merge_task').handler({
      missionId: 'mission-merge',
      taskId: 'task-a',
    }, ctx)).rejects.toThrow(/exclusivo do motor Nexus/i);
    await expect(tool('nexus_merge_retry').handler({
      missionId: 'mission-merge',
      taskId: 'task-a',
      expectedStateRevision: 7,
    }, ctx)).rejects.toThrow(/exclusivo do motor Nexus/i);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });
});
