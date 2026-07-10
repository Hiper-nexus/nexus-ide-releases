import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  createScopedMediaUsageStore,
  type ScopedMediaUsageStore,
} from './media-usage-store';
import { createScopedUsageStore, type ScopedUsageStore } from './usage-store';

export interface ProjectUsageStoreSuite {
  readonly scope: ProjectExecutionScope;
  readonly usage: ScopedUsageStore;
  readonly media: ScopedMediaUsageStore;
}

function sameScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath &&
    left.identitySource === right.identitySource
  );
}

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

/** Caches scope-bound facades only; every usage/media row remains in SQLite. */
export class ProjectUsageStoreRegistry {
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #stores = new Map<string, ProjectUsageStoreSuite>();

  constructor(runtimeManager: ProjectRuntimeManager) {
    this.#runtimeManager = runtimeManager;
  }

  forScope(scope: ProjectExecutionScope): ProjectUsageStoreSuite {
    const key = scopeKey(scope);
    const existing = this.#stores.get(key);
    if (existing) {
      if (!sameScope(existing.scope, scope)) {
        throw new Error('project usage scope identity collision');
      }
      return existing;
    }
    const immutableScope = Object.freeze({ ...scope });
    const suite: ProjectUsageStoreSuite = Object.freeze({
      scope: immutableScope,
      usage: createScopedUsageStore(this.#runtimeManager, immutableScope),
      media: createScopedMediaUsageStore(this.#runtimeManager, immutableScope),
    });
    this.#stores.set(key, suite);
    return suite;
  }

  dispose(): void {
    this.#stores.clear();
  }
}

let configuredRegistry: ProjectUsageStoreRegistry | null = null;

export function configureProjectUsageStoreRegistry(
  runtimeManager: ProjectRuntimeManager,
): ProjectUsageStoreRegistry {
  configuredRegistry?.dispose();
  configuredRegistry = new ProjectUsageStoreRegistry(runtimeManager);
  return configuredRegistry;
}

export function requireProjectUsageStores(
  scope: ProjectExecutionScope,
): ProjectUsageStoreSuite {
  if (!configuredRegistry) {
    throw new Error('project-scoped usage stores are not initialized');
  }
  return configuredRegistry.forScope(scope);
}

export function disposeProjectUsageStoreRegistry(): void {
  configuredRegistry?.dispose();
  configuredRegistry = null;
}
