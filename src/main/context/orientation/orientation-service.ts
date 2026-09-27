import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type { OrientationSnapshot } from '../../../shared/orientation-types';
import { canonicalJson } from '../canonical-json';
import { inspectContextReadiness } from '../context-doctor';
import {
  AsyncProcessGitRunner,
  type AsyncGitRunner,
  type GitRunner,
} from '../../runtime/worktree-manager';
import {
  readOrientationCache,
  writeOrientationCacheAsync,
} from './orientation-cache';
import { buildOrientationInventoryAsync } from './orientation-inventory';
import { mergeHubs } from './orientation-import-graph';
import { renderOrientationMarkdown } from './orientation-markdown';
import {
  writeOrientationStructuralIndexAsync,
} from './orientation-structural-index-cache';
import {
  buildDbGraphFromStructuralIndexAsync,
  buildImportGraphFromStructuralIndexAsync,
  buildOrientationStructuralIndexAsync,
  buildSymbolsFromStructuralIndexAsync,
  orientationWalkFromStructuralIndexAsync,
  structuralIndexFingerprintAsync,
  updateOrientationStructuralIndexAsync,
  type OrientationStructuralIndex,
} from './orientation-structural-index';
import { mergeDbGraphWithImportGraph } from './orientation-db-graph';
import {
  DEFAULT_ORIENTATION_LIMITS,
  REQUIRED_CONTEXT_DOCS,
  ROOT_DOCS,
  type OrientationEnsureOptions,
  type OrientationLimits,
  type ProjectOrientationMap,
} from './orientation-types';
import {
  walkOrientationTreeAsync,
  type OrientationWalkResult,
} from './orientation-walker';
import {
  orientationAbortError,
  throwIfOrientationAborted,
  yieldOrientationWork,
} from './orientation-cooperative';

export type OrientationTreeWalker = (
  scope: ProjectExecutionScope,
  limits: OrientationLimits,
  signal?: AbortSignal,
) => Promise<OrientationWalkResult>;

export interface ProjectOrientationServiceOptions {
  readonly cacheRoot: string;
  readonly limits?: Partial<OrientationLimits>;
  /** Legacy synchronous test adapter. Production uses asyncGitRunner/default. */
  readonly gitRunner?: GitRunner;
  readonly asyncGitRunner?: AsyncGitRunner;
  readonly treeWalker?: OrientationTreeWalker;
  readonly now?: () => number;
  /** When false, skip context doctor (tests / pure inventory). Default true. */
  readonly includeContextSummary?: boolean;
}

export interface OrientationMergeRefresh {
  readonly integrationBaseSha: string;
  readonly integratedSha: string;
  readonly changedFiles: readonly string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fileExists(root: string, relative: string): Promise<boolean> {
  try {
    const absolute = path.join(root, relative);
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return path.normalize(await fs.promises.realpath(absolute)) ===
      path.normalize(absolute);
  } catch {
    return false;
  }
}

async function directoryExists(absolute: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return path.normalize(await fs.promises.realpath(absolute)) ===
      path.normalize(absolute);
  } catch {
    return false;
  }
}

