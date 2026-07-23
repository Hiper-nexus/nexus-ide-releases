import { describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const cron = vi.hoisted(() => ({
  addCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  listCronJobs: vi.fn(() => [{ id: 'local-view' }]),
  syncCronJobsForScope: vi.fn(),
  updateCronJob: vi.fn(),
}));

vi.mock('./cron-runtime', () => cron);

import { buildDomainTools } from './tools-domain';

function context(): AgentGateContext {
  return {
    token: 'cron-observer',
    label: 'cron observer',
    role: 'orchestrator',
    missionId: 'mission-cron-observer',
    sessionId: 'session-cron-observer',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

describe('nexus_cron list authority', () => {
  it('is a read-only local snapshot and never reconciles persistent state', async () => {
    const tool = buildDomainTools().find(
      (candidate) => candidate.name === 'nexus_cron',
    );
    if (!tool) throw new Error('nexus_cron is not registered');
    const ctx = context();

    await expect(
      tool.handler(
        { action: 'list' },
        ctx,
        { assertCurrentAuthority: vi.fn() },
      ),
    ).resolves.toEqual([{ id: 'local-view' }]);

    expect(cron.listCronJobs).toHaveBeenCalledWith(ctx.scope);
    expect(cron.syncCronJobsForScope).not.toHaveBeenCalled();
    expect(cron.addCronJob).not.toHaveBeenCalled();
    expect(cron.updateCronJob).not.toHaveBeenCalled();
    expect(cron.deleteCronJob).not.toHaveBeenCalled();
  });
});
