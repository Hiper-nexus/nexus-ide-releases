/**
 * Indirection so real-mission main-owned completion can nudge the durable
 * scheduler without a static import cycle:
 *   lifecycle → main-owned → scheduler-production → lifecycle (lease ms)
 */

let tickImpl: (() => void) | null = null;
let reconcileImpl: (() => Promise<void>) | null = null;

export function setRealMissionE2ESchedulerTick(impl: (() => void) | null): void {
  tickImpl = impl;
}

export function setRealMissionE2ESchedulerReconcile(
  impl: (() => Promise<void>) | null,
): void {
  reconcileImpl = impl;
}

export function requestRealMissionE2ESchedulerTick(): void {
  tickImpl?.();
}

/** Await one full scheduler pass (merge + mission complete). */
export async function reconcileRealMissionE2EScheduler(): Promise<void> {
  if (reconcileImpl) {
    await reconcileImpl();
    return;
  }
  tickImpl?.();
}
