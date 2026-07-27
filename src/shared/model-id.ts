/**
 * Pure model-ID validation shared by live CLI discovery and CLI-owned caches.
 *
 * Shape: starts alphanumeric, then letters/digits/`._/:-`, 1..128 chars.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

export function isModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value);
}

/** Trim + validate; null when the candidate is not a usable model ID. */
export function normalizeModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return MODEL_ID_PATTERN.test(trimmed) ? trimmed : null;
}
