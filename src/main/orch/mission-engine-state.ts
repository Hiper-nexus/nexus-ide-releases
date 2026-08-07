import type { MissionStatus } from '../../shared/orch-types';
import {
  isMissionStatusIntentPair,
  missionBlockPatch,
  missionStatusForIntent,
  transitionIntentState,
  type IntentTransitionInput,
  type MissionIntentState,
} from '../../shared/mission-intent';

export interface MissionLifecyclePair {
  readonly status: MissionStatus;
  readonly intentState: MissionIntentState;
}

export interface MissionCompletionVerification {
  readonly pending: number;
  readonly inFlight: number;
  readonly handoffs: number;
}

export type MissionLifecycleEvent =
  | { readonly kind: 'review-ready' }
  | { readonly kind: 'start' }
  | { readonly kind: 'kickoff-accepted' }
  | { readonly kind: 'block-user' }
  | { readonly kind: 'block-technical' }
  | { readonly kind: 'answer' }
  | { readonly kind: 'recover' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'fail' }
  | {
      readonly kind: 'complete';
      readonly verification: MissionCompletionVerification;
    };

function assertCurrentPair(current: MissionLifecyclePair): void {
  if (!isMissionStatusIntentPair(current)) {
    throw new Error(
      `invalid lifecycle pair: ${current.status}/${current.intentState}`,
    );
  }
  if (current.status === 'done' || current.status === 'failed') {
    throw new Error(`cannot transition terminal mission: ${current.status}`);
  }
}

function transitionIntent(
  current: MissionLifecyclePair,
  event: IntentTransitionInput['event'],
): MissionLifecyclePair {
  const transition = transitionIntentState({
    from: current.intentState,
    event,
  });
  if (!transition.ok) throw new Error(transition.reason);
  const status = missionStatusForIntent(transition.to);
  if (!status) {
    throw new Error(`intent transition has no lifecycle status: ${transition.to}`);
  }
  return { status, intentState: transition.to };
}

function block(
  current: MissionLifecyclePair,
  kind: 'user' | 'technical',
): MissionLifecyclePair {
  const transition = transitionIntentState({
    from: current.intentState,
    event: kind === 'user' ? 'block_user' : 'block_technical',
  });
  if (!transition.ok) throw new Error(transition.reason);
  const patch = missionBlockPatch(kind);
  if (transition.to !== patch.intentState) {
    throw new Error(`blocking transition produced ${transition.to}`);
  }
  return patch;
}

function assertNoPendingWork(
  verification: MissionCompletionVerification,
): void {
  if (
    verification.pending !== 0 ||
    verification.inFlight !== 0 ||
    verification.handoffs !== 0
  ) {
    throw new Error(
      `cannot complete mission with pending work: pending=${verification.pending}, ` +
        `inFlight=${verification.inFlight}, handoffs=${verification.handoffs}`,
    );
  }
}

function failedPair(): MissionLifecyclePair {
  return { ...missionBlockPatch('technical'), status: 'failed' };
}

export function reduceMissionLifecycle(
  current: MissionLifecyclePair,
  event: MissionLifecycleEvent,
): MissionLifecyclePair {
  assertCurrentPair(current);

  switch (event.kind) {
    case 'review-ready':
      return transitionIntent(current, 'compile_ok');
    case 'start':
      return transitionIntent(current, 'start');
    case 'kickoff-accepted':
      return transitionIntent(current, 'begin_execution');
    case 'block-user':
      return block(current, 'user');
    case 'block-technical':
      return block(current, 'technical');
    case 'answer':
      return transitionIntent(current, 'user_resume');
    case 'recover':
      return transitionIntent(current, 'begin_execution');
    case 'stop':
    case 'fail':
      return failedPair();
    case 'complete': {
      const next = transitionIntent(current, 'complete');
      assertNoPendingWork(event.verification);
      return next;
    }
  }
}
