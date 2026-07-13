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
}

export const DEFAULT_ORIENTATION_LIMITS: OrientationLimits = Object.freeze({
  maxFiles: 50_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxDepth: 16,
  buildBudgetMs: 30_000,
  markdownMaxChars: 12_000,
  maxHubs: 24,
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
    readonly relation: 'imports' | 'calls';
  }[];
  readonly enricher: 'none' | 'graphify';
  /**
   * Compact adjacency for blast-radius (capped). Paths are repo-relative.
   * Absent when mode is none or graph was not built.
   */
  readonly adjacency?: Readonly<Record<string, readonly string[]>>;
  readonly reverse?: Readonly<Record<string, readonly string[]>>;
  readonly warning?: string;
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
