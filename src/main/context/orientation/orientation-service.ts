import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type { OrientationSnapshot } from '../../../shared/orientation-types';
import { canonicalJson } from '../canonical-json';
import { inspectContextReadiness } from '../context-doctor';
import {
  ProcessGitRunner,
  type GitRunner,
} from '../../runtime/worktree-manager';
import {
  readOrientationCache,
  writeOrientationCache,
} from './orientation-cache';
import { enrichWithGraphify } from './graphify-enricher';
import { buildOrientationInventory } from './orientation-inventory';
import {
  buildOrientationImportGraph,
  mergeHubs,
} from './orientation-import-graph';
import { renderOrientationMarkdown } from './orientation-markdown';
import { buildOrientationSymbols } from './orientation-symbols';
import {
  DEFAULT_ORIENTATION_LIMITS,
  REQUIRED_CONTEXT_DOCS,
  ROOT_DOCS,
  type OrientationEnsureOptions,
  type OrientationLimits,
  type ProjectOrientationMap,
} from './orientation-types';
import { walkOrientationTree } from './orientation-walker';

export interface ProjectOrientationServiceOptions {
  readonly cacheRoot: string;
  readonly limits?: Partial<OrientationLimits>;
  readonly gitRunner?: GitRunner;
  readonly now?: () => number;
  /** When false, skip context doctor (tests / pure inventory). Default true. */
  readonly includeContextSummary?: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileExists(root: string, relative: string): boolean {
  try {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveHeadSha(root: string, git: GitRunner): string | null {
  try {
    const result = git.run(
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

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

export class ProjectOrientationService {
  readonly #cacheRoot: string;
  readonly #limits: OrientationLimits;
  readonly #git: GitRunner;
  readonly #now: () => number;
  readonly #includeContextSummary: boolean;
  readonly #memory = new Map<string, ProjectOrientationMap>();
  readonly #inflight = new Map<string, Promise<ProjectOrientationMap>>();

  constructor(options: ProjectOrientationServiceOptions) {
    if (!options.cacheRoot.trim()) throw new Error('orientation cacheRoot is required');
    this.#cacheRoot = options.cacheRoot;
    this.#limits = Object.freeze({ ...DEFAULT_ORIENTATION_LIMITS, ...options.limits });
    this.#git = options.gitRunner ?? new ProcessGitRunner();
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
    const key = scopeKey(scope);
    if (!options.force) {
      const existing = this.get(scope);
      if (existing && (existing.status === 'ready' || existing.status === 'partial')) {
        const head = resolveHeadSha(scope.rootRealPath, this.#git);
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
        return Promise.race([
          inflight,
          sleep(options.waitMs).then(() => this.get(scope) ?? this.#buildingStub(scope)),
        ]);
      }
      return inflight;
    }
    // Force rebuild: wait for any in-flight build so we never double-write cache.
    if (inflight && options.force) {
      try {
        await inflight;
      } catch {
        // previous build failed; continue with forced rebuild
      }
    }

    const buildPromise = this.#build(scope)
      .then((map) => {
        this.#memory.set(key, map);
        try {
          writeOrientationCache(this.#cacheRoot, scope, map);
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
      return Promise.race([
        buildPromise,
        sleep(options.waitMs).then(() => this.get(scope) ?? this.#buildingStub(scope)),
      ]);
    }
    return buildPromise;
  }

  async refresh(scope: ProjectExecutionScope): Promise<ProjectOrientationMap> {
    return this.ensure(scope, { reason: 'refresh', force: true });
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

  async #build(scope: ProjectExecutionScope): Promise<ProjectOrientationMap> {
    const started = this.#now();
    try {
      const root = fs.realpathSync(scope.rootRealPath);
      if (root !== scope.rootRealPath) throw new Error('project root identity changed');

      const walk = walkOrientationTree(scope, this.#limits);
      const inventory = buildOrientationInventory(scope, walk);
      const symbolSummary = buildOrientationSymbols(scope, walk, this.#limits);
      const importGraph = buildOrientationImportGraph(scope, walk, this.#limits);
      const mergedHubs = mergeHubs(
        symbolSummary.hubs,
        importGraph.hubsByFanIn,
        this.#limits.maxHubs,
      );
      const symbols = Object.freeze({
        ...symbolSummary,
        hubs: mergedHubs,
      });

      let graph = importGraph.graph;
      let graphWarning: string | undefined;
      try {
        const enriched = enrichWithGraphify(scope, { graph, symbols });
        if (enriched) {
          graph = Object.freeze({
            ...enriched.graph,
            adjacency: graph.adjacency,
            reverse: graph.reverse,
          });
          graphWarning = enriched.warning;
        }
      } catch {
        // Graphify is optional; never fail the base map.
      }
      if (graphWarning) {
        graph = Object.freeze({ ...graph, warning: graphWarning });
      }

      const headSha = resolveHeadSha(root, this.#git);
      const treeFingerprint = sha256(walk.treeFingerprintParts.join('\n'));

      const rootDocs = ROOT_DOCS.filter((relative) => fileExists(root, relative));
      const contextDocsPresent = REQUIRED_CONTEXT_DOCS.filter((relative) =>
        fileExists(root, relative),
      );
      const contextDocsMissing = REQUIRED_CONTEXT_DOCS.filter(
        (relative) => !fileExists(root, relative),
      );
      const hasContextScaffold =
        fileExists(root, '.context/config/policy.json') ||
        fs.existsSync(path.join(root, '.context'));

      let contextSummary: ProjectOrientationMap['contextSummary'] = Object.freeze({
        ready: false,
        blockerCodes: Object.freeze([] as string[]),
        warningCodes: Object.freeze([] as string[]),
      });

      if (this.#includeContextSummary) {
        try {
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

      const status = walk.truncated ? 'partial' : 'ready';
      const duration = Math.max(0, this.#now() - started);
      const errors: string[] = [];
      if (walk.truncated) errors.push('inventory truncated by file/byte/depth limits');
      if (graphWarning) errors.push(graphWarning);
      const base = {
        schemaVersion: 1 as const,
        projectId: scope.projectId,
        checkoutId: scope.checkoutId,
        headSha,
        treeFingerprint,
        builtAt: new Date(this.#now()).toISOString(),
        buildDurationMs: duration,
        status: status as 'ready' | 'partial',
        error: errors.length > 0 ? errors.join('; ') : undefined,
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

      const orientationMarkdown = renderOrientationMarkdown(base, this.#limits.markdownMaxChars);
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

      return Object.freeze({
        ...base,
        orientationMarkdown,
        mapHash,
      });
    } catch (error) {
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

/** Test helper: drop the process-wide singleton. */
export function __resetProjectOrientationServiceForTests(): void {
  defaultService = null;
}