async function resolveHeadSha(
  root: string,
  git: AsyncGitRunner,
): Promise<string | null> {
  try {
    const result = await git.run(
      root,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      { allowFailure: true, timeoutMs: 5_000 },
    );
    if (result.status !== 0) return null;
    const head = result.stdout.trim().toLowerCase();
    return /^[a-f0-9]{40,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

function validSha(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(normalized) ? normalized : null;
}

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  throwIfOrientationAborted(signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(orientationAbortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function asyncAdapter(git: GitRunner): AsyncGitRunner {
  const run: AsyncGitRunner['run'] = async (cwd, args, options) =>
    git.run(cwd, args, options);
  return Object.freeze({ run });
}

export class ProjectOrientationService {
  readonly #cacheRoot: string;
  readonly #limits: OrientationLimits;
  readonly #git: AsyncGitRunner;
  readonly #treeWalker: OrientationTreeWalker;
  readonly #now: () => number;
  readonly #includeContextSummary: boolean;
  readonly #memory = new Map<string, ProjectOrientationMap>();
  readonly #structuralIndexes = new Map<string, OrientationStructuralIndex>();
  readonly #inflight = new Map<string, Promise<ProjectOrientationMap>>();
  readonly #incrementalTails = new Map<string, Promise<void>>();

  constructor(options: ProjectOrientationServiceOptions) {
    if (!options.cacheRoot.trim()) throw new Error('orientation cacheRoot is required');
    if (options.gitRunner && options.asyncGitRunner) {
      throw new Error('configure only one orientation Git runner');
    }
    this.#cacheRoot = options.cacheRoot;
    this.#limits = Object.freeze({ ...DEFAULT_ORIENTATION_LIMITS, ...options.limits });
    this.#git =
      options.asyncGitRunner ??
      (options.gitRunner
        ? asyncAdapter(options.gitRunner)
        : new AsyncProcessGitRunner());
    this.#treeWalker = options.treeWalker ?? walkOrientationTreeAsync;
    this.#now = options.now ?? Date.now;
    this.#includeContextSummary = options.includeContextSummary !== false;
  }

  get(scope: ProjectExecutionScope): ProjectOrientationMap | null {
    const key = scopeKey(scope);
    const mem = this.#memory.get(key);
    if (mem) return mem;
    const cached = readOrientationCache(this.#cacheRoot, scope);
    if (cached) {
      this.#memory.set(key, cached);
      return cached;
    }
    return null;
  }

  async ensure(
    scope: ProjectExecutionScope,
    options: OrientationEnsureOptions,
  ): Promise<ProjectOrientationMap> {
    throwIfAborted(options.signal);
    const key = scopeKey(scope);
    if (!options.force) {
      const existing = this.get(scope);
      if (existing && (existing.status === 'ready' || existing.status === 'partial')) {
        const head = await resolveHeadSha(scope.rootRealPath, this.#git);
        if (head === existing.headSha || (head === null && existing.headSha === null)) {
          return existing;
        }
        // HEAD moved: keep last-good as stale until rebuild finishes.
        const stale = Object.freeze({ ...existing, status: 'stale' as const });
        this.#memory.set(key, stale);
      }
    }

    const inflight = this.#inflight.get(key);
    if (inflight && !options.force) {
      if (options.waitMs === 0) {
        return this.get(scope) ?? this.#buildingStub(scope);
      }
      if (options.waitMs && options.waitMs > 0) {
        return awaitWithSignal(Promise.race([
          inflight,
          sleep(options.waitMs).then(() => this.get(scope) ?? this.#buildingStub(scope)),
        ]), options.signal);
      }
      return awaitWithSignal(inflight, options.signal);
    }
    // Force rebuild: wait for any in-flight build so we never double-write cache.
    if (inflight && options.force) {
      // Bound the wait: a stuck previous build must not deadlock a forced
      // rebuild (the .finally below only removes the inflight entry when it is
      // the same promise, so proceeding while it still runs is safe).
      let timedOut = false;
      try {
        await awaitWithSignal(
          Promise.race([
            inflight,
            sleep(options.waitMs ?? 10_000).then(() => {
              timedOut = true;
            }),
          ]),
          options.signal,
        );
        if (timedOut) {
          console.warn(
            '[orientation] previous build still in flight after wait; proceeding with forced rebuild',
          );
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        // previous build failed; continue with forced rebuild
      }
    }

    const buildPromise = this.#build(scope, options.signal)
      .then(async (map) => {
        throwIfAborted(options.signal);
        this.#memory.set(key, map);
        try {
          await writeOrientationCacheAsync(this.#cacheRoot, scope, map);
        } catch (error) {
          console.warn('[orientation] cache write failed:', error);
        }
        return map;
      })
      .finally(() => {
        if (this.#inflight.get(key) === buildPromise) this.#inflight.delete(key);
      });

    this.#inflight.set(key, buildPromise);

    if (options.waitMs === 0) {
      return this.get(scope) ?? this.#buildingStub(scope);
    }
    if (options.waitMs && options.waitMs > 0) {
      return awaitWithSignal(Promise.race([
        buildPromise,
        sleep(options.waitMs).then(() => this.get(scope) ?? this.#buildingStub(scope)),
      ]), options.signal);
    }
    return awaitWithSignal(buildPromise, options.signal);
  }

  async refresh(
    scope: ProjectExecutionScope,
    signal?: AbortSignal,
  ): Promise<ProjectOrientationMap> {
    return this.ensure(scope, { reason: 'refresh', force: true, signal });
  }

  async refreshAfterMerge(
    scope: ProjectExecutionScope,
    refresh: OrientationMergeRefresh,
    signal?: AbortSignal,
  ): Promise<ProjectOrientationMap> {
    throwIfAborted(signal);
    const key = scopeKey(scope);
    const previous = this.#incrementalTails.get(key) ?? Promise.resolve();
    const operation = previous.then(() =>
      this.#refreshAfterMergeNow(scope, refresh, signal));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#incrementalTails.set(key, tail);
    void tail.then(() => {
      if (this.#incrementalTails.get(key) === tail) {
        this.#incrementalTails.delete(key);
      }
    });
    return operation;
  }

  toSnapshot(map: ProjectOrientationMap): OrientationSnapshot {
    return Object.freeze({
      schemaVersion: 1 as const,
      projectId: map.projectId,
      checkoutId: map.checkoutId,
      headSha: map.headSha,
      treeFingerprint: map.treeFingerprint,
      builtAt: map.builtAt,
      buildDurationMs: map.buildDurationMs,
      status: map.status,
      error: map.error,
      mapHash: map.mapHash,
      contextReady: map.contextSummary.ready,
      orientationMarkdown: map.orientationMarkdown,
    });
  }

  async #build(
    scope: ProjectExecutionScope,
    signal?: AbortSignal,
  ): Promise<ProjectOrientationMap> {
    const started = this.#now();
    try {
      throwIfAborted(signal);
      const root = await fs.promises.realpath(scope.rootRealPath);
      if (root !== scope.rootRealPath) throw new Error('project root identity changed');

      const headPromise = resolveHeadSha(root, this.#git);
      const walk = await this.#treeWalker(scope, this.#limits, signal);
      const headSha = await headPromise;
      const index = await buildOrientationStructuralIndexAsync(
        scope,
        walk,
        this.#limits,
        headSha,
        signal,
      );
      const map = await this.#assembleMap(scope, index, started, signal);
      throwIfAborted(signal);
      this.#structuralIndexes.set(scopeKey(scope), index);
      try {
        await writeOrientationStructuralIndexAsync(
          this.#cacheRoot,
          scope,
          index,
          signal,
        );
      } catch (error) {
        console.warn('[orientation] structural index write failed:', error);
      }
      return map;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return this.#failedMap(scope, started, error);
    }
  }

  async #refreshAfterMergeNow(
    scope: ProjectExecutionScope,
    refresh: OrientationMergeRefresh,
    signal?: AbortSignal,
  ): Promise<ProjectOrientationMap> {
    const key = scopeKey(scope);
    const inflight = this.#inflight.get(key);
    if (inflight) {
      try {
        await awaitWithSignal(inflight, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    throwIfAborted(signal);

    const existing = this.get(scope);
    let index = this.#structuralIndexes.get(key) ?? null;
    if (
      !existing ||
      existing.status !== 'ready' ||
      !index ||
      index.truncated ||
      index.headSha !== existing.headSha
    ) {
      return this.refresh(scope, signal);
    }

    const started = this.#now();
    const fallbackPaths = Object.freeze([...refresh.changedFiles]);
    const requestedHead = validSha(refresh.integratedSha)
      ? refresh.integratedSha
      : null;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        throwIfAborted(signal);
        const targetHead =
          (await resolveHeadSha(scope.rootRealPath, this.#git)) ?? requestedHead;
        const changedPaths = await this.#changedPathsForUpdate(
          scope,
          index,
          targetHead,
          refresh,
          fallbackPaths,
        );
        if (!changedPaths) return this.refresh(scope, signal);
        index = await updateOrientationStructuralIndexAsync(
          scope,
          index,
          changedPaths,
          this.#limits,
          targetHead,
          signal,
        );
        const map = await this.#assembleMap(scope, index, started, signal);
        const latestHead = await resolveHeadSha(scope.rootRealPath, this.#git);
        if (!latestHead || latestHead === targetHead) {
          await this.#publishIncremental(scope, index, map, signal);
          return map;
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn(
        '[orientation] incremental refresh failed; rebuilding full map:',
        error,
      );
    }
    return this.refresh(scope, signal);
  }

  async #changedPathsForUpdate(
    scope: ProjectExecutionScope,
    index: OrientationStructuralIndex,
    targetHead: string | null,
    refresh: OrientationMergeRefresh,
    fallbackPaths: readonly string[],
  ): Promise<readonly string[] | null> {
    if (index.headSha === targetHead) return Object.freeze([]);
    if (index.headSha && targetHead) {
      const exact = await this.#changedFilesBetween(
        scope.rootRealPath,
        index.headSha,
        targetHead,
      );
      if (exact) return exact;
    }
    if (
      index.headSha === validSha(refresh.integrationBaseSha) &&
      targetHead === validSha(refresh.integratedSha)
    ) {
      return fallbackPaths;
    }
    return null;
  }

  async #changedFilesBetween(
    root: string,
    fromSha: string,
    toSha: string,
  ): Promise<readonly string[] | null> {
    try {
      const result = await this.#git.run(
        root,
        [
          'diff',
          '--name-only',
          '-z',
          '--no-renames',
          fromSha,
          toSha,
          '--',
        ],
        { allowFailure: true, timeoutMs: 10_000 },
      );
      if (result.status !== 0) return null;
      return Object.freeze(
        result.stdout
          .split('\0')
          .filter((relativePath) => relativePath.length > 0),
      );
    } catch {
      return null;
    }
  }

  async #publishIncremental(
    scope: ProjectExecutionScope,
    index: OrientationStructuralIndex,
    map: ProjectOrientationMap,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = scopeKey(scope);
    this.#structuralIndexes.set(key, index);
    this.#memory.set(key, map);
    try {
      await writeOrientationStructuralIndexAsync(
        this.#cacheRoot,
        scope,
        index,
        signal,
      );
    } catch (error) {
      console.warn('[orientation] structural index write failed:', error);
    }
    try {
      await writeOrientationCacheAsync(this.#cacheRoot, scope, map);
    } catch (error) {
      console.warn('[orientation] cache write failed:', error);
    }
  }

  async #assembleMap(
    scope: ProjectExecutionScope,
    index: OrientationStructuralIndex,
    started: number,
    signal?: AbortSignal,
  ): Promise<ProjectOrientationMap> {
    throwIfAborted(signal);
    const root = await fs.promises.realpath(scope.rootRealPath);
    if (root !== scope.rootRealPath) throw new Error('project root identity changed');

    const walk = await orientationWalkFromStructuralIndexAsync(index, signal);
    const [inventory, symbolSummary, importGraph, dbGraph] = await Promise.all([
      buildOrientationInventoryAsync(scope, walk, signal),
      buildSymbolsFromStructuralIndexAsync(index, this.#limits, signal),
      buildImportGraphFromStructuralIndexAsync(index, this.#limits, signal),
      buildDbGraphFromStructuralIndexAsync(index, this.#limits, signal),
    ]);
    const symbols = Object.freeze({
      ...symbolSummary,
      hubs: mergeHubs(
        symbolSummary.hubs,
        importGraph.hubsByFanIn,
        this.#limits.maxHubs,
      ),
    });
    const graph = mergeDbGraphWithImportGraph(importGraph, dbGraph, this.#limits);
    await yieldOrientationWork(signal);

    const rootDocStates = await Promise.all(
      ROOT_DOCS.map(async (relative) =>
        [relative, await fileExists(root, relative)] as const),
    );
    const contextDocStates = await Promise.all(
      REQUIRED_CONTEXT_DOCS.map(async (relative) =>
        [relative, await fileExists(root, relative)] as const),
    );
    const rootDocs = rootDocStates
      .filter(([, exists]) => exists)
      .map(([relative]) => relative);
    const contextDocsPresent = contextDocStates
      .filter(([, exists]) => exists)
      .map(([relative]) => relative);
    const contextDocsMissing = contextDocStates
      .filter(([, exists]) => !exists)
      .map(([relative]) => relative);
    const hasContextScaffold =
      (await fileExists(root, '.context/config/policy.json')) ||
      await directoryExists(path.join(root, '.context'));

    let contextSummary: ProjectOrientationMap['contextSummary'] = Object.freeze({
      ready: false,
      blockerCodes: Object.freeze([] as string[]),
      warningCodes: Object.freeze([] as string[]),
    });
    if (this.#includeContextSummary) {
      try {
        await yieldOrientationWork(signal);
        const report = inspectContextReadiness(scope, {
          knownSymbols: symbols.symbols,
        });
        contextSummary = Object.freeze({
          ready: report.ready,
          contextRevision: report.contextRevision,
          blockerCodes: Object.freeze(
            report.blockers.map((item) => item.code as string),
          ),
          warningCodes: Object.freeze(
            report.warnings.map((item) => item.code as string),
          ),
        });
      } catch {
        contextSummary = Object.freeze({
          ready: false,
          blockerCodes: Object.freeze(['invalid-context']),
          warningCodes: Object.freeze([] as string[]),
        });
      }
    }
    throwIfAborted(signal);

    const status = index.truncated ? 'partial' : 'ready';
    const treeFingerprint = await structuralIndexFingerprintAsync(
      index,
      signal,
    );
    const base = {
      schemaVersion: 1 as const,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      headSha: index.headSha,
      treeFingerprint,
      builtAt: new Date(this.#now()).toISOString(),
      buildDurationMs: Math.max(0, this.#now() - started),
      status: status as 'ready' | 'partial',
      error: index.truncated
        ? 'inventory truncated by file/byte/depth limits'
        : undefined,
      limits: this.#limits,
      inventory,
      symbols,
      graph,
      docs: Object.freeze({
        rootDocs: Object.freeze([...rootDocs]),
        contextDocsPresent: Object.freeze([...contextDocsPresent]),
        contextDocsMissing: Object.freeze([...contextDocsMissing]),
        hasContextScaffold,
      }),
      contextSummary,
    };
    const orientationMarkdown = renderOrientationMarkdown(
      base,
      this.#limits.markdownMaxChars,
    );
    throwIfAborted(signal);
    const mapHash = sha256(
      canonicalJson({
        projectId: base.projectId,
        checkoutId: base.checkoutId,
        headSha: base.headSha,
        treeFingerprint: base.treeFingerprint,
        inventory: base.inventory,
        symbols: {
          filesScanned: base.symbols.filesScanned,
          symbolCount: base.symbols.symbolCount,
          hubs: base.symbols.hubs,
          coverage: base.symbols.coverage,
        },
        graph: {
          mode: base.graph.mode,
          nodeCount: base.graph.nodeCount,
          edgeCount: base.graph.edgeCount,
          sampleEdges: base.graph.sampleEdges,
          enricher: base.graph.enricher,
        },
        docs: base.docs,
        contextSummary: base.contextSummary,
        status: base.status,
      }),
    );
    return Object.freeze({ ...base, orientationMarkdown, mapHash });
  }

  #failedMap(
    scope: ProjectExecutionScope,
    started: number,
    error: unknown,
  ): ProjectOrientationMap {
    const message = error instanceof Error ? error.message : String(error);
    const failedBase = {
      schemaVersion: 1 as const,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      headSha: null,
      treeFingerprint: sha256('failed'),
      builtAt: new Date(this.#now()).toISOString(),
      buildDurationMs: Math.max(0, this.#now() - started),
      status: 'failed' as const,
      error: message.slice(0, 4_096),
      limits: this.#limits,
      inventory: Object.freeze({
        languages: Object.freeze([]),
        topDirs: Object.freeze([]),
        entrypoints: Object.freeze([]),
        manifests: Object.freeze([]),
        scripts: Object.freeze({}),
        packageManagers: Object.freeze([]),
        fileCount: 0,
        sourceFileCount: 0,
        bytesScanned: 0,
        projectName: null,
      }),
      symbols: Object.freeze({
        filesScanned: 0,
        symbolCount: 0,
        hubs: Object.freeze([]),
        coverage: Object.freeze([]),
        symbols: new Set<string>(),
      }),
      graph: Object.freeze({
        mode: 'none' as const,
        nodeCount: 0,
        edgeCount: 0,
        sampleEdges: Object.freeze([] as const),
        enricher: 'none' as const,
      }),
      docs: Object.freeze({
        rootDocs: Object.freeze([]),
        contextDocsPresent: Object.freeze([]),
        contextDocsMissing: Object.freeze([...REQUIRED_CONTEXT_DOCS]),
        hasContextScaffold: false,
      }),
      contextSummary: Object.freeze({
        ready: false,
        blockerCodes: Object.freeze(['invalid-context']),
        warningCodes: Object.freeze([] as string[]),
      }),
    };
    const orientationMarkdown = renderOrientationMarkdown(
      failedBase,
      this.#limits.markdownMaxChars,
    );
    return Object.freeze({
      ...failedBase,
      orientationMarkdown,
      mapHash: sha256(canonicalJson({ status: 'failed', error: message })),
    });
  }

  #buildingStub(scope: ProjectExecutionScope): ProjectOrientationMap {
    const existing = this.get(scope);
    if (existing) {
      return Object.freeze({
        ...existing,
        status: 'building',
        orientationMarkdown:
          existing.orientationMarkdown +
          '\n\n## Build notes\n- Orientation map is rebuilding; call nexus_code_map_get shortly.',
      });
    }
    const stubBase = {
      schemaVersion: 1 as const,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      headSha: null,
      treeFingerprint: sha256('building'),
      builtAt: new Date(this.#now()).toISOString(),
      buildDurationMs: 0,
      status: 'building' as const,
      error: 'orientation map is still building',
      limits: this.#limits,
      inventory: Object.freeze({
        languages: Object.freeze([]),
        topDirs: Object.freeze([]),
        entrypoints: Object.freeze([]),
        manifests: Object.freeze([]),
        scripts: Object.freeze({}),
        packageManagers: Object.freeze([]),
        fileCount: 0,
        sourceFileCount: 0,
        bytesScanned: 0,
        projectName: null,
      }),
      symbols: Object.freeze({
        filesScanned: 0,
        symbolCount: 0,
        hubs: Object.freeze([]),
        coverage: Object.freeze([]),
        symbols: new Set<string>(),
      }),
      graph: Object.freeze({
        mode: 'none' as const,
        nodeCount: 0,
        edgeCount: 0,
        sampleEdges: Object.freeze([] as const),
        enricher: 'none' as const,
      }),
      docs: Object.freeze({
        rootDocs: Object.freeze([]),
        contextDocsPresent: Object.freeze([]),
        contextDocsMissing: Object.freeze([...REQUIRED_CONTEXT_DOCS]),
        hasContextScaffold: false,
      }),
      contextSummary: Object.freeze({
        ready: false,
        blockerCodes: Object.freeze([] as string[]),
        warningCodes: Object.freeze([] as string[]),
      }),
    };
    const orientationMarkdown = renderOrientationMarkdown(
      stubBase,
      this.#limits.markdownMaxChars,
    );
    return Object.freeze({
      ...stubBase,
      orientationMarkdown,
      mapHash: sha256('building'),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let defaultService: ProjectOrientationService | null = null;

export function configureProjectOrientationService(
  options: ProjectOrientationServiceOptions,
): ProjectOrientationService {
  defaultService = new ProjectOrientationService(options);
  return defaultService;
}

export function getProjectOrientationService(): ProjectOrientationService {
  if (!defaultService) {
    throw new Error('project orientation service is not initialized');
  }
  return defaultService;
}

export function tryGetProjectOrientationService(): ProjectOrientationService | null {
  return defaultService;
}

/**
 * Fire-and-forget post-merge hook. Structural orientation is advisory and
 * must never extend or fail the durable merge transaction.
 */
export function scheduleProjectOrientationAfterMerge(
  scope: ProjectExecutionScope,
  refresh: OrientationMergeRefresh,
): void {
  const scheduledScope = Object.freeze({ ...scope });
  const scheduledRefresh = Object.freeze({
    ...refresh,
    changedFiles: Object.freeze([...refresh.changedFiles]),
  });
  const immediate = setImmediate(() => {
    const service = tryGetProjectOrientationService();
    if (!service) return;
    void service
      .refreshAfterMerge(scheduledScope, scheduledRefresh)
      .catch((error) => {
        console.warn('[orientation] post-merge refresh failed:', error);
      });
  });
  immediate.unref();
}

/** Test helper: drop the process-wide singleton. */
export function __resetProjectOrientationServiceForTests(): void {
  defaultService = null;
}
