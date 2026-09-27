import type { OrientationStatus } from '../../../shared/orientation-types';

export type { OrientationStatus };

export interface OrientationLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
  readonly buildBudgetMs: number;
  readonly markdownMaxChars: number;
  readonly maxHubs: number;
  /** Cap on graph nodes persisted to the on-disk adjacency (both import and db nodes). */
  readonly maxPersistedGraphNodes: number;
  /** Byte-size ceiling for the persisted adjacency+reverse records combined. */
  readonly maxPersistedGraphBytes: number;
  /** Cap on distinct schema entities (tables/functions) surfaced on the map. */
  readonly maxDbEntities: number;
}

export const DEFAULT_ORIENTATION_LIMITS: OrientationLimits = Object.freeze({
  maxFiles: 50_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxDepth: 16,
  buildBudgetMs: 30_000,
  markdownMaxChars: 12_000,
  maxHubs: 24,
  maxPersistedGraphNodes: 200,
  maxPersistedGraphBytes: 512 * 1024,
  maxDbEntities: 200,
});

export interface OrientationLanguageStat {
  readonly id: string;
  readonly files: number;
  readonly bytes: number;
}

export interface OrientationDirStat {
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
}

export interface OrientationInventory {
  readonly languages: readonly OrientationLanguageStat[];
  readonly topDirs: readonly OrientationDirStat[];
  readonly entrypoints: readonly string[];
  readonly manifests: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly packageManagers: readonly string[];
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly bytesScanned: number;
  readonly projectName: string | null;
}

export interface OrientationSymbolHub {
  readonly name: string;
  readonly score: number;
  readonly samplePaths: readonly string[];
}

export interface OrientationSymbolSummary {
  readonly filesScanned: number;
  readonly symbolCount: number;
  readonly hubs: readonly OrientationSymbolHub[];
  readonly coverage: readonly string[];
  readonly symbols: ReadonlySet<string>;
}

export interface OrientationGraphSummary {
  readonly mode: 'none' | 'imports' | 'imports+calls' | 'enriched';
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly sampleEdges: readonly {
    readonly from: string;
    readonly to: string;
    readonly relation: 'imports' | 'calls' | 'reads' | 'writes';
  }[];
  readonly enricher: 'none' | 'graphify';
  /**
   * Compact adjacency for blast-radius (capped). Paths are repo-relative, but
   * a node may also be a db entity id (see OrientationDbEntity.nodeId) when
   * schema↔code edges were detected.
   */
  readonly adjacency?: Readonly<Record<string, readonly string[]>>;
  readonly reverse?: Readonly<Record<string, readonly string[]>>;
  readonly warning?: string;
  /** Schema entities (tables/functions) detected across migrations/ORM sources. */
  readonly dbEntities?: readonly OrientationDbEntity[];
  /** Count of reads/writes/calls edges contributed by the db-usage extractor. */
  readonly dbEdgeCount?: number;
}

export type OrientationDbEntityKind = 'table' | 'function';

/**
 * A schema node (table or function) discovered from migrations/.prisma/drizzle
 * sources. `nodeId` is the stable graph node id (see dbNodeId in
 * orientation-schema.ts) usable as a seedFile/adjacency key for blast radius.
 */
export interface OrientationDbEntity {
  readonly nodeId: string;
  readonly kind: OrientationDbEntityKind;
  /** Bare name, e.g. "comandas". */
  readonly name: string;
  /** schema.name, e.g. "public.comandas". */
  readonly qualifiedName: string;
  readonly definedIn: readonly string[];
  readonly rlsEnabled?: boolean;
}

export interface OrientationDocsPresence {
  readonly rootDocs: readonly string[];
  readonly contextDocsPresent: readonly string[];
  readonly contextDocsMissing: readonly string[];
  readonly hasContextScaffold: boolean;
}

export interface OrientationContextSummary {
  readonly ready: boolean;
  readonly contextRevision?: string;
  readonly blockerCodes: readonly string[];
  readonly warningCodes: readonly string[];
}

export interface ProjectOrientationMap {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly headSha: string | null;
  readonly treeFingerprint: string;
  readonly builtAt: string;
  readonly buildDurationMs: number;
  readonly status: OrientationStatus;
  readonly error?: string;
  readonly limits: OrientationLimits;
  readonly inventory: OrientationInventory;
  readonly symbols: OrientationSymbolSummary;
  readonly graph: OrientationGraphSummary;
  readonly docs: OrientationDocsPresence;
  readonly contextSummary: OrientationContextSummary;
  readonly orientationMarkdown: string;
  readonly mapHash: string;
}

export type OrientationEnsureReason =
  | 'workspace-open'
  | 'refresh'
  | 'pre-kickoff'
  | 'head-change'
  | 'mcp';

export interface OrientationEnsureOptions {
  readonly reason: OrientationEnsureReason;
  readonly waitMs?: number;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

/** Serializable map without the in-memory symbol Set. */
export interface ProjectOrientationMapJson {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly headSha: string | null;
  readonly treeFingerprint: string;
  readonly builtAt: string;
  readonly buildDurationMs: number;
  readonly status: OrientationStatus;
  readonly error?: string;
  readonly limits: OrientationLimits;
  readonly inventory: OrientationInventory;
  readonly symbols: {
    readonly filesScanned: number;
    readonly symbolCount: number;
    readonly hubs: readonly OrientationSymbolHub[];
    readonly coverage: readonly string[];
  };
  readonly graph: OrientationGraphSummary;
  readonly docs: OrientationDocsPresence;
  readonly contextSummary: OrientationContextSummary;
  readonly orientationMarkdown: string;
  readonly mapHash: string;
}

export const SKIP_DIRECTORIES = Object.freeze(
  new Set([
    '.git',
    '.nexus',
    '.claude',
    '.codex',
    '.context',
    '.gemini',
    '.peer-ade-app',
    '.worktrees',
    '.nexus-memory',
    'worktrees',
    '.graphify',
    '.vite',
    '.dev-user-data',
    '.dev-electron',
    'node_modules',
    'vendor',
    'dist',
    'build',
    'coverage',
    '.next',
    '.turbo',
    'target',
    '__pycache__',
    '.venv',
    'venv',
    'out',
    '.cache',
    'graphify-out',
    'release-assets',
  ]),
);

export const SOURCE_EXTENSIONS = Object.freeze(
  new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.kts',
    '.cs',
    '.c',
    '.h',
    '.cpp',
    '.hpp',
    '.rb',
    '.php',
    '.swift',
    '.scala',
    '.sql',
    '.graphql',
    '.gql',
    '.prisma',
  ]),
);

export const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java',
  '.kt': 'kt',
  '.kts': 'kt',
  '.cs': 'cs',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.rb': 'rb',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.prisma': 'prisma',
});

export const ROOT_DOCS = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'DESIGN.md',
  'README.md',
  'PRODUCT.md',
] as const);

export const REQUIRED_CONTEXT_DOCS = Object.freeze([
  '.context/docs/project-overview.md',
  '.context/docs/business-model.md',
  '.context/docs/domain-glossary.md',
  '.context/docs/architecture.md',
  '.context/docs/testing.md',
] as const);

export const SECRET_BASENAME_PATTERN =
  /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519|credentials\.json|secrets?\.(?:json|ya?ml))$/i;
