import type { ProjectExecutionScope } from '../../shared/types';
import type { MissionEngine } from './mission-engine';
import {
  projectExecutionScopeKey,
  sameProjectExecutionScope,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';

export type MissionEngineFactory = (
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
) => MissionEngine;

interface MissionEngineRegistryEntry {
  readonly scope: ProjectExecutionScope;
  readonly engine: MissionEngine;
}

const ENGINE_METHODS = [
  'prepare',
  'start',
  'command',
  'snapshot',
  'list',
] as const satisfies readonly (keyof MissionEngine)[];

export class MissionEngineRegistry {
  readonly #factory: MissionEngineFactory;
  readonly #entries = new Map<string, MissionEngineRegistryEntry>();

  constructor(factory: MissionEngineFactory) {
    if (typeof factory !== 'function') {
      throw new TypeError('mission engine factory is required');
    }
    this.#factory = factory;
  }

  forScope(
    scope: ProjectExecutionScope,
    stores: ProjectDomainStoreSuite,
  ): MissionEngine {
    if (!sameProjectExecutionScope(scope, stores.scope)) {
      throw new Error('mission engine store suite scope mismatch');
    }

    const key = projectExecutionScopeKey(scope);
    const existing = this.#entries.get(key);
    if (existing) {
      if (!sameProjectExecutionScope(existing.scope, scope)) {
        throw new Error('mission engine scope identity collision');
      }
      return existing.engine;
    }

    const boundScope = Object.freeze({ ...scope });
    const engine = this.#factory(boundScope, stores);
    for (const method of ENGINE_METHODS) {
      if (typeof engine?.[method] !== 'function') {
        throw new TypeError(`mission engine factory must provide ${method}`);
      }
    }

    this.#entries.set(key, { scope: boundScope, engine });
    return engine;
  }
}
