import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Maps sessionId → project scope for CommandBlock persistence.
 * Filled at PTY spawn; cleared on exit (optional).
 */
const bySession = new Map<string, ProjectExecutionScope>();
const byWorkspace = new Map<string, ProjectExecutionScope>();

export function registerCommandBlockScope(
  sessionId: string,
  scope: ProjectExecutionScope,
): void {
  bySession.set(sessionId, scope);
  byWorkspace.set(scope.checkoutId, scope);
  byWorkspace.set(scope.projectId, scope);
}

export function resolveCommandBlockScope(
  sessionId: string,
  workspaceId?: string,
): ProjectExecutionScope | null {
  return (
    bySession.get(sessionId) ??
    (workspaceId ? byWorkspace.get(workspaceId) ?? null : null)
  );
}

export function clearCommandBlockScope(sessionId: string): void {
  bySession.delete(sessionId);
}

/** Test-only. */
export function resetCommandBlockScopeRegistryForTests(): void {
  bySession.clear();
  byWorkspace.clear();
}
