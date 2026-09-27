import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { readWorkspaceTextFile } from '../../orch/workspace-file';
import type {
  OrientationGraphSummary,
  OrientationLimits,
  OrientationSymbolHub,
} from './orientation-types';
import type { OrientationWalkResult, WalkedFile } from './orientation-walker';
import {
  sortOrientationItems,
  throwIfOrientationAborted,
  yieldOrientationWork,
} from './orientation-cooperative';
import {
  loadTsconfigAliases,
  resolveAliasCandidateBases,
  type TsconfigAliasMap,
} from './orientation-tsconfig';
import { scanJsTokens } from './orientation-js-scan';

const TS_JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface OrientationImportFileFact {
  readonly relativePath: string;
  readonly ext: string;
  readonly size: number;
  readonly importSpecifiers: readonly string[];
}

export function isOrientationImportSource(ext: string): boolean {
  return TS_JS_EXT.has(ext);
}

/**
 * Extract every import/require/dynamic-import specifier, relative or not.
 * Bare package specifiers (e.g. "react") are kept too — resolveImport simply
 * returns null for anything it cannot resolve (no known alias, no relative
 * match), so they never become graph edges; keeping them here means an alias
 * like "@/foo" is available for resolution once tsconfig paths are loaded.
 */
export function extractOrientationImportSpecifiers(
  content: string,
): readonly string[] {
  // Token-based (see orientation-js-scan.ts): linear in the input, ignores
  // comments/strings, and keeps bare side-effect imports.
  const tokens = scanJsTokens(content);
  const specifiers: string[] = [];
  const isPunct = (index: number, value: string) =>
    tokens[index]?.kind === 'punct' && tokens[index].value === value;
  const stringAt = (index: number): string | null =>
    tokens[index]?.kind === 'string' ? tokens[index].value : null;
  // After `import x`/`export {...}`, the next `from '...'` closes the clause.
  let pendingFrom = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const afterDot = isPunct(index - 1, '.');
    if (token.kind === 'ident' && !afterDot) {
      if (token.value === 'import') {
        const bare = stringAt(index + 1);
        const dynamic = isPunct(index + 1, '(') ? stringAt(index + 2) : null;
        if (bare !== null || dynamic !== null) {
          specifiers.push((bare ?? dynamic)!);
          pendingFrom = false;
        } else {
          pendingFrom = !isPunct(index + 1, '.') && !isPunct(index + 1, '(');
        }
        continue;
      }
      if (token.value === 'export') {
        pendingFrom = true;
        continue;
      }
      if (token.value === 'require' && isPunct(index + 1, '(')) {
        const required = stringAt(index + 2);
        if (required !== null) specifiers.push(required);
        continue;
      }
      if (pendingFrom && token.value === 'from') {
        const from = stringAt(index + 1);
        if (from !== null) specifiers.push(from);
        pendingFrom = false;
        continue;
      }
    }
    if (
      pendingFrom &&
      (token.kind === 'string' || token.kind === 'template' || isPunct(index, ';'))
    ) {
      pendingFrom = false;
    }
  }
  return Object.freeze(specifiers.filter((specifier) => specifier.length > 0));
}

export interface CappedAdjacency {
  readonly adjacencyRecord: Readonly<Record<string, readonly string[]>>;
  readonly reverseRecord: Readonly<Record<string, readonly string[]>>;
  readonly nodeCount: number;
}

/**
 * Persist a degree-capped adjacency for blast-radius after cache reload.
 * Nodes are kept in degree-descending order until either the configured node
 * cap or the byte budget is reached, whichever comes first. Each node is
 * charged the compact-JSON size of its key in both records plus every
 * neighbor string it could carry, so the serialized adjacency+reverse never
 * exceeds maxPersistedGraphBytes (neighbors that do not survive only shrink
 * it). The first node is always kept.
 */
