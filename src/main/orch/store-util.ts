/**
 * Small shared helpers for the orchestration stores. Stores keep an in-memory
 * map as the source of truth and write through to SQLite when available, so
 * the app degrades gracefully if the native better-sqlite3 module is missing.
 */

let counter = 0;

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`;
}

export type ChangeListener = () => void;

/** Minimal change-notification hub used by every orchestration store. */
export class ChangeHub {
  private listeners = new Set<ChangeListener>();

  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        console.warn('[orch] change listener threw:', err);
      }
    }
  }
}

/** Parse a JSON column defensively — bad rows must never crash the app. */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
