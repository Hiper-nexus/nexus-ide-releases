import type { MissionIntentState } from './mission-intent';

export type IntentMappedMissionStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed';

export function missionStatusForIntent(
  intent: MissionIntentState,
): IntentMappedMissionStatus | null {
  switch (intent) {
    case 'done':
      return 'done';
    case 'blocked_user':
    case 'blocked_technical':
      return 'blocked';
    case 'dispatched':
    case 'executing':
    case 'validating':
      return 'running';
    case 'draft':
    case 'awaiting_goal':
    case 'intent_compiling':
    case 'ready_to_start':
    case 'awaiting_approval':
      return 'pending';
    default:
      return null;
  }
}

export type MissionIntentEventName =
  | 'squad_selected'
  | 'goal_submitted'
  | 'intent_compiled'
  | 'plan_approved'
  | 'task_dispatched'
  | 'worker_started'
  | 'automatic_recovery'
  | 'intent_gate_denied'
  | 'prepare_project';

export interface MissionIntentEvent {
  readonly name: MissionIntentEventName;
  readonly at: number;
  readonly missionId?: string;
  readonly squadId?: string;
  readonly intentState?: MissionIntentState;
  readonly intentVersion?: number;
  readonly reason?: string;
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
}
