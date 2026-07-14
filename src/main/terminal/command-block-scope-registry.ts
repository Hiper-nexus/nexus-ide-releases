import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Maps sessionId → project scope for CommandBlock persistence.
 * Filled at PTY spawn; cleared on exit (optional).
 */
const bySession = new Map<string, ProjectExecutionScope>();
const byWorkspace = new Map<string, ProjectExecutionScope>();

function isSameScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

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
  const scope = bySession.get(sessionId);
  bySession.delete(sessionId);
  if (!scope) return;
  const isStillReferenced = [...bySession.values()].some((candidate) =>
    isSameScope(candidate, scope),
  );
  if (isStillReferenced) return;
  const checkoutScope = byWorkspace.get(scope.checkoutId);
  if (checkoutScope && isSameScope(checkoutScope, scope)) {
    byWorkspace.delete(scope.checkoutId);
  }
  const projectScope = byWorkspace.get(scope.projectId);
  if (projectScope && isSameScope(projectScope, scope)) {
    byWorkspace.delete(scope.projectId);
  }
}

/** Test-only. */
export function resetCommandBlockScopeRegistryForTests(): void {
  bySession.clear();
  byWorkspace.clear();
}
