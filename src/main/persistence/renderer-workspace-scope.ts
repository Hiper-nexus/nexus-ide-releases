import type { ProjectExecutionScope } from '../../shared/types';
import { bindMemoryCoordinationScope } from '../memory/memory-coordination-authority';
import {
  resolveProjectExecutionScopeCached,
  type ProjectIdentityResolveOptions,
} from './project-identity';

export interface RendererWorkspaceOwner {
  id: number;
}

export interface LiveRendererWorkspaceOwner extends RendererWorkspaceOwner {
  isDestroyed(): boolean;
  isCrashed(): boolean;
}

const scopesByRenderer = new Map<number, ProjectExecutionScope>();
type ScopeChangeListener = (
  owner: RendererWorkspaceOwner,
  previous: ProjectExecutionScope | null,
  next: ProjectExecutionScope | null,
) => void;
const scopeChangeListeners = new Set<ScopeChangeListener>();

function publishScopeChange(
  owner: RendererWorkspaceOwner,
  previous: ProjectExecutionScope | null,
  next: ProjectExecutionScope | null,
): void {
  if (
    previous?.projectId === next?.projectId &&
    previous?.checkoutId === next?.checkoutId &&
    previous?.rootRealPath === next?.rootRealPath &&
    previous?.installationId === next?.installationId &&
    previous?.workspaceRootDevice === next?.workspaceRootDevice &&
    previous?.workspaceRootInode === next?.workspaceRootInode
  ) {
    return;
  }
  for (const listener of [...scopeChangeListeners]) {
    listener(owner, previous, next);
  }
}

export function bindRendererWorkspaceScope(
  owner: RendererWorkspaceOwner,
  workspaceRoot: string,
  options?: ProjectIdentityResolveOptions,
): ProjectExecutionScope {
  const scope = resolveProjectExecutionScopeCached(workspaceRoot, options);
  bindMemoryCoordinationScope(scope);
  const previous = scopesByRenderer.get(owner.id) ?? null;
  scopesByRenderer.set(owner.id, scope);
  publishScopeChange(owner, previous, scope);
  return scope;
}

export function bindResolvedRendererWorkspaceScope(
  owner: RendererWorkspaceOwner,
  scope: ProjectExecutionScope,
): void {
  const previous = scopesByRenderer.get(owner.id) ?? null;
  const immutable = Object.freeze({ ...scope });
  bindMemoryCoordinationScope(immutable);
  scopesByRenderer.set(owner.id, immutable);
  publishScopeChange(owner, previous, immutable);
}

export function getRendererWorkspaceScope(
  owner: RendererWorkspaceOwner,
): ProjectExecutionScope | null {
  return scopesByRenderer.get(owner.id) ?? null;
}

export function requireRendererWorkspaceScope(
  owner: RendererWorkspaceOwner,
): ProjectExecutionScope {
  const scope = getRendererWorkspaceScope(owner);
  if (!scope) throw new Error('renderer has no authorized workspace scope');
  return scope;
}

function isSameExecutionScope(
  current: ProjectExecutionScope,
  expected: ProjectExecutionScope,
): boolean {
  return (
    current.version === expected.version &&
    current.installationId === expected.installationId &&
    current.projectId === expected.projectId &&
    current.checkoutId === expected.checkoutId &&
    current.rootRealPath === expected.rootRealPath &&
    current.workspaceRootDevice === expected.workspaceRootDevice &&
    current.workspaceRootInode === expected.workspaceRootInode &&
    current.identitySource === expected.identitySource
  );
}

/** Resolve renderer effect authority exclusively from live main-process state. */
export function requireLiveRendererWorkspaceScope(
  owner: LiveRendererWorkspaceOwner,
  expected?: ProjectExecutionScope,
): ProjectExecutionScope {
  if (owner.isDestroyed() || owner.isCrashed()) {
    throw new Error('renderer is unavailable');
  }
  const current = requireRendererWorkspaceScope(owner);
  if (expected && !isSameExecutionScope(current, expected)) {
    throw new Error('renderer workspace authority changed');
  }
  return current;
}

export function clearRendererWorkspaceScope(
  owner: RendererWorkspaceOwner,
): void {
  const previous = scopesByRenderer.get(owner.id) ?? null;
  scopesByRenderer.delete(owner.id);
  publishScopeChange(owner, previous, null);
}

export function onRendererWorkspaceScopeChange(
  listener: ScopeChangeListener,
): () => void {
  scopeChangeListeners.add(listener);
  return () => scopeChangeListeners.delete(listener);
}

type WorkspaceForgottenListener = (
  owner: RendererWorkspaceOwner,
  rootRealPath: string,
) => void;
const workspaceForgottenListeners = new Set<WorkspaceForgottenListener>();

/**
 * O operador tirou o projeto da lista: é fechamento explícito, então o que
 * ficou afastado dele na troca de workspace (navegadores) encerra aqui.
 */
export function forgetRendererWorkspace(
  owner: RendererWorkspaceOwner,
  rootRealPath: string,
): void {
  for (const listener of [...workspaceForgottenListeners]) {
    listener(owner, rootRealPath);
  }
}

export function onRendererWorkspaceForgotten(
  listener: WorkspaceForgottenListener,
): () => void {
  workspaceForgottenListeners.add(listener);
  return () => workspaceForgottenListeners.delete(listener);
}
