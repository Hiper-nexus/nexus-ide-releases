import { createHash } from 'node:crypto';

/**
 * Permission cache for Jarvis agent actions.
 *
 * In-memory, per-session. When the user approves a tool+args combination once,
 * it is cached for the remainder of the session. The cache is cleared when
 * the session ends.
 *
 * Key: `${sessionId}:${toolName}:${argsHash}`
 * Hash: SHA-256 of JSON.stringify(args) — consistent, deterministic.
 */

interface PermissionEntry {
  grantedAt: number;
}

const cache = new Map<string, PermissionEntry>();

/**
 * Generate a deterministic hash of the tool arguments.
 * The hash is used to identify identical tool invocations.
 */
function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeForHash(item)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function hashArgs(args: Record<string, unknown>): string {
  const normalized = JSON.stringify(normalizeForHash(args));
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Check if the user has already granted permission for this tool+args
 * combination in the given session.
 */
export function hasPermission(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const key = `${sessionId}:${toolName}:${hashArgs(args)}`;
  return cache.has(key);
}

/**
 * Grant permission for a tool+args combination in a session.
 * Subsequent calls with the same session, tool, and args will return true
 * from `hasPermission()` without prompting the user again.
 */
export function grantPermission(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const key = `${sessionId}:${toolName}:${hashArgs(args)}`;
  cache.set(key, { grantedAt: Date.now() });
}

/**
 * Revoke a specific permission entry.
 */
export function revokePermission(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const key = `${sessionId}:${toolName}:${hashArgs(args)}`;
  cache.delete(key);
}

/**
 * Clear all permissions for a session. Call this when the Jarvis session ends.
 */
export function clearSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/**
 * Clear all permissions across all sessions. Use for testing only.
 */
export function clearAll(): void {
  cache.clear();
}

/**
 * Get the number of cached permissions for a session.
 */
export function sessionPermissionCount(sessionId: string): number {
  let count = 0;
  const prefix = `${sessionId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) count++;
  }
  return count;
}

/**
 * Get all permissions for a session (for debugging/testing).
 */
export function listSessionPermissions(
  sessionId: string,
): Array<{ toolName: string; argsHash: string; grantedAt: number }> {
  const result: Array<{ toolName: string; argsHash: string; grantedAt: number }> = [];
  const prefix = `${sessionId}:`;
  for (const [key, entry] of cache.entries()) {
    if (key.startsWith(prefix)) {
      const parts = key.slice(prefix.length).split(':');
      // toolName:argsHash — the toolName may contain colons, argsHash is always last 16 hex
      const argsHash = parts[parts.length - 1];
      const toolName = parts.slice(0, -1).join(':');
      result.push({ toolName, argsHash, grantedAt: entry.grantedAt });
    }
  }
  return result;
}
