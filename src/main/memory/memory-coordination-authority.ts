import type { ProjectExecutionScope } from '../../shared/types';

// Only Main's renderer workspace binder registers coordination authority.
// Memory/search/agent getters cannot nominate a root, including execution worktrees.
const coordinators = new Map<string, ProjectExecutionScope>();

export function bindMemoryCoordinationScope(scope: ProjectExecutionScope): void {
  const previous = coordinators.get(scope.projectId);
  if (!previous) coordinators.set(scope.projectId, Object.freeze({ ...scope }));
}

export function memoryCoordinationScope(projectId: string): ProjectExecutionScope | null {
  return coordinators.get(projectId) ?? null;
}
