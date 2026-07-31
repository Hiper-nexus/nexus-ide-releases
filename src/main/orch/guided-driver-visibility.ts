import type { ProjectExecutionScope } from '../../shared/types';
import { emitDriverDecision } from './mission-event-emit';

/**
 * Guided delivery completion is driver-owned: once step receipts exist, the
 * mission driver is the sole authority that flips the mission to done. With
 * the driver disabled (missionDriverActiveMode !== true) a guided delivery
 * mission runs to the end and then silently never completes. Surface that at
 * mission start, loudly and exactly once per mission, without touching the
 * driver authority itself.
 */

const warnedMissions = new Set<string>();

function warningKey(
  scope: ProjectExecutionScope,
  missionId: string,
): string {
  return `${scope.projectId}:${scope.checkoutId}:${missionId}`;
}

export function warnGuidedDeliveryDriverInactive(
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  const key = warningKey(scope, missionId);
  if (warnedMissions.has(key)) return;
  warnedMissions.add(key);
  const reason =
    'Missão guiada de delivery aprovada com o mission driver desativado: a ' +
    'conclusão (status=done) pertence ao driver. Ative missionDriverActiveMode ' +
    'nas configurações ou a missão executa até o fim sem nunca concluir.';
  console.warn(`[mission-driver] ${reason} mission=${missionId}`);
  emitDriverDecision(
    scope,
    missionId,
    'driver_inactive_guided_delivery',
    reason,
    'shadow',
    'driver-inactive',
  );
}

/** Test hook: forget which missions already warned. */
export function resetGuidedDeliveryDriverInactiveWarnings(): void {
  warnedMissions.clear();
}
