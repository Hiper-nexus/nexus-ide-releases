export const RENDERER_LOAD_STALL_MS = 30_000;

export type RendererLoadWatchdogAction =
  | 'wait'
  | 'retry'
  | 'restart-stalled-load';

interface RendererLoadWatchdogInput {
  isFinished: boolean;
  isLoading: boolean;
  loadAgeMs: number;
}

/**
 * Keeps slow renderer navigations alive while still recovering a genuinely
 * stalled load. Calling loadURL during an active navigation aborts that very
 * navigation, so the watchdog must distinguish slow from stale.
 */
export function decideRendererLoadWatchdog({
  isFinished,
  isLoading,
  loadAgeMs,
}: RendererLoadWatchdogInput): RendererLoadWatchdogAction {
  if (isFinished) return 'wait';
  if (!isLoading) return 'retry';
  return loadAgeMs >= RENDERER_LOAD_STALL_MS
    ? 'restart-stalled-load'
    : 'wait';
}
