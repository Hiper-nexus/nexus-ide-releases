/**
 * Coalesce concurrent calls into one promise and allow a later retry after
 * either success or failure. Useful where stale concurrent results could
 * overwrite shared state.
 */
export function createSingleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) return inFlight;

    let current: Promise<T>;
    try {
      current = operation();
    } catch (error) {
      current = Promise.reject(error);
    }
    inFlight = current;
    const clear = () => {
      if (inFlight === current) inFlight = null;
    };
    current.then(clear, clear);
    return current;
  };
}