export function capPersistedAdjacency(
  adjacency: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>,
  reverse: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>,
  limits: Pick<OrientationLimits, 'maxPersistedGraphNodes' | 'maxPersistedGraphBytes'>,
): CappedAdjacency {
  const countOf = (value: ReadonlySet<string> | readonly string[] | undefined): number =>
    value ? ('size' in value ? value.size : value.length) : 0;
  const degree = (node: string) => countOf(adjacency.get(node)) + countOf(reverse.get(node));
  const candidates = [...new Set([...adjacency.keys(), ...reverse.keys()])].sort(
    (a, b) => degree(b) - degree(a) || a.localeCompare(b),
  );
  // `"key":[` + `]` + `,` in each record, plus `"neighbor",` per entry.
  const persistedBytes = (node: string): number => {
    let bytes = 2 * (JSON.stringify(node).length + 4);
    for (const neighbor of adjacency.get(node) ?? []) bytes += JSON.stringify(neighbor).length + 1;
    for (const neighbor of reverse.get(node) ?? []) bytes += JSON.stringify(neighbor).length + 1;
    return bytes;
  };

  const keptNodes: string[] = [];
  // `{"adjacency":{},"reverse":{}}` envelope.
  let bytes = 29;
  for (const node of candidates) {
    if (keptNodes.length >= limits.maxPersistedGraphNodes) break;
    const cost = persistedBytes(node);
    if (keptNodes.length > 0 && bytes + cost > limits.maxPersistedGraphBytes) break;
    keptNodes.push(node);
    bytes += cost;
  }
  const keptSet = new Set(keptNodes);

  const adjacencyRecord: Record<string, readonly string[]> = {};
  const reverseRecord: Record<string, readonly string[]> = {};
  for (const node of keptNodes) {
    const outs = [...(adjacency.get(node) ?? [])].filter((t) => keptSet.has(t)).sort();
    const ins = [...(reverse.get(node) ?? [])].filter((t) => keptSet.has(t)).sort();
    if (outs.length > 0) adjacencyRecord[node] = Object.freeze(outs);
    if (ins.length > 0) reverseRecord[node] = Object.freeze(ins);
  }

  return Object.freeze({
    adjacencyRecord: Object.freeze(adjacencyRecord),
    reverseRecord: Object.freeze(reverseRecord),
    nodeCount: keptNodes.length,
  });
}

function stripExt(relative: string): string {
  return relative.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, '');
}

function tryResolveBase(
  base: string,
  index: ReadonlyMap<string, string>,
): string | null {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    const hit = index.get(candidate) ?? index.get(stripExt(candidate));
    if (hit) return hit;
  }
  return index.get(stripExt(base)) ?? null;
}

function resolveImport(
  fromFile: string,
  spec: string,
  index: ReadonlyMap<string, string>,
  aliases?: TsconfigAliasMap | null,
): string | null {
  if (spec.startsWith('.')) {
    const fromDir = path.posix.dirname(fromFile);
    const joined = path.posix.normalize(path.posix.join(fromDir, spec));
    return tryResolveBase(joined, index);
  }
  if (aliases) {
    for (const base of resolveAliasCandidateBases(spec, aliases)) {
      const hit = tryResolveBase(base, index);
      if (hit) return hit;
    }
  }
  return null;
}

export interface ImportGraphBuildResult {
  readonly graph: OrientationGraphSummary;
  /** file -> imported files */
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  /** file -> importers */
  readonly reverse: ReadonlyMap<string, readonly string[]>;
  readonly hubsByFanIn: readonly OrientationSymbolHub[];
}

/**
 * Best-effort relative import graph for TS/JS. No package resolution.
 */
export function buildOrientationImportGraph(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
  limits: OrientationLimits,
): ImportGraphBuildResult {
  const sources = walk.files.filter(
    (file) => file.isSource && TS_JS_EXT.has(file.ext),
  );
  const facts: OrientationImportFileFact[] = [];
  let bytes = 0;
  for (const file of sources) {
    if (bytes > limits.maxTotalBytes) break;
    try {
      const read = readWorkspaceTextFile(scope, file.relativePath);
      bytes += read.size;
      facts.push(Object.freeze({
        relativePath: file.relativePath,
        ext: file.ext,
        size: read.size,
        importSpecifiers: extractOrientationImportSpecifiers(read.content),
      }));
    } catch {
      continue;
    }
  }
  return buildOrientationImportGraphFromFacts(facts, limits, loadTsconfigAliases(scope));
}

