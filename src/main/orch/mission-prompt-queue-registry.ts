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
const executingWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_TERMINAL_HISTORY = 128;
const DEFAULT_EXECUTING_WATCHDOG_MS = 10 * 60 * 1000;

/**
 * Watchdog budget for an executing slot. A handler that never settles must
 * not deadlock the whole mission queue: when the timer fires and the item is
 * still executing, the slot is force-completed as failed.
 */
function executingWatchdogMs(): number {
  const raw = process.env.MISSION_PROMPT_EXECUTING_WATCHDOG_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EXECUTING_WATCHDOG_MS;
}

function clearExecutingWatchdog(key: string): void {
  const timer = executingWatchdogs.get(key);
  if (timer) {
    clearTimeout(timer);
    executingWatchdogs.delete(key);
  }
}

function scheduleExecutingWatchdog(missionId: string, promptId: string): void {
  const key = controllerKey(missionId, promptId);
  clearExecutingWatchdog(key);
  const timer = setTimeout(() => {
    executingWatchdogs.delete(key);
    const stuck = getMissionPromptQueue(missionId).items.find(
      (item) => item.id === promptId && item.status === 'executing',
    );
    if (!stuck) return;
    console.warn(
      `[mission-prompt-queue] executing watchdog fired for ${missionId}/${promptId}; force-completing as failed`,
    );
    completeMissionPrompt(missionId, promptId, false);
  }, executingWatchdogMs());
  timer.unref();
  executingWatchdogs.set(key, timer);
}

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
    const key = controllerKey(missionId, id);
    promptAbortControllers.get(key)?.abort();
    clearExecutingWatchdog(key);
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
    scheduleExecutingWatchdog(missionId, id);
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
  clearExecutingWatchdog(controllerKey(missionId, id));
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
  for (const key of [...executingWatchdogs.keys()]) {
    if (key.startsWith(prefix)) clearExecutingWatchdog(key);
  }
}

/** Test / shutdown helper. */
export function resetMissionPromptQueues(): void {
  for (const controller of promptAbortControllers.values()) {
    controller.abort();
  }
  promptAbortControllers.clear();
  for (const timer of executingWatchdogs.values()) {
    clearTimeout(timer);
  }
  executingWatchdogs.clear();
  queues.clear();
}
