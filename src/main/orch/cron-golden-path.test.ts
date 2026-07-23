import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { CronJob } from './cron-loop';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-cron',
  projectId: 'project-cron',
  checkoutId: 'checkout-cron',
  rootRealPath: '/workspace/cron',
  identitySource: 'manifest',
};

const squad: Squad = {
  id: 'squad-cron',
  name: 'Cron Squad',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: 'Coordinate o plano selado.',
  agents: [
    {
      id: 'maestro',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'claude',
    },
    {
      id: 'builder',
      agentName: 'Builder',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
  ],
};

const stubs = vi.hoisted(() => ({
  resolveProjectExecutionScope: vi.fn(),
  resolveCwdForScope: vi.fn(),
  loadCronJobs: vi.fn((): CronJob[] => []),
  saveCronJobs: vi.fn(),
  getSquad: vi.fn(),
  listSquads: vi.fn(),
  resolveRuntime: vi.fn(),
  createMission: vi.fn(),
  updateMission: vi.fn(),
  bootstrap: vi.fn(),
}));

vi.mock('../persistence/project-identity', () => ({
  resolveProjectExecutionScope: stubs.resolveProjectExecutionScope,
}));

vi.mock('./workspace-path', () => ({
  resolveCwdForScope: stubs.resolveCwdForScope,
}));

vi.mock('./cron-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cron-loop')>();
  return {
    ...actual,
    loadCronJobs: stubs.loadCronJobs,
    saveCronJobs: stubs.saveCronJobs,
  };
});

vi.mock('./squad-store', () => ({
  getSquad: stubs.getSquad,
  listSquads: stubs.listSquads,
}));

vi.mock('./mission-orchestrator-runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./mission-orchestrator-runtime')>();
  return {
    ...actual,
    resolveProductionMissionOrchestratorRuntime: stubs.resolveRuntime,
  };
});

vi.mock('./mission-orchestrator-bootstrap', () => ({
  bootstrapMissionOrchestratorForScope: stubs.bootstrap,
}));

vi.mock('./cron-authority-auth', () => ({
  signCronAuthority: () => 'a'.repeat(64),
  verifyCronAuthority: (_payload: string, tag: string) =>
    tag === 'a'.repeat(64),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      create: stubs.createMission,
      update: stubs.updateMission,
    },
  }),
}));

import { issueCronExecutionAuthority } from './cron-execution-authority';
import { addCronJob, fireCronJob, updateCronJob } from './cron-runtime';

function baseJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron-authorized',
    name: 'Nightly build',
    schedule: '0 0 * * *',
    brief: 'Implemente a correção e entregue evidências verificáveis.',
    status: 'active',
    executionMode: 'local',
    workspacePath: scope.rootRealPath,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    agentName: 'Builder',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function exactConsent(
  grantedAt = 1_800_000_000_000,
  action: 'create' | 'update' = 'create',
) {
  return {
    exactUserConsent: {
      toolName: 'cron',
      action,
      grantedAt,
      receiptId: '00000000-0000-4000-8000-000000000001',
    },
  } as const;
}

