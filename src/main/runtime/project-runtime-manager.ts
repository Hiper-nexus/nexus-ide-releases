import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureSafeReadOnlyDatabase,
  initializeProjectDatabase,
  ProjectRuntimeFault,
  type ProjectRuntimeFailureCode,
} from './project-runtime-migrations';
import {
  INITIAL_PROJECT_MIGRATIONS,
  validateProjectMigrations,
  type ProjectMigration,
} from './project-runtime-schema';

export type ProjectRuntimeMode = 'read-write' | 'safe-read-only';
export type ProjectRuntimeHealthStatus =
  | 'healthy'
  | 'safe-read-only'
  | 'unavailable';

export interface ProjectRuntimeLocation {
  key: string;
  projectKey: string;
  checkoutKey: string;
  directory: string;
  databasePath: string;
}

export interface ProjectRuntimeHealth {
  readonly status: ProjectRuntimeHealthStatus;
  readonly writable: boolean;
  readonly databasePath: string;
  readonly appVersion: string;
  readonly schemaVersion: number | null;
  readonly quickCheck: readonly string[];
  readonly lastBackupPath: string | null;
  readonly failureCode: ProjectRuntimeFailureCode | null;
  readonly failureMessage: string | null;
  readonly checkedAt: number;
}

export type ProjectDatabaseFactory = (
  filename: string,
  options?: Database.Options,
) => Database.Database;

export type ProjectDatabaseConstructor = new (
  filename: string,
  options?: Database.Options,
) => Database.Database;

export type ProjectDatabaseModuleLoader = () => ProjectDatabaseConstructor;

export interface ProjectRuntimeManagerOptions {
  baseDir: string;
  appVersion: string;
  maxOpen?: number;
  migrations?: readonly ProjectMigration[];
  databaseFactory?: ProjectDatabaseFactory;
  databaseModuleLoader?: ProjectDatabaseModuleLoader;
  now?: () => number;
}

interface CacheEntry {
  runtime: ProjectRuntime;
  lastUsed: number;
  pinCount: number;
}

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const DEFAULT_MAX_OPEN = 8;

function defaultDatabaseModuleLoader(): ProjectDatabaseConstructor {
  // Keep the native binding outside module evaluation. This matches the
  // project's Electron/Vite CJS runtime and contains a missing ABI/binary to
  // the first scoped DB open instead of crashing application bootstrap.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require('better-sqlite3') as
    | ProjectDatabaseConstructor
    | { default?: ProjectDatabaseConstructor };
  const Constructor =
    typeof loaded === 'function' ? loaded : loaded.default;
  if (typeof Constructor !== 'function') {
    throw new Error('better-sqlite3 did not export a database constructor');
  }
  return Constructor;
}

export function createLazyProjectDatabaseFactory(
  load: ProjectDatabaseModuleLoader = defaultDatabaseModuleLoader,
): ProjectDatabaseFactory {
  let Constructor: ProjectDatabaseConstructor | null = null;
  let loadFailure: unknown;
  let didLoadFail = false;
  return (filename, options) => {
    if (didLoadFail) throw loadFailure;
    if (!Constructor) {
      try {
        Constructor = load();
      } catch (error) {
        loadFailure = error;
        didLoadFail = true;
        throw error;
      }
    }
    return new Constructor(filename, options);
  };
}

function digestPathComponent(domain: string, ...values: string[]): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(values.join('\0'))
    .digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function assertScopeId(value: string, label: string): void {
  if (value.length === 0 || value.length > 128) {
    throw new Error(`invalid ${label}`);
  }
}

function ensureDirectory(directory: string, parent?: string): string {
  fs.mkdirSync(directory, { recursive: false, mode: DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ProjectRuntimeFault(
      'unsafe_storage',
      `project runtime path is not a real directory: ${directory}`,
    );
  }
  const real = fs.realpathSync(directory);
  if (parent && !isInside(parent, real)) {
    throw new ProjectRuntimeFault(
      'unsafe_storage',
      `project runtime directory escapes its storage root: ${directory}`,
    );
  }
  fs.chmodSync(real, DIRECTORY_MODE);
  return real;
}

function ensureChildDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  try {
    return ensureDirectory(directory, parent);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error as NodeJS.ErrnoException).code !== 'EEXIST'
    ) {
      throw error;
    }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProjectRuntimeFault(
        'unsafe_storage',
        `project runtime path is not a real directory: ${directory}`,
      );
    }
    const real = fs.realpathSync(directory);
    if (!isInside(parent, real)) {
      throw new ProjectRuntimeFault(
        'unsafe_storage',
        `project runtime directory escapes its storage root: ${directory}`,
      );
    }
    fs.chmodSync(real, DIRECTORY_MODE);
    return real;
  }
}

