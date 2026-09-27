import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  expandImportBlastRadius,
  matchFilesByQuery,
} from './orientation-import-graph';
import {
  tryGetProjectOrientationService,
  type ProjectOrientationService,
} from './orientation-service';
import type { ProjectOrientationMap } from './orientation-types';

export interface BlastRadiusInput {
  readonly goal?: string;
  readonly seedFiles?: readonly string[];
  readonly seedSymbols?: readonly string[];
  readonly depth?: number;
  readonly maxFiles?: number;
}

export interface BlastRadiusResult {
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];
  readonly hubs: readonly string[];
  /**
   * Test files reached within the radius (by import edges, db-table/function
   * edges, or same-basename convention against the persisted graph's known
   * nodes). Subset of `files` — a portao-regressao consumer can require these
   * to be green before allowing a merge.
   */
  readonly tests: readonly string[];
  readonly mapHash: string | null;
  readonly source: 'orientation' | 'empty';
}

// Mirrors candidate-quality-analysis.ts's TEST_FILE_RE convention.
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/iu;

function fileStem(relativePath: string): string {
  return path.posix.basename(relativePath).replace(/\.[^.]+$/u, '');
}

/**
 * Beyond the BFS-reached files, pull in same-basename test files from the
 * persisted graph's known node universe even when nothing imports them
 * (black-box tests that only exercise the module by convention).
 */
function stemMatchedTests(
  files: readonly string[],
  map: ProjectOrientationMap,
): string[] {
  const fileSet = new Set(files);
  const nonTestStems = new Set(
    files
      .filter((f) => !f.startsWith('db:') && !TEST_FILE_PATTERN.test(f))
      .map((f) => fileStem(f)),
  );
  if (nonTestStems.size === 0) return [];
  const knownNodes = new Set<string>([
    ...Object.keys(map.graph.adjacency ?? {}),
    ...Object.keys(map.graph.reverse ?? {}),
  ]);
  const extra: string[] = [];
  for (const node of knownNodes) {
    if (fileSet.has(node) || node.startsWith('db:') || !TEST_FILE_PATTERN.test(node)) continue;
    const stem = fileStem(node).replace(/\.(?:test|spec)$/i, '');
    if (nonTestStems.has(stem)) extra.push(node);
  }
  return extra;
}

function domainsFromFiles(files: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    if (parts[0] === 'src' && parts[1]) domains.add(parts[1].toLowerCase());
    else if (parts[0]) domains.add(parts[0].toLowerCase());
  }
  return [...domains].sort().slice(0, 16);
}

function symbolsFromMap(
  map: ProjectOrientationMap,
  files: readonly string[],
  seedSymbols: readonly string[],
): string[] {
  const fileSet = new Set(files);
  const out = new Set<string>(seedSymbols);
  for (const hub of map.symbols.hubs) {
    if (hub.samplePaths.some((p) => fileSet.has(p))) out.add(hub.name);
  }
  return [...out].sort((a, b) => a.localeCompare(b)).slice(0, 48);
}

/**
 * Compute advisory blast radius from the orientation map.
 * Purely structural — never business authority.
 */
