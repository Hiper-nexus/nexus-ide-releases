function schedulerAbortFallback(): Error {
  const error = new Error("mission scheduler reconciliation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Preserve the reconciler's exact revocation reason across scheduler layers.
 *
 * Callers deliberately check after awaited effects too: an adapter may ignore
 * AbortSignal, but the scheduler must still keep that effect single-flight
 * until physical settlement and must not continue into the next stage.
 */
export function throwIfMissionSchedulerAborted(
  signal?: AbortSignal,
): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? schedulerAbortFallback();
}
