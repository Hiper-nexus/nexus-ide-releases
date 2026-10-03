import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { ipcMain } from 'electron';
import { AGENT_LIFECYCLE_CHANNELS } from '../../shared/channels';
import {
  listAgents,
  reapFinishedAgents,
  reapFinishedAgentsBudgeted,
  recordAgentEvent,
  type AgentLifecycleEvent,
  type AgentRecord,
} from './agent-lifecycle';

/**
 * Product entry for agent lifecycle observability.
 * - IPC: record / list / reap-now
 * - Interval: reap finished agents only (never kills running)
 */

export { AGENT_LIFECYCLE_CHANNELS };

const DEFAULT_REAP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_AGE_MS = 60_000;

let reapTimer: ReturnType<typeof setInterval> | null = null;
let registered = false;
let reapController = new AbortController();

export interface AgentLifecycleServiceOptions {
  readonly reapIntervalMs?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

/**
 * Register IPC + background reap loop. Idempotent.
 * Call once from main bootstrap.
 */
export function startAgentLifecycleService(
  options: AgentLifecycleServiceOptions = {},
): void {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;

  if (!registered) {
    registered = true;
    ipcMain.handle(
      AGENT_LIFECYCLE_CHANNELS.record,
      (_event, raw): AgentLifecycleEvent => recordAgentEvent(raw),
    );
    ipcMain.handle(
      AGENT_LIFECYCLE_CHANNELS.list,
      (): AgentRecord[] => listAgents(),
    );
    ipcMain.handle(
      AGENT_LIFECYCLE_CHANNELS.reap,
      (): string[] => reapFinishedAgents(now(), maxAgeMs),
    );
  }

  if (reapTimer) return;
  const interval = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  reapController = new AbortController();
  reapTimer = setInterval(() => {
    void runPeriodicTask('agent-lifecycle-reap', async (context) => {
      await reapFinishedAgentsBudgeted(context, now(), maxAgeMs);
    }, { signal: reapController.signal, cadenceMs: interval }).catch((error) => {
      if (!reapController.signal.aborted) console.warn('[agent-lifecycle] reap tick failed:', error);
    });
  }, interval);
  // Don't keep the process alive solely for reaping in tests/dev.
  if (typeof reapTimer === 'object' && 'unref' in reapTimer) {
    (reapTimer as NodeJS.Timeout).unref?.();
  }
}

export async function stopAgentLifecycleService(): Promise<void> {
  reapController.abort(new Error('agent lifecycle reaper stopped'));
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
  await stopPeriodicTask('agent-lifecycle-reap');
}

/** Test-only: allow re-register after stop. */
export function resetAgentLifecycleServiceForTests(): void {
  stopAgentLifecycleService();
  registered = false;
  try {
    ipcMain.removeHandler(AGENT_LIFECYCLE_CHANNELS.record);
    ipcMain.removeHandler(AGENT_LIFECYCLE_CHANNELS.list);
    ipcMain.removeHandler(AGENT_LIFECYCLE_CHANNELS.reap);
  } catch {
    /* electron mock may not support removeHandler */
  }
}

/**
 * Direct product API (also used by integration tests without full Electron).
 * Same semantics as IPC handlers.
 */
export function agentLifecycleRecord(raw: unknown): AgentLifecycleEvent {
  return recordAgentEvent(raw);
}

export function agentLifecycleList(): AgentRecord[] {
  return listAgents();
}

export function agentLifecycleReap(
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): string[] {
  return reapFinishedAgents(now, maxAgeMs);
}