function resolveBaseDirectory(baseDir: string): string {
  if (baseDir.trim().length === 0) throw new Error('baseDir is required');
  const absolute = path.resolve(baseDir);
  fs.mkdirSync(absolute, { recursive: true, mode: DIRECTORY_MODE });
  const real = fs.realpathSync(absolute);
  if (!fs.statSync(real).isDirectory()) {
    throw new Error('project runtime baseDir is not a directory');
  }
  return real;
}

function deriveLocation(
  projectsDirectory: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): ProjectRuntimeLocation {
  assertScopeId(scope.projectId, 'projectId');
  assertScopeId(scope.checkoutId, 'checkoutId');
  const projectKey = digestPathComponent('project', scope.projectId);
  const checkoutKey = digestPathComponent(
    'checkout',
    scope.projectId,
    scope.checkoutId,
  );
  const directory = path.join(
    projectsDirectory,
    `project-${projectKey}`,
    `checkout-${checkoutKey}`,
  );
  return {
    key: `${projectKey}:${checkoutKey}`,
    projectKey,
    checkoutKey,
    directory,
    databasePath: path.join(directory, 'runtime.sqlite3'),
  };
}

function assertDatabaseFile(databasePath: string, directory: string): void {
  const stat = fs.lstatSync(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProjectRuntimeFault(
      'unsafe_storage',
      'project runtime database is not a regular file',
    );
  }
  if (stat.nlink !== 1) {
    throw new ProjectRuntimeFault(
      'unsafe_storage',
      'project runtime database must not be a hardlink',
    );
  }
  const real = fs.realpathSync(databasePath);
  if (!isInside(directory, real)) {
    throw new ProjectRuntimeFault(
      'unsafe_storage',
      'project runtime database escapes its checkout directory',
    );
  }
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function closeDatabase(db: Database.Database | null): void {
  try {
    if (db?.open) db.close();
  } catch {
    // Closing is best-effort; the original runtime failure remains actionable.
  }
}

function normalizedFault(error: unknown): ProjectRuntimeFault {
  if (error instanceof ProjectRuntimeFault) return error;
  return new ProjectRuntimeFault(
    'database_open_failed',
    'project SQLite runtime could not be opened',
    { cause: error },
  );
}

function safeSchemaVersion(db: Database.Database): number | null {
  try {
    const value = db.pragma('user_version', { simple: true });
    return Number.isSafeInteger(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

function freezeHealth(health: ProjectRuntimeHealth): ProjectRuntimeHealth {
  return Object.freeze({
    ...health,
    quickCheck: Object.freeze([...health.quickCheck]),
  });
}

export class ProjectRuntime {
  readonly databasePath: string;
  readonly mode: ProjectRuntimeMode;
  readonly health: ProjectRuntimeHealth;
  readonly db: Database.Database;
  #closed = false;

  constructor(
    db: Database.Database,
    location: ProjectRuntimeLocation,
    mode: ProjectRuntimeMode,
    health: ProjectRuntimeHealth,
  ) {
    this.db = db;
    this.databasePath = location.databasePath;
    this.mode = mode;
    this.health = health;
  }

  get closed(): boolean {
    return this.#closed;
  }

  assertWritable(): void {
    if (this.#closed) throw new Error('project runtime is closed');
    if (this.mode !== 'read-write') {
      throw new Error('project runtime is in safe read-only mode');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeDatabase(this.db);
  }
}

export class ProjectRuntimeUnavailableError extends Error {
  readonly health: ProjectRuntimeHealth;

  constructor(health: ProjectRuntimeHealth, cause: unknown) {
    super('project runtime is unavailable; no persistence fallback was created', {
      cause,
    });
    this.name = 'ProjectRuntimeUnavailableError';
    this.health = health;
  }
}

export class ProjectRuntimeCapacityError extends Error {
  readonly maxOpen: number;

  constructor(maxOpen: number) {
    super(
      `project runtime capacity ${maxOpen} is fully pinned; refusing to close an in-use database`,
    );
    this.name = 'ProjectRuntimeCapacityError';
    this.maxOpen = maxOpen;
  }
}

export class ProjectRuntimeInUseError extends Error {
  readonly pinCount: number;

  constructor(pinCount: number) {
    super(`project runtime has ${pinCount} active lease(s)`);
    this.name = 'ProjectRuntimeInUseError';
    this.pinCount = pinCount;
  }
}

export class ProjectRuntimeLease {
  readonly runtime: ProjectRuntime;
  #release: (() => void) | null;

  constructor(runtime: ProjectRuntime, release: () => void) {
    this.runtime = runtime;
    this.#release = release;
  }

  get released(): boolean {
    return this.#release === null;
  }

  release(): void {
    const release = this.#release;
    if (!release) return;
    this.#release = null;
    release();
  }

  [Symbol.dispose](): void {
    this.release();
  }
}

export class ProjectRuntimeManager {
  readonly baseDirectory: string;
  readonly projectsDirectory: string;
  readonly appVersion: string;
  readonly maxOpen: number;
  readonly migrations: readonly ProjectMigration[];

  readonly #databaseFactory: ProjectDatabaseFactory;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #health = new Map<string, ProjectRuntimeHealth>();
  #tick = 0;

  constructor(options: ProjectRuntimeManagerOptions) {
    if (
      options.appVersion.trim() !== options.appVersion ||
      options.appVersion.length === 0 ||
      options.appVersion.length > 64
    ) {
      throw new Error('valid appVersion is required');
    }
    const maxOpen = options.maxOpen ?? DEFAULT_MAX_OPEN;
    if (!Number.isSafeInteger(maxOpen) || maxOpen < 1) {
      throw new Error('maxOpen must be a positive integer');
    }

    this.baseDirectory = resolveBaseDirectory(options.baseDir);
    this.projectsDirectory = ensureChildDirectory(
      this.baseDirectory,
      'projects',
    );
    this.appVersion = options.appVersion;
    this.maxOpen = maxOpen;
    this.migrations = validateProjectMigrations(
      options.migrations ?? INITIAL_PROJECT_MIGRATIONS,
    );
    if (options.databaseFactory && options.databaseModuleLoader) {
      throw new Error(
        'databaseFactory and databaseModuleLoader are mutually exclusive',
      );
    }
    this.#databaseFactory =
      options.databaseFactory ??
      createLazyProjectDatabaseFactory(options.databaseModuleLoader);
    this.#now = options.now ?? Date.now;
  }

  locationFor(scope: ProjectExecutionScope): ProjectRuntimeLocation {
    const derived = deriveLocation(this.projectsDirectory, scope);
    const projectDirectory = ensureChildDirectory(
      this.projectsDirectory,
      `project-${derived.projectKey}`,
    );
    const directory = ensureChildDirectory(
      projectDirectory,
      `checkout-${derived.checkoutKey}`,
    );
    return {
      ...derived,
      directory,
      databasePath: path.join(directory, 'runtime.sqlite3'),
    };
  }

  /**
   * Return an unpinned runtime. Callers retaining the handle across other
   * manager operations must use acquire()/pin() and release the lease.
   */
  open(scope: ProjectExecutionScope): ProjectRuntime {
    const derived = deriveLocation(this.projectsDirectory, scope);
    const cached = this.#cache.get(derived.key);
    if (cached && !cached.runtime.closed) {
      cached.lastUsed = ++this.#tick;
      return cached.runtime;
    }
    if (cached) this.#cache.delete(derived.key);

    this.#makeRoomForNewRuntime();
    const location = this.locationFor(scope);

    const runtime = this.#openUncached(scope, location);
    this.#cache.set(location.key, {
      runtime,
      lastUsed: ++this.#tick,
      pinCount: 0,
    });
    return runtime;
  }

  /**
   * Acquire a runtime lease for work that may overlap future opens. LRU and
   * explicit close cannot close the database until every lease releases.
   */
  acquire(scope: ProjectExecutionScope): ProjectRuntimeLease {
    const runtime = this.open(scope);
    const location = deriveLocation(this.projectsDirectory, scope);
    const entry = this.#cache.get(location.key);
    if (!entry || entry.runtime !== runtime || runtime.closed) {
      throw new Error('project runtime could not be pinned');
    }
    entry.pinCount += 1;
    entry.lastUsed = ++this.#tick;
    return new ProjectRuntimeLease(runtime, () => {
      this.#release(location.key, runtime);
    });
  }

  pin(scope: ProjectExecutionScope): ProjectRuntimeLease {
    return this.acquire(scope);
  }

  getHealth(scope: ProjectExecutionScope): ProjectRuntimeHealth | null {
    const location = deriveLocation(this.projectsDirectory, scope);
    return this.#health.get(location.key) ?? null;
  }

  close(scope: ProjectExecutionScope): boolean {
    const location = deriveLocation(this.projectsDirectory, scope);
    const entry = this.#cache.get(location.key);
    if (!entry) return false;
    if (entry.pinCount > 0) {
      throw new ProjectRuntimeInUseError(entry.pinCount);
    }
    this.#cache.delete(location.key);
    entry.runtime.close();
    return true;
  }

  closeAll(): void {
    // Process shutdown is the explicit force-close boundary; ordinary LRU and
    // close(scope) preserve every active lease.
    for (const entry of this.#cache.values()) entry.runtime.close();
    this.#cache.clear();
  }

  #openUncached(
    scope: ProjectExecutionScope,
    location: ProjectRuntimeLocation,
  ): ProjectRuntime {
    let db: Database.Database | null = null;
    try {
      const databaseExisted = pathEntryExists(location.databasePath);
      if (databaseExisted) {
        assertDatabaseFile(location.databasePath, location.directory);
      }
      db = this.#databaseFactory(location.databasePath, {
        fileMustExist: databaseExisted,
        timeout: 5_000,
      });
      if (db.memory || db.readonly) {
        throw new ProjectRuntimeFault(
          'database_open_failed',
          'project runtime did not open a writable on-disk database',
        );
      }
      assertDatabaseFile(location.databasePath, location.directory);
      fs.chmodSync(location.databasePath, DATABASE_MODE);

      const result = initializeProjectDatabase({
        db,
        runtimeDirectory: location.directory,
        projectId: scope.projectId,
        checkoutId: scope.checkoutId,
        appVersion: this.appVersion,
        migrations: this.migrations,
        now: this.#now,
      });
      const health = freezeHealth({
        status: 'healthy',
        writable: true,
        databasePath: location.databasePath,
        appVersion: this.appVersion,
        schemaVersion: result.schemaVersion,
        quickCheck: result.quickCheck,
        lastBackupPath: result.lastBackupPath,
        failureCode: null,
        failureMessage: null,
        checkedAt: this.#now(),
      });
      this.#health.set(location.key, health);
      return new ProjectRuntime(db, location, 'read-write', health);
    } catch (error) {
      closeDatabase(db);
      const runtimeFault = normalizedFault(error);
      return this.#openSafeReadOnly(location, runtimeFault);
    }
  }

  #openSafeReadOnly(
    location: ProjectRuntimeLocation,
    failure: ProjectRuntimeFault,
  ): ProjectRuntime {
    let readOnlyDb: Database.Database | null = null;
    if (pathEntryExists(location.databasePath)) {
      try {
        assertDatabaseFile(location.databasePath, location.directory);
        readOnlyDb = this.#databaseFactory(location.databasePath, {
          readonly: true,
          fileMustExist: true,
          timeout: 5_000,
        });
        configureSafeReadOnlyDatabase(readOnlyDb);
        const health = freezeHealth({
          status: 'safe-read-only',
          writable: false,
          databasePath: location.databasePath,
          appVersion: this.appVersion,
          schemaVersion: safeSchemaVersion(readOnlyDb),
          quickCheck: [],
          lastBackupPath: failure.lastBackupPath,
          failureCode: failure.code,
          failureMessage: failure.message,
          checkedAt: this.#now(),
        });
        this.#health.set(location.key, health);
        return new ProjectRuntime(
          readOnlyDb,
          location,
          'safe-read-only',
          health,
        );
      } catch {
        closeDatabase(readOnlyDb);
      }
    }

    const health = freezeHealth({
      status: 'unavailable',
      writable: false,
      databasePath: location.databasePath,
      appVersion: this.appVersion,
      schemaVersion: null,
      quickCheck: [],
      lastBackupPath: failure.lastBackupPath,
      failureCode: failure.code,
      failureMessage: failure.message,
      checkedAt: this.#now(),
    });
    this.#health.set(location.key, health);
    throw new ProjectRuntimeUnavailableError(health, failure);
  }

  #release(key: string, runtime: ProjectRuntime): void {
    const entry = this.#cache.get(key);
    if (!entry || entry.runtime !== runtime || entry.pinCount === 0) return;
    entry.pinCount -= 1;
    entry.lastUsed = ++this.#tick;
  }

  #makeRoomForNewRuntime(): void {
    while (this.#cache.size >= this.maxOpen) {
      let oldestKey: string | null = null;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#cache) {
        if (entry.pinCount > 0) continue;
        if (entry.lastUsed < oldestUse) {
          oldestUse = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        throw new ProjectRuntimeCapacityError(this.maxOpen);
      }
      const oldest = this.#cache.get(oldestKey);
      this.#cache.delete(oldestKey);
      oldest?.runtime.close();
    }
  }
}
