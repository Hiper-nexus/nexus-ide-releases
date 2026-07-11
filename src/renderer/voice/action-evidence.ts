export type ActionEvidenceStatus = 'committed' | 'uncertain' | 'cancelled';

export interface ActionEvidenceResult<T> {
  status: ActionEvidenceStatus;
  value?: T;
  elapsedMs: number;
}

export interface WaitForActionEvidenceOptions<T> {
  read: () => T;
  accepts: (value: T) => boolean;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Waits for an observable post-condition instead of equating dispatch with
 * success. UI actions may settle through IPC/store broadcasts after the call
 * that initiated them has already returned.
 */
export async function waitForActionEvidence<T>(
  options: WaitForActionEvidenceOptions<T>,
): Promise<ActionEvidenceResult<T>> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 3_000);
  const pollMs = Math.max(1, options.pollMs ?? 50);
  const now = options.now ?? Date.now;
  const startedAt = now();

  while (true) {
    if (options.signal?.aborted) {
      return { status: 'cancelled', elapsedMs: Math.max(0, now() - startedAt) };
    }
    const value = options.read();
    if (options.accepts(value)) {
      return {
        status: 'committed',
        value,
        elapsedMs: Math.max(0, now() - startedAt),
      };
    }
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= timeoutMs) return { status: 'uncertain', value, elapsedMs };
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, timeoutMs - elapsedMs)));
  }
}
