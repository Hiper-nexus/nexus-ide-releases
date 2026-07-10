import { createHash } from 'node:crypto';

/**
 * Permission cache for Jarvis agent actions.
 *
 * In-memory, per-session. Each approval is scoped to the exact workspace,
 * tool, and arguments and can be consumed by one invocation only. The cache
 * is cleared when the session ends.
 *
 * Key: `${sessionId}:${toolName}:${argsHash}`
 * Hash: SHA-256 of JSON.stringify(args) — consistent, deterministic.
 */

interface PermissionEntry {
  sessionId: string;
  workspaceId: string;
  toolName: string;
  argsHash: string;
  grantedAt: number;
}

const cache = new Map<string, PermissionEntry>();

export interface PermissionScope {
  sessionId: string;
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Generate a deterministic hash of the tool arguments.
 * The hash is used to identify identical tool invocations.
 */
function normalizeForHash(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('permission args cannot contain cycles');
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeForHash(item, seen)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function hashArgs(args: Record<string, unknown>): string {
  const normalized = JSON.stringify(normalizeForHash(args));
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function hashWorkspaceId(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
}

export function permissionKey(scope: PermissionScope): string {
  return [
    scope.sessionId,
    hashWorkspaceId(scope.workspaceId),
    scope.toolName,
    hashArgs(scope.args),
  ].join(':');
}

/**
 * Check if the user has already granted permission for this tool+args
 * combination in the given session and workspace.
 */
export function hasPermission(scope: PermissionScope): boolean {
  return cache.has(permissionKey(scope));
}

/**
 * Atomically consume one exact approval. Deleting before the effect starts
 * prevents concurrent or repeated invocations from reusing the same consent.
 */
export function consumePermission(scope: PermissionScope): boolean {
  const key = permissionKey(scope);
  if (!cache.has(key)) return false;
  cache.delete(key);
  return true;
}

/**
 * Grant one execution permit for a tool+args combination in a session and
 * workspace. `consumePermission()` removes it before the handler starts.
 */
export function grantPermission(scope: PermissionScope): void {
  const argsHash = hashArgs(scope.args);
  cache.set(permissionKey(scope), {
    sessionId: scope.sessionId,
    workspaceId: scope.workspaceId,
    toolName: scope.toolName,
    argsHash,
    grantedAt: Date.now(),
  });
}

/**
 * Revoke a specific permission entry.
 */
export function revokePermission(scope: PermissionScope): void {
  cache.delete(permissionKey(scope));
}

/**
 * Clear all permissions for a session. Call this when the Jarvis session ends.
 */
export function clearSession(sessionId: string): void {
  for (const [key, entry] of cache.entries()) {
    if (entry.sessionId === sessionId) {
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
  for (const entry of cache.values()) {
    if (entry.sessionId === sessionId) count++;
  }
  return count;
}

/**
 * Get all permissions for a session (for debugging/testing).
 */
export function listSessionPermissions(
  sessionId: string,
): Array<{
  toolName: string;
  workspaceId: string;
  argsHash: string;
  grantedAt: number;
}> {
  const result: Array<{
    toolName: string;
    workspaceId: string;
    argsHash: string;
    grantedAt: number;
  }> = [];
  for (const entry of cache.values()) {
    if (entry.sessionId === sessionId) {
      result.push({
        toolName: entry.toolName,
        workspaceId: entry.workspaceId,
        argsHash: entry.argsHash,
        grantedAt: entry.grantedAt,
      });
    }
  }
  return result;
}