export function computeBlastRadius(
  map: ProjectOrientationMap,
  input: BlastRadiusInput,
): BlastRadiusResult {
  const goal = input.goal?.trim() ?? '';
  const seedFiles = new Set<string>(
    (input.seedFiles ?? []).map((f) => f.replaceAll('\\', '/')),
  );

  if (goal) {
    for (const hub of map.symbols.hubs) {
      if (goal.toLowerCase().includes(hub.name.toLowerCase())) {
        for (const p of hub.samplePaths) seedFiles.add(p);
      }
    }
    // Lightweight path matching from inventory entrypoints + hub paths.
    const corpus = [
      ...map.inventory.entrypoints,
      ...map.symbols.hubs.flatMap((h) => h.samplePaths),
      ...map.graph.sampleEdges.flatMap((e) => [e.from, e.to]),
    ];
    for (const candidate of corpus) {
      if (!candidate.includes('/') && !candidate.includes('.')) continue;
      const lower = candidate.toLowerCase();
      const tokens = goal.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
      if (tokens.some((t) => lower.includes(t))) seedFiles.add(candidate);
    }
  }

  for (const symbol of input.seedSymbols ?? []) {
    for (const hub of map.symbols.hubs) {
      if (hub.name === symbol || hub.name.toLowerCase() === symbol.toLowerCase()) {
        for (const p of hub.samplePaths) seedFiles.add(p);
      }
    }
  }

  // Seed from db entities (tables/functions) separately from symbol hubs:
  // schemas can have far more tables than the maxHubs cap allows, so they get
  // their own uncapped registry (see OrientationGraphSummary.dbEntities).
  const dbEntities = map.graph.dbEntities ?? [];
  const goalLower = goal.toLowerCase();
  for (const entity of dbEntities) {
    const nameLower = entity.name.toLowerCase();
    if (goalLower && goalLower.includes(nameLower) && nameLower.length > 2) {
      seedFiles.add(entity.nodeId);
    }
    for (const symbol of input.seedSymbols ?? []) {
      if (symbol.toLowerCase() === nameLower || symbol.toLowerCase() === entity.qualifiedName.toLowerCase()) {
        seedFiles.add(entity.nodeId);
      }
    }
  }

  // If graph has edges, expand; else use seeds + top hubs as weak radius.
  const hasGraph =
    map.graph.edgeCount > 0 &&
    (Boolean(map.graph.adjacency) || map.graph.sampleEdges.length > 0);
  let files: string[];
  if (hasGraph && seedFiles.size > 0) {
    const adjacency = new Map<string, readonly string[]>();
    const reverse = new Map<string, readonly string[]>();
    if (map.graph.adjacency) {
      for (const [from, tos] of Object.entries(map.graph.adjacency)) {
        adjacency.set(from, tos);
      }
    }
    if (map.graph.reverse) {
      for (const [to, froms] of Object.entries(map.graph.reverse)) {
        reverse.set(to, froms);
      }
    }
    if (adjacency.size === 0) {
      for (const edge of map.graph.sampleEdges) {
        if (!edge.from.includes('/') || !edge.to.includes('/')) continue;
        const outs = adjacency.get(edge.from) ?? [];
        adjacency.set(edge.from, Object.freeze([...outs, edge.to]));
        const ins = reverse.get(edge.to) ?? [];
        reverse.set(edge.to, Object.freeze([...ins, edge.from]));
      }
    }
    files = [
      ...expandImportBlastRadius(
        [...seedFiles],
        adjacency,
        reverse,
        input.depth ?? 2,
        input.maxFiles ?? 64,
      ),
    ];
  } else if (seedFiles.size > 0) {
    files = [...seedFiles].sort((a, b) => a.localeCompare(b)).slice(0, input.maxFiles ?? 64);
  } else {
    files = map.symbols.hubs
      .flatMap((h) => h.samplePaths)
      .filter((p) => p.includes('/'))
      .slice(0, 16);
  }

  const hubs = map.symbols.hubs
    .filter((h) => h.samplePaths.some((p) => files.includes(p)))
    .map((h) => h.name)
    .slice(0, 24);

  const tests = [...new Set([
    ...files.filter((f) => TEST_FILE_PATTERN.test(f)),
    ...stemMatchedTests(files, map),
  ])].sort((a, b) => a.localeCompare(b));

  return Object.freeze({
    files: Object.freeze(files),
    symbols: Object.freeze(symbolsFromMap(map, files, input.seedSymbols ?? [])),
    domains: Object.freeze(domainsFromFiles(files)),
    hubs: Object.freeze(hubs),
    tests: Object.freeze(tests),
    mapHash: map.mapHash,
    source: 'orientation' as const,
  });
}

export async function ensureBlastRadius(
  scope: ProjectExecutionScope,
  input: BlastRadiusInput,
  service?: ProjectOrientationService | null,
): Promise<BlastRadiusResult> {
  const orientation =
    service ?? tryGetProjectOrientationService();
  if (!orientation) {
    return Object.freeze({
      files: Object.freeze([]),
      symbols: Object.freeze([...(input.seedSymbols ?? [])]),
      domains: Object.freeze([]),
      hubs: Object.freeze([]),
      tests: Object.freeze([]),
      mapHash: null,
      source: 'empty' as const,
    });
  }
  const map = await orientation.ensure(scope, { reason: 'mcp', waitMs: 5_000 });
  return computeBlastRadius(map, input);
}

/** Expand worktree ownership with structural neighbors (advisory, additive). */
export function expandOwnershipWithBlastRadius(
  ownership: {
    readonly files: readonly string[];
    readonly symbols: readonly string[];
    readonly domains: readonly string[];
  },
  map: ProjectOrientationMap | null,
): {
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];
  readonly expanded: boolean;
} {
  if (!map || ownership.files.length === 0) {
    return { ...ownership, expanded: false };
  }
  const radius = computeBlastRadius(map, {
    seedFiles: ownership.files,
    seedSymbols: ownership.symbols,
    depth: 1,
    maxFiles: 48,
  });
  const files = Object.freeze(
    [...new Set([...ownership.files, ...radius.files])]
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => !f.startsWith('.context/') && f !== '.nexus/project.json')
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 256),
  );
  const symbols = Object.freeze(
    [...new Set([...ownership.symbols, ...radius.symbols])]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 256),
  );
  const domains = Object.freeze(
    [...new Set([...ownership.domains, ...radius.domains])]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 64),
  );
  const expanded =
    files.length > ownership.files.length ||
    symbols.length > ownership.symbols.length;
  return Object.freeze({ files, symbols, domains, expanded });
}

export function matchFilesByGoalFromMap(
  map: ProjectOrientationMap,
  goal: string,
): string[] {
  const fakeFiles = [
    ...map.inventory.entrypoints.map((relativePath) => ({
      relativePath,
      ext: path.posix.extname(relativePath),
      language: null as string | null,
      size: 0,
      isSource: true,
      isSecretName: false,
    })),
    ...map.symbols.hubs.flatMap((hub) =>
      hub.samplePaths.map((relativePath) => ({
        relativePath,
        ext: path.posix.extname(relativePath),
        language: null as string | null,
        size: 0,
        isSource: true,
        isSecretName: false,
      })),
    ),
  ];
  return matchFilesByQuery(fakeFiles, goal, 24);
}
