import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { CronJob } from './cron-loop';

const stubs = vi.hoisted(() => ({
  resolveWorkspaceCwd: vi.fn<(value?: string) => string>(),
  resolveCwdForScope:
    vi.fn<(_scope: ProjectExecutionScope, value?: string) => string>(),
  resolveProjectExecutionScope:
    vi.fn<(_workspacePath: string) => ProjectExecutionScope>(),
  loadCronJobs: vi.fn((): CronJob[] => []),
  saveCronJobs: vi.fn(),
  createMission: vi.fn(() => ({ id: 'mission-1' })),
  setMissionStatus: vi.fn(),
  bootstrap: vi.fn(),
  getSquad: vi.fn(),
  listSquads: vi.fn(),
  resolveRuntime: vi.fn(),
}));

vi.mock('./workspace-path', () => ({
  resolveWorkspaceCwd: stubs.resolveWorkspaceCwd,
  resolveCwdForScope: stubs.resolveCwdForScope,
}));

vi.mock('../persistence/project-identity', () => ({
  resolveProjectExecutionScope: stubs.resolveProjectExecutionScope,
}));

vi.mock('./cron-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cron-loop')>();
  return {
    ...actual,
    loadCronJobs: stubs.loadCronJobs,
    saveCronJobs: stubs.saveCronJobs,
  };
});

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      create: stubs.createMission,
      setStatus: stubs.setMissionStatus,
    },
  }),
}));

vi.mock('./mission-orchestrator-bootstrap', () => ({
  bootstrapMissionOrchestratorForScope: stubs.bootstrap,
}));

vi.mock('./cron-authority-auth', () => ({
  signCronAuthority: () => 'a'.repeat(64),
  verifyCronAuthority: (_payload: string, tag: string) =>
    tag === 'a'.repeat(64),
}));

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

import {
  addCronJob,
  deleteCronJob,
  fireCronJob,
  listCronJobs,
} from './cron-runtime';

const scopeA: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-local',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
};

const savedSquad: Squad = {
  id: 'squad-workspace',
  name: 'Workspace Squad',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: 'Coordene o plano selado.',
  agents: [
    {
      id: 'orchestrator',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'claude',
    },
    {
      id: 'qa',
      agentName: 'qa',
      category: 'executor',
      cli: 'codex',
    },
  ],
};

function exactCronConsent(action: 'create' | 'update' | 'delete') {
  return {
    exactUserConsent: {
      toolName: 'cron',
      action,
      grantedAt: 1_800_000_000_000,
      receiptId: '00000000-0000-4000-8000-000000000001',
    },
  } as const;
}

function cronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron-1',
    name: 'nightly',
    schedule: '0 0 * * *',
    brief: 'run tests',
    status: 'active',
    executionMode: 'local',
    workspacePath: '/workspace/a',
    projectId: scopeA.projectId,
    checkoutId: scopeA.checkoutId,
    agentName: 'qa',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('cron workspace confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.loadCronJobs.mockReturnValue([]);
    stubs.resolveWorkspaceCwd.mockReturnValue('/workspace/b');
    stubs.resolveCwdForScope.mockImplementation((scope, value) =>
      value === 'packages/api'
        ? `${scope.rootRealPath}/packages/api`
        : value ?? scope.rootRealPath,
    );
    stubs.resolveProjectExecutionScope.mockReturnValue(scopeA);
    stubs.getSquad.mockImplementation((id: string) =>
      id === savedSquad.id ? structuredClone(savedSquad) : null,
    );
    stubs.listSquads.mockReturnValue([structuredClone(savedSquad)]);
    stubs.resolveRuntime.mockReturnValue({
      adapterId: 'claude',
      model: 'claude-sonnet-4-5',
      readOnly: false,
      nativeReadOnly: true,
    });
  });

  it('does not create the default shared job without a configured backend', async () => {
    await expect(addCronJob({
      name: 'nightly',
      schedule: '0 0 * * *',
      brief: 'run tests',
      agentName: 'qa',
    }, scopeA)).rejects.toThrow(/backend is not configured/);

    expect(stubs.resolveCwdForScope).toHaveBeenCalledWith(scopeA, undefined);
    expect(stubs.resolveWorkspaceCwd).not.toHaveBeenCalled();
    expect(stubs.saveCronJobs).not.toHaveBeenCalled();
  });

  it('does not persist a job when its workspace is invalid', async () => {
    stubs.resolveCwdForScope.mockImplementation(() => {
      throw new Error('cwd escapes workspace');
    });

    await expect(
      addCronJob({
        name: 'escape',
        schedule: '0 0 * * *',
        brief: 'read home',
        workspacePath: '/Users/example',
        agentName: 'qa',
      }, scopeA),
    ).rejects.toThrow(/escapes workspace/);
    expect(stubs.saveCronJobs).not.toHaveBeenCalled();
  });

  it('stores a nested cwd separately from the project identity root', async () => {
    const created = await addCronJob({
      name: 'api nightly',
      schedule: '0 0 * * *',
      brief: 'run api tests',
      workspacePath: 'packages/api',
      executionMode: 'local',
      agentName: 'qa',
    }, scopeA, exactCronConsent('create'));

    expect(created).toMatchObject({
      workspacePath: '/workspace/a',
      workingDirectory: '/workspace/a/packages/api',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
    });
  });

  it('stores local execution only when it is explicitly requested', async () => {
    const created = await addCronJob({
      name: 'device cleanup',
      schedule: '0 0 * * *',
      brief: 'clean local cache',
      executionMode: 'local',
      agentName: 'qa',
    }, scopeA, exactCronConsent('create'));

    expect(created.executionMode).toBe('local');
  });

  it('fails closed for a legacy job without a recorded workspace', async () => {
    await expect(
      fireCronJob(cronJob({ workspacePath: undefined })),
    ).rejects.toThrow(/job sem workspace registrado/);
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.bootstrap).not.toHaveBeenCalled();
  });

  it('fails closed instead of bypassing the golden mission path', async () => {
    await expect(fireCronJob(cronJob())).rejects.toThrow(
      /cron_execution_authority_missing/i,
    );

    expect(stubs.resolveWorkspaceCwd).not.toHaveBeenCalled();
    expect(stubs.resolveProjectExecutionScope).toHaveBeenCalledWith('/workspace/a');
    expect(stubs.resolveCwdForScope).toHaveBeenCalledWith(scopeA, undefined);
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.bootstrap).not.toHaveBeenCalled();
  });

  it('validates the recorded nested cwd but still refuses raw spawn', async () => {
    const workingDirectory = '/workspace/a/packages/api';
    stubs.resolveCwdForScope.mockReturnValue(workingDirectory);

    await expect(
      fireCronJob(cronJob({ workingDirectory })),
    ).rejects.toThrow(/cron_execution_authority_missing/i);

    expect(stubs.resolveCwdForScope).toHaveBeenCalledWith(
      scopeA,
      workingDirectory,
    );
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.bootstrap).not.toHaveBeenCalled();
  });

  it('hides and protects jobs from another checkout', async () => {
    const own = cronJob();
    const foreign = cronJob({
      id: 'cron-foreign',
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      workspacePath: '/workspace/b',
    });
    stubs.loadCronJobs.mockReturnValue([own, foreign]);

    expect(listCronJobs(scopeA)).toEqual([own]);
    await expect(
      deleteCronJob(foreign.id, scopeA, exactCronConsent('delete')),
    ).resolves.toBe(false);
    expect(stubs.saveCronJobs).not.toHaveBeenCalled();
  });

  it('refuses direct deletion without the exact one-shot cron consent receipt', async () => {
    const own = cronJob();
    stubs.loadCronJobs.mockReturnValue([own]);

    await expect(deleteCronJob(own.id, scopeA)).rejects.toThrow(
      /cron_exact_consent_required/i,
    );
    expect(stubs.saveCronJobs).not.toHaveBeenCalled();
  });

  it('deletes only the caller-scoped job when another checkout has the same id', async () => {
    const own = cronJob({ id: 'cron-collision' });
    const foreign = cronJob({
      id: own.id,
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      workspacePath: '/workspace/b',
    });
    stubs.loadCronJobs.mockReturnValue([foreign, own]);

    await expect(
      deleteCronJob(own.id, scopeA, exactCronConsent('delete')),
    ).resolves.toBe(true);
    expect(stubs.saveCronJobs).toHaveBeenCalledWith([foreign]);
  });

  it('keeps legacy jobs manageable only when their path resolves to the caller scope', async () => {
    const legacy = cronJob({ projectId: undefined, checkoutId: undefined });
    stubs.loadCronJobs.mockReturnValue([legacy]);

    expect(listCronJobs(scopeA)).toEqual([legacy]);
    expect(stubs.resolveProjectExecutionScope).toHaveBeenCalledWith(
      '/workspace/a',
      scopeA.installationId,
    );
    await expect(
      deleteCronJob(legacy.id, scopeA, exactCronConsent('delete')),
    ).resolves.toBe(true);
  });
});
