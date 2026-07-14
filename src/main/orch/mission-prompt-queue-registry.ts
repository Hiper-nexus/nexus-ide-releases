/**
 * Process-wide mission prompt queues (main process).
 * Renderer/voice call through IPC or shared reduce helpers for tests.
 */
import {
  createEmptyPromptQueue,
  nextDeliverablePrompt,
  promptQueueSnapshot,
  prunePromptQueueHistory,
  reducePromptQueue,
  type MissionPromptKind,
  type MissionPromptQueueState,
  type PromptQueueReduceResult,
} from '../../shared/mission-prompt-queue';

const queues = new Map<string, MissionPromptQueueState>();
const promptAbortControllers = new Map<string, AbortController>();
const MAX_TERMINAL_HISTORY = 128;

function storeResult(
  missionId: string,
  result: PromptQueueReduceResult,
): PromptQueueReduceResult {
  const state = prunePromptQueueHistory(result.state, MAX_TERMINAL_HISTORY);
  queues.set(missionId, state);
  return state === result.state ? result : { ...result, state };
}

function controllerKey(missionId: string, promptId: string): string {
  return `${missionId}\0${promptId}`;
}

function abortCancelledPrompts(
  missionId: string,
  cancelledIds: readonly string[],
): void {
  for (const id of cancelledIds) {
    promptAbortControllers.get(controllerKey(missionId, id))?.abort();
  }
}

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
  const stored = storeResult(input.missionId, result);
  abortCancelledPrompts(input.missionId, result.cancelledIds);
  return stored;
}

export function startMissionPrompt(
  missionId: string,
  id: string,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(missionId), {
    type: 'start',
    id,
  });
  const stored = storeResult(missionId, result);
  const started = stored.state.items.find(
    (item) => item.id === id && item.status === 'executing',
  );
  if (started) {
    const key = controllerKey(missionId, id);
    if (!promptAbortControllers.has(key)) {
      promptAbortControllers.set(key, new AbortController());
    }
  }
  return stored;
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
  const stored = storeResult(missionId, result);
  promptAbortControllers.delete(controllerKey(missionId, id));
  return stored;
}

export function cancelMissionPrompt(
  missionId: string,
  id: string,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(missionId), {
    type: 'cancel',
    id,
  });
  const stored = storeResult(missionId, result);
  abortCancelledPrompts(missionId, result.cancelledIds);
  return stored;
}

export function bumpMissionPromptIntent(
  missionId: string,
  intentVersion: number,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(missionId), {
    type: 'bump_intent',
    intentVersion,
  });
  const stored = storeResult(missionId, result);
  abortCancelledPrompts(missionId, result.cancelledIds);
  return stored;
}

export function getMissionPromptAbortSignal(
  missionId: string,
  id: string,
): AbortSignal | undefined {
  return promptAbortControllers.get(controllerKey(missionId, id))?.signal;
}

export function peekMissionPromptQueue(missionId: string) {
  return promptQueueSnapshot(getMissionPromptQueue(missionId));
}

export function takeNextMissionPrompt(missionId: string) {
  const state = getMissionPromptQueue(missionId);
  return nextDeliverablePrompt(state);
}

export function deleteMissionPromptQueue(missionId: string): void {
  queues.delete(missionId);
  const prefix = `${missionId}\0`;
  for (const [key, controller] of promptAbortControllers) {
    if (!key.startsWith(prefix)) continue;
    controller.abort();
    promptAbortControllers.delete(key);
  }
}

/** Test / shutdown helper. */
export function resetMissionPromptQueues(): void {
  for (const controller of promptAbortControllers.values()) {
    controller.abort();
  }
  promptAbortControllers.clear();
  queues.clear();
}
