import type { ProjectExecutionScope } from '../../shared/types';
import type { ScopedHandoffStore } from '../orch/handoff-store';
import type { PeriodicTaskContext } from '../observability/periodic-task';
import { getWorkspaceMemoryStore, type RetainResult } from './workspace-memory';
import { retainAcceptedHandoffMemoryDistilledBestEffort, retainAcknowledgedHandoffMemoryBestEffort } from './trusted-memory';

/** Replay only Main-accepted evidence; report text still crosses the existing Jev barrier. */
export async function backfillWorkspaceMemory(scope: ProjectExecutionScope, handoffs: ScopedHandoffStore,
  ctx: PeriodicTaskContext): Promise<void> {
  ctx.assertCurrent();
  const store = getWorkspaceMemoryStore(scope);
  const cursorKey = `backfill:handoffs:v1:${scope.checkoutId}`;
  const cursor = Number(store.getMeta(cursorKey) ?? '0');
  const page = handoffs.memoryBackfillPage(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
  if (page.scope.projectId !== scope.projectId || page.scope.checkoutId !== scope.checkoutId ||
    page.scope.installationId !== scope.installationId || page.scope.rootRealPath !== scope.rootRealPath) {
    throw new Error('memory backfill scope mismatch');
  }
  for (const { handoff, accepted } of page.items) {
    const key = `handoff:v1:${scope.checkoutId}:${handoff.id}`;
    if (store.isBackfillDone(key)) continue;
    if (store.latestActiveWithLine('trusted:accepted-handoff', `Reference: ${handoff.id}`)) {
      store.markBackfillDone([key]);
      continue;
    }
    ctx.assertCurrent();
    const provenance = handoff.mcpProvenance ? { mcpReceiptId: handoff.mcpProvenance.receiptId } : {};
    let skipped: string | undefined;
    const deps = { signal: ctx.signal, onSkip: (reason: string) => { skipped = reason; } };
    let retained: RetainResult | null;
    if (accepted) {
      retained = await ctx.wait(retainAcceptedHandoffMemoryDistilledBestEffort(scope, {
        ...accepted, handoffId: handoff.id, status: 'success', ...provenance,
        ...(handoff.evidenceTrust === 'nexus-trusted' && handoff.evidenceBinding
          ? { evidenceIds: handoff.evidenceIds.slice(0, 32), evidenceBinding: handoff.evidenceBinding } : {}),
      }, handoff.summary, deps));
    } else {
      retained = await ctx.wait(retainAcknowledgedHandoffMemoryBestEffort(scope, {
        handoffId: handoff.id, status: 'success', ...provenance,
        ...(handoff.missionId ? { missionId: handoff.missionId } : {}),
      }, handoff.summary, deps));
    }
    ctx.assertCurrent();
    // A generic store failure has neither retained content nor an explicit Jev
    // skip/queued retry. Keep the cursor unchanged so a later pass retries it.
    if (!retained && !skipped) return;
    // Retryable skips already persist in memory_retention_pending before returning.
    // Nonretryable Jev rejection is a completed, explicit retention decision.
    store.markBackfillDone([key]);
    await ctx.checkpoint();
  }
  ctx.assertCurrent();
  store.setMeta(cursorKey, String(page.scanned < 4 ? 0 : page.cursor));
}
