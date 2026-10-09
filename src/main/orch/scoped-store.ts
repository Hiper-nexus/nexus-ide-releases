import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import type {
  ProjectRuntimeLease,
  ProjectRuntimeManager,
} from '../runtime/project-runtime-manager';

export interface ScopeCoordinates {
  readonly projectId: string;
  readonly checkoutId: string;
}

export type ScopedEntity<T> = T & ScopeCoordinates;
export type ScopedStoreChangeListener = (scope: ScopeCoordinates) => void;

export interface ScopedStoreOptions {
  now?: () => number;
  idFactory?: (prefix: string) => string;
}

export class ScopedStoreCorruptionError extends Error {
  constructor(entity: string, options: { cause?: unknown } = {}) {
    super(
      `project runtime contains an invalid ${entity} record`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ScopedStoreCorruptionError';
  }
}

function defaultIdFactory(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function immutableScope(scope: ProjectExecutionScope): ProjectExecutionScope {
  return Object.freeze(projectExecutionScopeSchema.parse({ ...scope }));
}

let deferredChanges: Set<ScopedStoreBinding> | null = null;

/**
 * Segura as notificações dos stores durante `fn` (uma transação SQLite do
 * chamador) e só as publica se `fn` retornar: um rollback não deixa o
 * renderer ver uma missão que nunca foi commitada.
 */
export function withDeferredStoreChanges<T>(fn: () => T): T {
  if (deferredChanges) return fn();
  const pending = new Set<ScopedStoreBinding>();
  deferredChanges = pending;
  let result: T;
  try {
    result = fn();
  } finally {
    deferredChanges = null;
  }
  for (const binding of pending) binding.emitChange();
  return result;
}

/**
 * Synchronous scope binding shared by the project-domain stores. It never
 * retains a DB handle, so ProjectRuntimeManager remains free to enforce LRU.
 */
export class ScopedStoreBinding {
  readonly scope: ProjectExecutionScope;
  readonly coordinates: ScopeCoordinates;

  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #now: () => number;
  readonly #idFactory: (prefix: string) => string;
  readonly #listeners = new Set<ScopedStoreChangeListener>();

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#runtimeManager = runtimeManager;
    this.scope = immutableScope(scope);
    this.coordinates = Object.freeze({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
    });
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? defaultIdFactory;
  }

  /** Same manager connection and immutable authority, without exposing either handle. */
  sharesTransactionWith(other: ScopedStoreBinding): boolean {
    return (
      this.#runtimeManager === other.#runtimeManager &&
      this.scope.version === other.scope.version &&
      this.scope.installationId === other.scope.installationId &&
      this.scope.projectId === other.scope.projectId &&
      this.scope.checkoutId === other.scope.checkoutId &&
      this.scope.rootRealPath === other.scope.rootRealPath &&
      this.scope.workspaceRootDevice === other.scope.workspaceRootDevice &&
      this.scope.workspaceRootInode === other.scope.workspaceRootInode &&
      this.scope.identitySource === other.scope.identitySource
    );
  }

  readDatabase(): Database.Database {
    return this.#runtimeManager.open(this.scope).db;
  }

  writeDatabase(): Database.Database {
    const runtime = this.#runtimeManager.open(this.scope);
    runtime.assertWritable();
    return runtime.db;
  }

  /**
   * Pin para trabalho que atravessa outros `open()`. O LRU não fecha o
   * runtime enquanto o lease não for solto.
   */
  acquireLease(): ProjectRuntimeLease {
    return this.#runtimeManager.acquire(this.scope);
  }

  now(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('store clock returned an invalid timestamp');
    }
    return value;
  }

  makeId(prefix: string): string {
    const value = this.#idFactory(prefix);
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 256
    ) {
      throw new Error('store id factory returned an invalid id');
    }
    return value;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emitChange(): void {
    if (deferredChanges) {
      deferredChanges.add(this);
      return;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.coordinates);
      } catch (error) {
        console.warn('[orch] scoped store listener threw:', error);
      }
    }
  }
}

export function encodeJsonArray(value: unknown, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (
        typeof item === 'undefined' ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'bigint' ||
        (typeof item === 'number' && !Number.isFinite(item))
      ) {
        throw new TypeError(`${label} contains a non-JSON value`);
      }
      return item;
    });
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable`, { cause: error });
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > 1_048_576
  ) {
    throw new TypeError(`${label} must be a JSON array smaller than 1 MiB`);
  }
  const canonical = JSON.parse(serialized) as unknown;
  if (!Array.isArray(canonical)) {
    throw new TypeError(`${label} must be a JSON array`);
  }
  return serialized;
}

export function parseJsonArray(
  raw: string,
  label: string,
): unknown[] {
  try {
    if (Buffer.byteLength(raw, 'utf8') > 1_048_576) {
      throw new Error('serialized value exceeds 1 MiB');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (error) {
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}
