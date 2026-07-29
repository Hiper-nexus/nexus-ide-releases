import type { Mission } from '../../shared/orch-types';
import { transitionIntentState } from '../../shared/mission-intent';

/**
 * Unparks a mission the moment the operator actually answers it.
 *
 * The operator's keyboard already reaches an orchestrated agent through the
 * main-owned `paneOperatorInput` lane, so the answer is delivered. What was
 * missing is the other half: nothing ever fired `user_resume`. A mission that
 * asked a question stayed `blocked_user` forever — the rail kept showing
 * "Aguarda você", the wizard closed back to the home screen, and the operator
 * saw a mission that looked dead while its agent had already been answered.
 *
 * The `user_resume` transition existed in the state machine from the start and
 * had no caller. This is that caller.
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
 * The patch that returns a mission to execution, or null when there is nothing
 * to unpark. Only a mission parked ON THE HUMAN qualifies: a technical block
 * has its own recovery (Retomar missão) and must not be resurrected by typing.
 */
export function operatorSubmitUnparkPatch(
  mission: Pick<Mission, 'status' | 'intentState'>,
): MissionUnparkPatch | null {
  if (mission.status !== 'blocked') return null;
  if (mission.intentState !== 'blocked_user') return null;
  const resumed = transitionIntentState({
    from: 'blocked_user',
    event: 'user_resume',
  });
  if (!resumed.ok || resumed.to !== 'executing') return null;
  return { status: 'running', intentState: 'executing' };
}
