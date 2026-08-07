import type { Mission } from '../../shared/orch-types';

/**
 * Raw pane input is delivery-only. Durable clarify consumption is the sole
 * authority that may unpark a blocked_user mission through MissionEngine.
 */

/** True once the operator submits the line, not on every keystroke. */
export function isOperatorSubmit(data: string): boolean {
  return data.includes('\r') || data.includes('\n');
}

export interface MissionUnparkPatch {
  readonly status: 'running';
  readonly intentState: 'executing';
}

/**
 * Retained as a pure compatibility query for pane callers. The answer flow,
 * not keystroke observation, owns every unpark.
 */
export function operatorSubmitUnparkPatch(
  _mission: Pick<Mission, 'status' | 'intentState'>,
): MissionUnparkPatch | null {
  return null;
}
