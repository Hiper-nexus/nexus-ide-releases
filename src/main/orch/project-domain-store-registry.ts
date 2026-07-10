import type { ProjectExecutionScope } from "../../shared/types";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  createScopedHandoffStore,
  type ScopedHandoffStore,
} from "./handoff-store";
import {
  createScopedMissionPaneStore,
  type ScopedMissionPaneStore,
} from "./mission-pane-store";
import {
  createScopedMissionStore,
  type ScopedMissionStore,
} from "./mission-store";
import { createScopedTaskStore, type ScopedTaskStore } from "./task-store";
import { createScopedTodoStore, type ScopedTodoStore } from "./todo-store";

export type ProjectDomainStoreName =
  "missions" | "mission-panes" | "handoffs" | "tasks" | "todos";

export interface ProjectDomainStoreSuite {
  readonly scope: ProjectExecutionScope;
  readonly missions: ScopedMissionStore;
  readonly missionPanes: ScopedMissionPaneStore;
  readonly handoffs: ScopedHandoffStore;
  readonly tasks: ScopedTaskStore;
  readonly todos: ScopedTodoStore;
}

export type ProjectDomainStoreListener = (
  scope: ProjectExecutionScope,
  store: ProjectDomainStoreName,
) => void;

export type ProjectDomainScopeListener = (
  scope: ProjectExecutionScope,
  suite: ProjectDomainStoreSuite,
) => void;

interface RegistryEntry {
  suite: ProjectDomainStoreSuite;
  unsubscribers: Array<() => void>;
}

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

function sameScope(
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

/** Caches only scope-bound store facades/listeners; entity data stays in SQLite. */
export class ProjectDomainStoreRegistry {
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #listeners = new Set<ProjectDomainStoreListener>();
  readonly #scopeListeners = new Set<ProjectDomainScopeListener>();

  constructor(runtimeManager: ProjectRuntimeManager) {
    this.#runtimeManager = runtimeManager;
  }

  forScope(scope: ProjectExecutionScope): ProjectDomainStoreSuite {
    const key = scopeKey(scope);
    const existing = this.#entries.get(key);
    if (existing) {
      if (!sameScope(existing.suite.scope, scope)) {
        throw new Error("project store scope identity collision");
      }
      return existing.suite;
    }
    const immutableScope = Object.freeze({ ...scope });
    const suite: ProjectDomainStoreSuite = Object.freeze({
      scope: immutableScope,
      missions: createScopedMissionStore(this.#runtimeManager, immutableScope),
      missionPanes: createScopedMissionPaneStore(
        this.#runtimeManager,
        immutableScope,
      ),
      handoffs: createScopedHandoffStore(this.#runtimeManager, immutableScope),
      tasks: createScopedTaskStore(this.#runtimeManager, immutableScope),
      todos: createScopedTodoStore(this.#runtimeManager, immutableScope),
    });
    const unsubscribers = [
      suite.missions.onChange(() => this.#emit(immutableScope, "missions")),
      suite.missionPanes.onChange(() =>
        this.#emit(immutableScope, "mission-panes"),
      ),
      suite.handoffs.onChange(() => this.#emit(immutableScope, "handoffs")),
      suite.tasks.onChange(() => this.#emit(immutableScope, "tasks")),
      suite.todos.onChange(() => this.#emit(immutableScope, "todos")),
    ];
    this.#entries.set(key, { suite, unsubscribers });
    for (const listener of [...this.#scopeListeners]) {
      listener(immutableScope, suite);
    }
    return suite;
  }

  onChange(listener: ProjectDomainStoreListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Observes scope suites before their first caller can mutate them. Existing
   * suites are replayed immediately so late-starting derived services can
   * initialize historical state deterministically.
   */
  onScope(listener: ProjectDomainScopeListener): () => void {
    this.#scopeListeners.add(listener);
    for (const entry of this.#entries.values()) {
      listener(entry.suite.scope, entry.suite);
    }
    return () => this.#scopeListeners.delete(listener);
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      for (const unsubscribe of entry.unsubscribers) unsubscribe();
    }
    this.#entries.clear();
    this.#listeners.clear();
    this.#scopeListeners.clear();
  }

  #emit(scope: ProjectExecutionScope, store: ProjectDomainStoreName): void {
    for (const listener of [...this.#listeners]) listener(scope, store);
  }
}

let configuredRegistry: ProjectDomainStoreRegistry | null = null;

/** Installation-level service locator for main-process subsystems without IPC ownership. */
export function configureProjectDomainStoreRegistry(
  runtimeManager: ProjectRuntimeManager,
): ProjectDomainStoreRegistry {
  configuredRegistry?.dispose();
  configuredRegistry = new ProjectDomainStoreRegistry(runtimeManager);
  return configuredRegistry;
}

export function getProjectDomainStores(
  scope: ProjectExecutionScope,
): ProjectDomainStoreSuite {
  if (!configuredRegistry) {
    throw new Error("project-scoped domain stores are not initialized");
  }
  return configuredRegistry.forScope(scope);
}

export function requireProjectDomainStoreRegistry(): ProjectDomainStoreRegistry {
  if (!configuredRegistry) {
    throw new Error("project-scoped domain stores are not initialized");
  }
  return configuredRegistry;
}

export function disposeProjectDomainStoreRegistry(): void {
  configuredRegistry?.dispose();
  configuredRegistry = null;
}
