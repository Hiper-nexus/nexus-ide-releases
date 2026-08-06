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
  | 'prepare_project'
  | 'bootstrap_progress'
  | 'kickoff_accepted'
  | 'chef_idle_awaiting_workers'
  | 'guided_fanout_serialized'
  | 'wave_concurrency_verdict'
  // Ação destrutiva rodou sem perguntar: leva o caminho de volta ao operador.
  | 'destructive_reversal_prepared';

/**
 * Passos visíveis do bootstrap main-owned (aprovação → primeiro pane → aceite
 * do kickoff). O renderer mapeia cada passo para uma frase curta; a ausência
 * de evento nunca é erro (journal desligado = card estático de sempre).
 */
export type BootstrapProgressStep =
  | 'authority_checked'
  | 'subscription_auth'
  | 'plan_baseline'
  | 'squad_sealed'
  | 'prevc_freeze'
  | 'runtime_checked'
  | 'drift_retired'
  | 'attachments_verified'
  | 'pane_spawned'
  | 'kickoff_submitted'
  | 'kickoff_accepted';

export const BOOTSTRAP_PROGRESS_STEPS: readonly BootstrapProgressStep[] =
  Object.freeze([
    'authority_checked',
    'subscription_auth',
    'plan_baseline',
    'squad_sealed',
    'prevc_freeze',
    'runtime_checked',
    'drift_retired',
    'attachments_verified',
    'pane_spawned',
    'kickoff_submitted',
    'kickoff_accepted',
  ]);

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
