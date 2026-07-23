/**
 * Process-wide, project-execution-scoped mission prompt queues (main process).
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
import type { ProjectExecutionScope } from '../../shared/types';

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

function scheduleExecutingWatchdog(
  scope: ProjectExecutionScope,
  missionId: string,
  promptId: string,
): void {
  const key = controllerKey(scope, missionId, promptId);
  clearExecutingWatchdog(key);
  const timer = setTimeout(() => {
    executingWatchdogs.delete(key);
    const stuck = getMissionPromptQueue(scope, missionId).items.find(
      (item) => item.id === promptId && item.status === 'executing',
    );
    if (!stuck) return;
    console.warn(
      `[mission-prompt-queue] executing watchdog fired for ${missionId}/${promptId}; force-completing as failed`,
    );
    completeMissionPrompt(scope, missionId, promptId, false);
  }, executingWatchdogMs());
  timer.unref();
  executingWatchdogs.set(key, timer);
}

function storeResult(
  scope: ProjectExecutionScope,
  missionId: string,
  result: PromptQueueReduceResult,
): PromptQueueReduceResult {
  const state = prunePromptQueueHistory(result.state, MAX_TERMINAL_HISTORY);
  queues.set(queueKey(scope, missionId), state);
  return state === result.state ? result : { ...result, state };
}

function queueKey(scope: ProjectExecutionScope, missionId: string): string {
  return JSON.stringify([
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    missionId,
  ]);
}

function controllerPrefix(
  scope: ProjectExecutionScope,
  missionId: string,
): string {
  const scopedQueueKey = queueKey(scope, missionId);
  return `${scopedQueueKey.length}:${scopedQueueKey}`;
}

function controllerKey(
  scope: ProjectExecutionScope,
  missionId: string,
  promptId: string,
): string {
  return `${controllerPrefix(scope, missionId)}${promptId}`;
}

function abortCancelledPrompts(
  scope: ProjectExecutionScope,
  missionId: string,
  cancelledIds: readonly string[],
): void {
  for (const id of cancelledIds) {
    const key = controllerKey(scope, missionId, id);
    promptAbortControllers.get(key)?.abort();
    clearExecutingWatchdog(key);
  }
}

export function getMissionPromptQueue(
  scope: ProjectExecutionScope,
  missionId: string,
): MissionPromptQueueState {
  const key = queueKey(scope, missionId);
  let state = queues.get(key);
  if (!state) {
    state = createEmptyPromptQueue(missionId);
    queues.set(key, state);
  }
  return state;
}

export function enqueueMissionPrompt(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly kind: MissionPromptKind;
  readonly body: string;
  readonly intentVersion: number;
  readonly source: 'typed' | 'voice' | 'system';
  readonly now?: number;
  readonly id?: string;
}): PromptQueueReduceResult {
  const prev = getMissionPromptQueue(input.scope, input.missionId);
  const result = reducePromptQueue(prev, {
    type: 'enqueue',
    kind: input.kind,
    body: input.body,
    intentVersion: input.intentVersion,
    source: input.source,
    now: input.now,
    id: input.id,
  });
  const stored = storeResult(input.scope, input.missionId, result);
  abortCancelledPrompts(input.scope, input.missionId, result.cancelledIds);
  return stored;
}

export function startMissionPrompt(
  scope: ProjectExecutionScope,
  missionId: string,
  id: string,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(scope, missionId), {
    type: 'start',
    id,
  });
  const stored = storeResult(scope, missionId, result);
  const started = stored.state.items.find(
    (item) => item.id === id && item.status === 'executing',
  );
  if (started) {
    const key = controllerKey(scope, missionId, id);
    if (!promptAbortControllers.has(key)) {
      promptAbortControllers.set(key, new AbortController());
    }
    scheduleExecutingWatchdog(scope, missionId, id);
  }
  return stored;
}

export function completeMissionPrompt(
  scope: ProjectExecutionScope,
  missionId: string,
  id: string,
  ok: boolean,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(scope, missionId), {
    type: 'complete',
    id,
    ok,
  });
  const stored = storeResult(scope, missionId, result);
  promptAbortControllers.delete(controllerKey(scope, missionId, id));
  clearExecutingWatchdog(controllerKey(scope, missionId, id));
  return stored;
}

export function cancelMissionPrompt(
  scope: ProjectExecutionScope,
  missionId: string,
  id: string,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(scope, missionId), {
    type: 'cancel',
    id,
  });
  const stored = storeResult(scope, missionId, result);
  abortCancelledPrompts(scope, missionId, result.cancelledIds);
  return stored;
}

export function bumpMissionPromptIntent(
  scope: ProjectExecutionScope,
  missionId: string,
  intentVersion: number,
): PromptQueueReduceResult {
  const result = reducePromptQueue(getMissionPromptQueue(scope, missionId), {
    type: 'bump_intent',
    intentVersion,
  });
  const stored = storeResult(scope, missionId, result);
  abortCancelledPrompts(scope, missionId, result.cancelledIds);
  return stored;
}

export function getMissionPromptAbortSignal(
  scope: ProjectExecutionScope,
  missionId: string,
  id: string,
): AbortSignal | undefined {
  return promptAbortControllers.get(controllerKey(scope, missionId, id))?.signal;
}

export function peekMissionPromptQueue(
  scope: ProjectExecutionScope,
  missionId: string,
) {
  return promptQueueSnapshot(getMissionPromptQueue(scope, missionId));
}

export function takeNextMissionPrompt(
  scope: ProjectExecutionScope,
  missionId: string,
) {
  const state = getMissionPromptQueue(scope, missionId);
  return nextDeliverablePrompt(state);
}

export function deleteMissionPromptQueue(
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  queues.delete(queueKey(scope, missionId));
  const prefix = controllerPrefix(scope, missionId);
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