export function buildOrientationImportGraphFromFacts(
  sources: readonly OrientationImportFileFact[],
  limits: OrientationLimits,
  aliases?: TsconfigAliasMap | null,
): ImportGraphBuildResult {
  const index = new Map<string, string>();
  for (const file of sources) {
    index.set(file.relativePath, file.relativePath);
    index.set(stripExt(file.relativePath), file.relativePath);
  }

  const adjacency = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  let edgeCount = 0;

  for (const file of sources) {
    for (const spec of file.importSpecifiers) {
      const target = resolveImport(file.relativePath, spec, index, aliases);
      if (!target || target === file.relativePath) continue;
      if (!adjacency.has(file.relativePath)) adjacency.set(file.relativePath, new Set());
      if (!reverse.has(target)) reverse.set(target, new Set());
      const fromSet = adjacency.get(file.relativePath)!;
      if (fromSet.has(target)) continue;
      fromSet.add(target);
      reverse.get(target)!.add(file.relativePath);
      edgeCount += 1;
    }
  }

  const fanInHubs: OrientationSymbolHub[] = [...reverse.entries()]
    .map(([file, importers]) =>
      Object.freeze({
        name: path.posix.basename(file, path.posix.extname(file)),
        score: importers.size * 3,
        samplePaths: Object.freeze([file, ...[...importers].slice(0, 2)]),
      }),
    )
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limits.maxHubs);

  const sampleEdges = [...adjacency.entries()]
    .flatMap(([from, targets]) =>
      [...targets].map((to) =>
        Object.freeze({ from, to, relation: 'imports' as const }),
      ),
    )
    .sort((a, b) => {
      const fanA = reverse.get(a.to)?.size ?? 0;
      const fanB = reverse.get(b.to)?.size ?? 0;
      return fanB - fanA || a.from.localeCompare(b.from);
    })
    .slice(0, 24);

  const frozenAdj = new Map<string, readonly string[]>();
  for (const [key, value] of adjacency) {
    frozenAdj.set(key, Object.freeze([...value].sort()));
  }
  const frozenRev = new Map<string, readonly string[]>();
  for (const [key, value] of reverse) {
    frozenRev.set(key, Object.freeze([...value].sort()));
  }

  const capped = capPersistedAdjacency(adjacency, reverse, limits);

  return Object.freeze({
    graph: Object.freeze({
      mode: edgeCount > 0 ? ('imports' as const) : ('none' as const),
      nodeCount: sources.length,
      edgeCount,
      sampleEdges: Object.freeze(sampleEdges),
      enricher: 'none' as const,
      adjacency: capped.adjacencyRecord,
      reverse: capped.reverseRecord,
    }),
    adjacency: frozenAdj,
    reverse: frozenRev,
    hubsByFanIn: Object.freeze(fanInHubs),
  });
}

function insertBounded<T>(
  values: T[],
  candidate: T,
  compare: (left: T, right: T) => number,
  limit: number,
): void {
  let insertion = values.findIndex((value) => compare(candidate, value) < 0);
  if (insertion < 0) insertion = values.length;
  values.splice(insertion, 0, candidate);
  if (values.length > limit) values.pop();
}

