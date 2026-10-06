import { afterEach, expect, it, vi } from 'vitest';
import { acquireHeavyCommandPermit, heavyCommandPermitSnapshot } from './heavy-command-permit';
import { AGENT_PANE_FOOTPRINT_MB, admitAgentSpawnSync, readPaneAdmissionLimits, primeSystemMemoryCacheForTest, registerAgentMemoryCensus } from './pane-admission';
import { testProjectScope } from './__tests__/scope-fixture';

const request = () => ({ scope: testProjectScope(), missionId: 'mission', sessionId: 'worker', kind: 'typescript' as const });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); primeSystemMemoryCacheForTest(null); });

// The integration contract holds for either conservative or tuned job sizes;
// exercise the production pool's actual reservation without pinning its policy.
async function productionReserveMB(): Promise<number> {
  primeSystemMemoryCacheForTest({ freeMB: 64_000, swapUsedMB: 0 });
  const permit = await acquireHeavyCommandPermit(request());
  try { return heavyCommandPermitSnapshot().reservedMB; }
  finally { permit.release(); }
}

it('the production pool cannot spend RAM reserved for an agent still starting', async () => {
  vi.useFakeTimers();
  const reserveMB = await productionReserveMB();
  let live = 0;
  const unregister = registerAgentMemoryCensus(() => ({ live, pending: live }), 'test');
  const limits = readPaneAdmissionLimits();
  primeSystemMemoryCacheForTest({ freeMB: limits.minFreeMB + reserveMB + AGENT_PANE_FOOTPRINT_MB / 2, swapUsedMB: 0 });
  live = 1;
  let admitted = false;
  const controller = new AbortController();
  const waiting = acquireHeavyCommandPermit({ ...request(), signal: controller.signal }).then(permit => { admitted = true; return permit; });
  try {
    await Promise.resolve();
    expect(admitted).toBe(false);
    live = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    (await waiting).release();
    expect(admitted).toBe(true);
  } finally {
    controller.abort();
    await waiting.then(permit => permit.release(), () => {});
    unregister();
  }
});

it('a heavy permit also reserves RAM against the next automatic agent in the same sample', async () => {
  vi.useFakeTimers();
  vi.stubEnv('NEXUS_PANE_GUARD', '');
  const reserveMB = await productionReserveMB();
  const limits = readPaneAdmissionLimits();
  primeSystemMemoryCacheForTest({ freeMB: limits.minFreeMB + reserveMB + AGENT_PANE_FOOTPRINT_MB - 1, swapUsedMB: 0 });
  const permit = await acquireHeavyCommandPermit(request());
  try {
    expect(admitAgentSpawnSync(0, Date.now(), {}, { automaticWorker: true })).toMatchObject({ ok: false, reason: 'memory' });
    expect(admitAgentSpawnSync(0, Date.now(), {}).ok).toBe(true);
    expect(admitAgentSpawnSync(0, Date.now(), { NEXUS_PANE_GUARD: 'off' }, { automaticWorker: true }).ok).toBe(true);
    permit.release();
    expect(admitAgentSpawnSync(0, Date.now(), {}, { automaticWorker: true }).ok).toBe(true);
  } finally { permit.release(); }
});
