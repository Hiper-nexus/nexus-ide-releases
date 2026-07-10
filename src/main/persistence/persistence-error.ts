/**
 * Raised when a store cannot prove that a requested mutation is durable.
 * Callers must treat this as a failed operation; the read cache remains usable.
 */
export class PersistenceUnavailableError extends Error {
  readonly code = 'PERSISTENCE_UNAVAILABLE';

  constructor(message: string, readonly originalError?: unknown) {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

export function readOnlyPersistenceError(
  storeName: string,
): PersistenceUnavailableError {
  return new PersistenceUnavailableError(
    `${storeName} store is read-only because SQLite persistence is unavailable`,
  );
}

export function failedPersistenceError(
  storeName: string,
  operation: string,
  error: unknown,
): PersistenceUnavailableError {
  return new PersistenceUnavailableError(
    `failed to persist ${storeName} ${operation}; store is now read-only`,
    error,
  );
}
