import type { ProjectExecutionScope } from '../../shared/types';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import type { ProjectDomainStoreRegistry, ProjectDomainStoreSuite } from '../orch/project-domain-store-registry';
import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { maintainWorkspaceMemory } from './workspace-memory-maintenance';
import { backfillWorkspaceMemory } from './workspace-memory-backfill';
import { retryPendingMemoryRetentions } from './trusted-memory';

export interface WorkspaceMemoryService { stop(): Promise<void> }
export const MEMORY_MAINTENANCE_CADENCE_MS = 60_000;

/** Registry starts this in production. No filesystem/DB scan runs on its caller's turn. */
export function startWorkspaceMemoryService(registry: ProjectDomainStoreRegistry): WorkspaceMemoryService {
  const controller = new AbortController();
  const suites = new Map<string, ProjectDomainStoreSuite>();
  const pending = new Set<ReturnType<typeof setImmediate>>();
  const run = async (scope: ProjectExecutionScope, suite: ProjectDomainStoreSuite) => {
    if (controller.signal.aborted || !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)) return;
    try {
      await runPeriodicTask(`memory-maintenance:${scope.projectId}`, async (ctx) => {
        await maintainWorkspaceMemory(scope, ctx);
        ctx.assertCurrent();
        await ctx.wait(retryPendingMemoryRetentions(scope, { signal: ctx.signal }));
        ctx.assertCurrent();
        await backfillWorkspaceMemory(scope, suite.handoffs, ctx);
      }, { signal: controller.signal, timeoutMs: 30_000, sliceMs: 10, cadenceMs: MEMORY_MAINTENANCE_CADENCE_MS });
    } catch {
      // Auxiliary memory unavailable/cancelled: never block domain registration or the operator.
    }
  };
  const unsubscribe = registry.onScope((scope, suite) => {
    suites.set(`${scope.projectId}\0${scope.checkoutId}`, suite);
    const immediate = setImmediate(() => { pending.delete(immediate); void run(scope, suite); });
    pending.add(immediate); immediate.unref();
  });
  let cursor = 0;
  const timer = setInterval(() => {
    const candidates = [...suites.values()];
    if (!candidates.length) return;
    const suite = candidates[cursor++ % candidates.length]!;
    void run(suite.scope, suite);
  }, MEMORY_MAINTENANCE_CADENCE_MS);
  timer.unref();
  return {
    async stop() {
      unsubscribe(); clearInterval(timer); controller.abort();
      for (const immediate of pending) clearImmediate(immediate);
      pending.clear();
      await Promise.all([...new Set([...suites.values()].map((suite) => suite.scope.projectId))]
        .map((projectId) => stopPeriodicTask(`memory-maintenance:${projectId}`)));
      suites.clear();
    },
  };
}
