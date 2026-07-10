import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from './cron-loop';

const stubs = vi.hoisted(() => ({
  resolveWorkspaceCwd: vi.fn<(value?: string) => string>(),
  loadCronJobs: vi.fn((): CronJob[] => []),
  saveCronJobs: vi.fn(),
  createMission: vi.fn(() => ({ id: 'mission-1' })),
  spawnPane: vi.fn(async () => ({})),
}));

vi.mock('./workspace-path', () => ({
  resolveWorkspaceCwd: stubs.resolveWorkspaceCwd,
}));

vi.mock('./cron-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cron-loop')>();
  return {
    ...actual,
    loadCronJobs: stubs.loadCronJobs,
    saveCronJobs: stubs.saveCronJobs,
  };
});

vi.mock('./mission-store', () => ({
  createMission: stubs.createMission,
}));

vi.mock('./tool-util', () => ({
  spawnPaneAndMaybePrompt: stubs.spawnPane,
}));

vi.mock('./squad-store', () => ({
  getSquad: vi.fn(),
  findAgent: vi.fn(() => ({
    agent: {
      agentName: 'qa',
      category: 'worker',
      cli: 'codex',
      model: '',
    },
  })),
}));

import { addCronJob, fireCronJob } from './cron-runtime';

function cronJob(workspacePath?: string): CronJob {
  return {
    id: 'cron-1',
    name: 'nightly',
    schedule: '0 0 * * *',
    brief: 'run tests',
    status: 'active',
    workspacePath,
    agentName: 'qa',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('cron workspace confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.loadCronJobs.mockReturnValue([]);
    stubs.resolveWorkspaceCwd.mockReturnValue('/workspace');
  });

  it('pins a newly created job to the canonical active workspace', () => {
    const created = addCronJob({
      name: 'nightly',
      schedule: '0 0 * * *',
      brief: 'run tests',
      agentName: 'qa',
    });

    expect(stubs.resolveWorkspaceCwd).toHaveBeenCalledWith(undefined);
    expect(created.workspacePath).toBe('/workspace');
    expect(stubs.saveCronJobs).toHaveBeenCalledOnce();
  });

  it('does not persist a job when its workspace is invalid', () => {
    stubs.resolveWorkspaceCwd.mockImplementation(() => {
      throw new Error('cwd escapes workspace');
    });

    expect(() =>
      addCronJob({
        name: 'escape',
        schedule: '0 0 * * *',
        brief: 'read home',
        workspacePath: '/Users/example',
        agentName: 'qa',
      }),
    ).toThrow(/escapes workspace/);
    expect(stubs.saveCronJobs).not.toHaveBeenCalled();
  });

  it('revalidates legacy jobs before creating a mission or spawning', async () => {
    stubs.resolveWorkspaceCwd.mockImplementation(() => {
      throw new Error('no workspace open');
    });

    await expect(fireCronJob(cronJob(undefined))).rejects.toThrow(
      /no workspace open/,
    );
    expect(stubs.createMission).not.toHaveBeenCalled();
    expect(stubs.spawnPane).not.toHaveBeenCalled();
  });
});
