/**
 * Process-wide mission prompt queues (main process).
 * Renderer/voice call through IPC or shared reduce helpers for tests.
 */
import {
  createEmptyPromptQueue,
  nextDeliverablePrompt,
  promptQueueSnapshot,
  reducePromptQueue,
  type MissionPromptKind,
  type MissionPromptQueueState,
  type PromptQueueReduceResult,
} from '../../shared/mission-prompt-queue';

const queues = new Map<string, MissionPromptQueueState>();

export function getMissionPromptQueue(
  missionId: string,
): MissionPromptQueueState {
  let state = queues.get(missionId);
  if (!state) {
    state = createEmptyPromptQueue(missionId);
    queues.set(missionId, state);
  }
  return state;
}

export function enqueueMissionPrompt(input: {
  readonly missionId: string;
  readonly kind: MissionPromptKind;
  readonly body: string;
  readonly intentVersion: number;
  readonly source: 'typed' | 'voice' | 'system';
  readonly now?: number;
  readonly id?: string;
}): PromptQueueReduceResult {
  const prev = getMissionPromptQueue(input.missionId);
  const result = reducePromptQueue(prev, {
    type: 'enqueue',
    kind: input.kind,
    body: input.body,
    intentVersion: input.intentVersion,
    source: input.source,
    now: input.now,
    id: input.id,
  });
  queues.set(input.missionId, result.state);
  return result;
}

export function startMissionPrompt(
  missionId: string,
  id: string,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(missionId), {
    type: 'start',
    id,
  });
  queues.set(missionId, result.state);
  return result;
}

export function completeMissionPrompt(
  missionId: string,
  id: string,
  ok: boolean,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(missionId), {
    type: 'complete',
    id,
    ok,
  });
  queues.set(missionId, result.state);
  return result;
}

export function bumpMissionPromptIntent(
  missionId: string,
  intentVersion: number,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(missionId), {
    type: 'bump_intent',
    intentVersion,
  });
  queues.set(missionId, result.state);
  return result;
}

export function peekMissionPromptQueue(missionId: string) {
  return promptQueueSnapshot(getMissionPromptQueue(missionId));
}

export function takeNextMissionPrompt(missionId: string) {
  const state = getMissionPromptQueue(missionId);
  return nextDeliverablePrompt(state);
}

/** Test / shutdown helper. */
export function resetMissionPromptQueues(): void {
  queues.clear();
}
