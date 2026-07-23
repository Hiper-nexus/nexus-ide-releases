/**
 * Indirection so real-mission main-owned completion can nudge the durable
 * scheduler without a static import cycle:
 *   lifecycle → main-owned → scheduler-production → lifecycle (lease ms)
 */

let tickImpl: (() => void) | null = null;

export function setRealMissionE2ESchedulerTick(impl: (() => void) | null): void {
  tickImpl = impl;
}

export function requestRealMissionE2ESchedulerTick(): void {
  tickImpl?.();
}
