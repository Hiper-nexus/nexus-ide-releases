import {
  hasCurrentApprovedDispatchContract,
  type MissionIntentContract,
} from './mission-intent';

export const TERMINAL_OPERATIONAL_FAILURE_MARKER =
  '[NEXUS_FAILURE:terminal]';

export function hasTerminalOperationalFailureMarker(value: string): boolean {
  return value.includes(TERMINAL_OPERATIONAL_FAILURE_MARKER);
}

interface RecoverableMission {
  readonly status: string;
  readonly intentState?: string;
  readonly description?: string;
  readonly intentVersion?: number | null;
  readonly intentContract?: MissionIntentContract | null;
}

const AUTOMATIC_RECOVERY_INTENT_STATES = new Set([
  'blocked_technical',
  // Persisted pre-normalization pairs produced by older launch failures.
  'dispatched',
  'executing',
  'validating',
]);

/**
 * Exact durable condition owned by the automatic bootstrap recovery loop.
 * A technical-looking legacy row without current approval is a human stop,
 * not work that the UI may promise will resume by itself.
 */
export function hasAutomaticTechnicalRecovery(
  mission: RecoverableMission,
): boolean {
  return (
    mission.status === 'blocked' &&
    AUTOMATIC_RECOVERY_INTENT_STATES.has(mission.intentState ?? '') &&
    hasCurrentApprovedDispatchContract(mission) &&
    !hasTerminalOperationalFailureMarker(mission.description ?? '')
  );
}