function mission(id = 'mission-cron'): Mission {
  return {
    id,
    title: '⏰ Nightly build',
    description: 'scheduled mission',
    status: 'pending',
    squadId: squad.id,
    milestones: [],
    learnings: '',
    intentState: 'dispatched',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('cron sealed golden path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.resolveProjectExecutionScope.mockReturnValue(scope);
    stubs.resolveCwdForScope.mockImplementation(
      (_scope: ProjectExecutionScope, value?: string) =>
        value ?? scope.rootRealPath,
    );
    stubs.getSquad.mockImplementation((id: string) =>
      id === squad.id ? structuredClone(squad) : null,
    );
    stubs.listSquads.mockReturnValue([structuredClone(squad)]);
    stubs.resolveRuntime.mockReturnValue({
      adapterId: 'claude',
      model: 'claude-sonnet-4-5',
      readOnly: false,
      nativeReadOnly: true,
    });
    stubs.createMission.mockReturnValue(mission());
    stubs.updateMission.mockImplementation(
      (_id: string, patch: Partial<Mission>) => ({
        ...mission(),
        ...patch,
      }),
    );
    stubs.bootstrap.mockResolvedValue({
      ok: true,
      missionId: 'mission-cron',
      pane: {
        paneId: 'pane-cron',
        sessionId: 'session-cron',
        adapterId: 'claude',
        model: 'claude-sonnet-4-5',
        cwd: scope.rootRealPath,
        title: 'Cron Squad · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
      },
      kickoff: { accepted: true },
    });
  });

  it('keeps a legacy job fail-closed without manufacturing approval', async () => {
    await expect(fireCronJob(baseJob())).rejects.toThrow(
      /cron_execution_authority_missing.*recrie/i,
    );
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.bootstrap).not.toHaveBeenCalled();
  });

  it('launches an exactly consented job through the main-owned bootstrap', async () => {
    const raw = baseJob();
    const executionAuthority = issueCronExecutionAuthority(
      raw,
      scope,
      exactConsent().exactUserConsent,
    );

    await expect(
      fireCronJob({ ...raw, executionAuthority }),
    ).resolves.toBeUndefined();

    expect(stubs.createMission).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '⏰ Nightly build',
        squadId: squad.id,
        intentState: 'dispatched',
        intentVersion: 1,
        intentContract: expect.objectContaining({
          approvedAt: exactConsent().exactUserConsent.grantedAt,
          dispatchedAt: expect.any(Number),
          squadRevisionHash: executionAuthority.contract.squadRevisionHash,
          orchestratorRuntime: executionAuthority.contract.orchestratorRuntime,
          requiredWorkerAgentRef: 'builder',
        }),
      }),
    );
    expect(stubs.updateMission).toHaveBeenCalledWith('mission-cron', {
      status: 'running',
    });
    expect(stubs.bootstrap).toHaveBeenCalledWith(scope, 'mission-cron');
  });

  it('rejects a stale roster snapshot before creating a mission', async () => {
    const raw = baseJob();
    const executionAuthority = issueCronExecutionAuthority(
      raw,
      scope,
      exactConsent().exactUserConsent,
    );
    stubs.getSquad.mockReturnValue({
      ...structuredClone(squad),
      agents: squad.agents.map((agent) =>
        agent.id === 'builder' ? { ...agent, model: 'changed-model' } : agent,
      ),
    });

    await expect(
      fireCronJob({ ...raw, executionAuthority }),
    ).rejects.toThrow(/cron_execution_authority_stale.*squad/i);
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.bootstrap).not.toHaveBeenCalled();
  });

  it('rejects a definition changed outside an exact update transaction', async () => {
    const raw = baseJob();
    const executionAuthority = issueCronExecutionAuthority(
      raw,
      scope,
      exactConsent().exactUserConsent,
    );

    await expect(
      fireCronJob({
        ...raw,
        schedule: '5 0 * * *',
        executionAuthority,
      }),
    ).rejects.toThrow(/cron_execution_authority_stale.*definition/i);
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.bootstrap).not.toHaveBeenCalled();
  });

  it('rejects replaying one exact consent onto a cloned schedule identity', async () => {
    const raw = baseJob();
    const executionAuthority = issueCronExecutionAuthority(
      raw,
      scope,
      exactConsent().exactUserConsent,
    );

    await expect(
      fireCronJob({
        ...raw,
        id: 'cron-cloned-without-consent',
        executionAuthority,
      }),
    ).rejects.toThrow(/cron_execution_authority_stale.*identity|definition/i);
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.bootstrap).not.toHaveBeenCalled();
  });

  it('stores execution authority only when create carries exact user consent', async () => {
    const pending = baseJob({ id: 'will-be-generated' });
    stubs.loadCronJobs.mockReturnValue([]);

    await expect(
      addCronJob(
        {
          name: pending.name,
          schedule: pending.schedule,
          brief: pending.brief,
          executionMode: 'local',
          agentName: pending.agentName,
        },
        scope,
      ),
    ).rejects.toThrow(/cron_exact_consent_required/);
    expect(stubs.saveCronJobs).not.toHaveBeenCalled();

    const created = await addCronJob(
      {
        name: pending.name,
        schedule: pending.schedule,
        brief: pending.brief,
        executionMode: 'local',
        agentName: pending.agentName,
      },
      scope,
      exactConsent(),
    );
    expect(created.executionAuthority).toMatchObject({
      version: 2,
      origin: 'nexus-cron-exact-consent',
      authorizedAt: exactConsent().exactUserConsent.grantedAt,
      consentReceiptId: exactConsent().exactUserConsent.receiptId,
      consentAction: 'create',
    });
    expect(stubs.saveCronJobs).toHaveBeenCalledWith([
      expect.objectContaining({
        executionAuthority: created.executionAuthority,
      }),
    ]);
  });

  it('rebinds an existing authorized job to the exact approved update', async () => {
    const raw = baseJob();
    const executionAuthority = issueCronExecutionAuthority(
      raw,
      scope,
      exactConsent().exactUserConsent,
    );
    stubs.loadCronJobs.mockReturnValue([{ ...raw, executionAuthority }]);

    const updated = await updateCronJob(
      raw.id,
      { brief: 'Execute o novo brief aprovado e entregue o handoff.' },
      scope,
      exactConsent(1_800_000_000_123, 'update'),
    );

    expect(updated.executionAuthority).toMatchObject({
      authorizedAt: 1_800_000_000_123,
      contract: {
        approvedAt: 1_800_000_000_123,
        requiredWorkerAgentRef: 'builder',
      },
    });
    expect(updated.executionAuthority?.jobBindingHash).not.toBe(
      executionAuthority.jobBindingHash,
    );
    await expect(fireCronJob(updated)).resolves.toBeUndefined();
    expect(stubs.bootstrap).toHaveBeenCalledWith(scope, 'mission-cron');
  });

  it('does not silently reapprove a legacy job through a partial update', async () => {
    const legacy = baseJob();
    stubs.loadCronJobs.mockReturnValue([legacy]);

    await expect(
      updateCronJob(
        legacy.id,
        { status: 'paused' },
        scope,
        exactConsent(1_800_000_000_123, 'update'),
      ),
    ).rejects.toThrow(/cron_reapproval_required.*recrie/i);
    expect(stubs.saveCronJobs).not.toHaveBeenCalled();
  });

  it('keeps kickoff failure honest and never reports the occurrence launched', async () => {
    const raw = baseJob();
    const executionAuthority = issueCronExecutionAuthority(
      raw,
      scope,
      exactConsent().exactUserConsent,
    );
    stubs.bootstrap.mockResolvedValueOnce({
      ok: true,
      missionId: 'mission-cron',
      pane: {
        paneId: 'pane-cron',
        sessionId: 'session-cron',
        adapterId: 'claude',
        model: 'claude-sonnet-4-5',
        cwd: scope.rootRealPath,
        title: 'Cron Squad · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
      },
      kickoff: {
        accepted: false,
        reason: 'timeout',
        detail: 'idle→busy não observado',
        cta: 'Retomar missão',
      },
    });

    await expect(
      fireCronJob({ ...raw, executionAuthority }),
    ).rejects.toThrow(/cron_kickoff_not_accepted.*Retomar missão/i);
    // The main-owned bootstrap/kickoff path owns the detailed blocked state
    // and CTA. Cron preserves that result and fails the occurrence instead of
    // manufacturing a second terminal transition.
    expect(stubs.updateMission).toHaveBeenCalledTimes(1);
    expect(stubs.updateMission).toHaveBeenCalledWith('mission-cron', {
      status: 'running',
    });
  });
});