export async function buildOrientationImportGraphFromFactsAsync(
  sources: readonly OrientationImportFileFact[],
  limits: OrientationLimits,
  aliases?: TsconfigAliasMap | null,
  signal?: AbortSignal,
): Promise<ImportGraphBuildResult> {
  throwIfOrientationAborted(signal);
  const index = new Map<string, string>();
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const file = sources[sourceIndex];
    index.set(file.relativePath, file.relativePath);
    index.set(stripExt(file.relativePath), file.relativePath);
    if (sourceIndex > 0 && sourceIndex % 512 === 0) {
      await yieldOrientationWork(signal);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  let edgeCount = 0;
  let specifiers = 0;
  for (const file of sources) {
    for (const spec of file.importSpecifiers) {
      const target = resolveImport(file.relativePath, spec, index, aliases);
      if (target && target !== file.relativePath) {
        if (!adjacency.has(file.relativePath)) {
          adjacency.set(file.relativePath, new Set());
        }
        if (!reverse.has(target)) reverse.set(target, new Set());
        const fromSet = adjacency.get(file.relativePath)!;
        if (!fromSet.has(target)) {
          fromSet.add(target);
          reverse.get(target)!.add(file.relativePath);
          edgeCount += 1;
        }
      }
      specifiers += 1;
      if (specifiers % 2_048 === 0) await yieldOrientationWork(signal);
    }
  }

  const hubCandidates: OrientationSymbolHub[] = [];
  let processed = 0;
  for (const [file, importers] of reverse.entries()) {
    hubCandidates.push(Object.freeze({
      name: path.posix.basename(file, path.posix.extname(file)),
      score: importers.size * 3,
      samplePaths: Object.freeze([file, ...[...importers].slice(0, 2)]),
    }));
    processed += 1;
    if (processed % 512 === 0) await yieldOrientationWork(signal);
  }
  const sortedHubs = await sortOrientationItems(
    hubCandidates,
    (left, right) =>
      right.score - left.score || left.name.localeCompare(right.name),
    signal,
  );
  const fanInHubs = Object.freeze(sortedHubs.slice(0, limits.maxHubs));

  type SampleEdge = OrientationGraphSummary['sampleEdges'][number];
  const edgeComparison = (left: SampleEdge, right: SampleEdge) => {
    const fanLeft = reverse.get(left.to)?.size ?? 0;
    const fanRight = reverse.get(right.to)?.size ?? 0;
    return fanRight - fanLeft || left.from.localeCompare(right.from);
  };
  const sampleEdges: SampleEdge[] = [];
  processed = 0;
  for (const [from, targets] of adjacency.entries()) {
    for (const to of targets) {
      insertBounded(
        sampleEdges,
        Object.freeze({ from, to, relation: 'imports' as const }),
        edgeComparison,
        24,
      );
      processed += 1;
      if (processed % 2_048 === 0) await yieldOrientationWork(signal);
    }
  }

  const frozenAdj = new Map<string, readonly string[]>();
  for (const [key, value] of adjacency) {
    frozenAdj.set(
      key,
      await sortOrientationItems(
        [...value],
        (left, right) => left.localeCompare(right),
        signal,
      ),
    );
    processed += 1;
    if (processed % 512 === 0) await yieldOrientationWork(signal);
  }
  const frozenRev = new Map<string, readonly string[]>();
  for (const [key, value] of reverse) {
    frozenRev.set(
      key,
      await sortOrientationItems(
        [...value],
        (left, right) => left.localeCompare(right),
        signal,
      ),
    );
    processed += 1;
    if (processed % 512 === 0) await yieldOrientationWork(signal);
  }

  await yieldOrientationWork(signal);
  const capped = capPersistedAdjacency(adjacency, reverse, limits);

  return Object.freeze({
    graph: Object.freeze({
      mode: edgeCount > 0 ? ('imports' as const) : ('none' as const),
      nodeCount: sources.length,
      edgeCount,
      sampleEdges: Object.freeze(sampleEdges),
      enricher: 'none' as const,
      adjacency: capped.adjacencyRecord,
      reverse: capped.reverseRecord,
    }),
    adjacency: frozenAdj,
    reverse: frozenRev,
    hubsByFanIn: fanInHubs,
  });
}

export function mergeHubs(
  declarationHubs: readonly OrientationSymbolHub[],
  fanInHubs: readonly OrientationSymbolHub[],
  maxHubs: number,
): readonly OrientationSymbolHub[] {
  const map = new Map<string, OrientationSymbolHub>();
  for (const hub of [...declarationHubs, ...fanInHubs]) {
    const existing = map.get(hub.name);
    if (!existing || hub.score > existing.score) {
      map.set(hub.name, hub);
    } else if (existing) {
      const paths = new Set([...existing.samplePaths, ...hub.samplePaths]);
      map.set(
        hub.name,
        Object.freeze({
          name: hub.name,
          score: existing.score + Math.min(hub.score, 5),
          samplePaths: Object.freeze([...paths].slice(0, 3)),
        }),
      );
    }
  }
  return Object.freeze(
    [...map.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, maxHubs),
  );
}

/** Collect blast-radius files around seeds (BFS on import graph). */
export function expandImportBlastRadius(
  seeds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  reverse: ReadonlyMap<string, readonly string[]>,
  depth = 2,
  maxFiles = 64,
): readonly string[] {
  const normalizedSeeds = seeds.map((s) => s.replaceAll('\\', '/'));
  const seen = new Set<string>(normalizedSeeds);
  let frontier = [...normalizedSeeds];
  for (let d = 0; d < depth && frontier.length > 0; d += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const neigh of [
        ...(adjacency.get(file) ?? []),
        ...(reverse.get(file) ?? []),
      ]) {
        if (seen.has(neigh)) continue;
        seen.add(neigh);
        next.push(neigh);
        if (seen.size >= maxFiles) {
          return Object.freeze([...seen].sort((a, b) => a.localeCompare(b)));
        }
      }
    }
    frontier = next;
  }
  return Object.freeze([...seen].sort((a, b) => a.localeCompare(b)));
}

export function matchFilesByQuery(
  files: readonly WalkedFile[],
  query: string,
  limit = 32,
): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/i)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const scored: Array<{ path: string; score: number }> = [];
  for (const file of files) {
    if (!file.isSource) continue;
    const hay = file.relativePath.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (hay.includes(token)) score += token.length;
    }
    if (score > 0) scored.push({ path: file.relativePath, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((item) => item.path);
}
