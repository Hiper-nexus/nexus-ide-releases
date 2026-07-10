import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ContextWorkflowService,
  type ContextWorkflowServiceDependencies,
} from './context-workflow-service';
import { ContextKnowledgeService } from './context-knowledge-service';

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

function sameScope(left: ProjectExecutionScope, right: ProjectExecutionScope): boolean {
  return left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath;
}

export class ContextWorkflowRegistry {
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #dependencies: ContextWorkflowServiceDependencies;
  readonly #services = new Map<string, ContextWorkflowService>();
  readonly #knowledgeServices = new Map<string, ContextKnowledgeService>();

  constructor(
    runtimeManager: ProjectRuntimeManager,
    dependencies: ContextWorkflowServiceDependencies,
  ) {
    this.#runtimeManager = runtimeManager;
    this.#dependencies = dependencies;
  }

  forScope(scope: ProjectExecutionScope): ContextWorkflowService {
    const key = scopeKey(scope);
    const existing = this.#services.get(key);
    if (existing) {
      if (!sameScope(existing.scope, scope)) {
        throw new Error('context workflow scope identity collision');
      }
      return existing;
    }
    const service = new ContextWorkflowService(
      this.#runtimeManager,
      scope,
      this.#dependencies,
    );
    this.#services.set(key, service);
    return service;
  }

  knowledgeForScope(scope: ProjectExecutionScope): ContextKnowledgeService {
    const key = scopeKey(scope);
    const existing = this.#knowledgeServices.get(key);
    if (existing) {
      if (!sameScope(existing.scope, scope)) {
        throw new Error('context knowledge scope identity collision');
      }
      return existing;
    }
    const service = new ContextKnowledgeService(this.#runtimeManager, scope, {
      appVersion: this.#dependencies.appVersion,
      now: this.#dependencies.now,
      idFactory: this.#dependencies.makeId,
    });
    this.#knowledgeServices.set(key, service);
    return service;
  }

  dispose(): void {
    this.#services.clear();
    this.#knowledgeServices.clear();
  }
}

let registry: ContextWorkflowRegistry | null = null;

export function configureContextWorkflowRegistry(
  runtimeManager: ProjectRuntimeManager,
  dependencies: ContextWorkflowServiceDependencies,
): ContextWorkflowRegistry {
  registry?.dispose();
  registry = new ContextWorkflowRegistry(runtimeManager, dependencies);
  return registry;
}

export function getContextWorkflowService(
  scope: ProjectExecutionScope,
): ContextWorkflowService {
  if (!registry) throw new Error('context workflow service is not initialized');
  return registry.forScope(scope);
}

export function getContextKnowledgeService(
  scope: ProjectExecutionScope,
): ContextKnowledgeService {
  if (!registry) throw new Error('context knowledge service is not initialized');
  return registry.knowledgeForScope(scope);
}

export function disposeContextWorkflowRegistry(): void {
  registry?.dispose();
  registry = null;
}
