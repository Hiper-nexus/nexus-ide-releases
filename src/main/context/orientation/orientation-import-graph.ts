import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { readWorkspaceTextFile } from '../../orch/workspace-file';
import type {
  OrientationGraphSummary,
  OrientationLimits,
  OrientationSymbolHub,
} from './orientation-types';
import type { OrientationWalkResult, WalkedFile } from './orientation-walker';

const IMPORT_RE =
  /(?:import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+|export\s+(?:type\s+)?[\s\S]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

const TS_JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function stripExt(relative: string): string {
  return relative.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, '');
}

function resolveImport(
  fromFile: string,
  spec: string,
  index: ReadonlyMap<string, string>,
): string | null {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}.mjs`,
    `${joined}.cjs`,
    path.posix.join(joined, 'index.ts'),
    path.posix.join(joined, 'index.tsx'),
    path.posix.join(joined, 'index.js'),
  ];
  for (const candidate of candidates) {
    const hit = index.get(candidate) ?? index.get(stripExt(candidate));
    if (hit) return hit;
  }
  // Fallback: exact key match after normalize without extension.
  for (const [key, value] of index) {
    if (stripExt(key) === stripExt(joined)) return value;
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
  const index = new Map<string, string>();
  for (const file of sources) {
    index.set(file.relativePath, file.relativePath);
    index.set(stripExt(file.relativePath), file.relativePath);
  }

  const adjacency = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  let edgeCount = 0;
  let bytes = 0;

  for (const file of sources) {
    if (bytes > limits.maxTotalBytes) break;
    let content: string;
    try {
      const read = readWorkspaceTextFile(scope, file.relativePath);
      content = read.content;
      bytes += read.size;
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    for (const match of content.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec || !spec.startsWith('.')) continue;
      const target = resolveImport(file.relativePath, spec, index);
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

  // Persist a degree-capped adjacency for blast-radius after cache reload.
  const degree = (file: string) =>
    (adjacency.get(file)?.size ?? 0) + (reverse.get(file)?.size ?? 0);
  const topNodes = [...new Set([...adjacency.keys(), ...reverse.keys()])]
    .sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))
    .slice(0, 200);
  const topSet = new Set(topNodes);
  const adjacencyRecord: Record<string, readonly string[]> = {};
  const reverseRecord: Record<string, readonly string[]> = {};
  for (const node of topNodes) {
    const outs = [...(adjacency.get(node) ?? [])].filter((t) => topSet.has(t));
    const ins = [...(reverse.get(node) ?? [])].filter((t) => topSet.has(t));
    if (outs.length > 0) adjacencyRecord[node] = Object.freeze(outs.sort());
    if (ins.length > 0) reverseRecord[node] = Object.freeze(ins.sort());
  }

  return Object.freeze({
    graph: Object.freeze({
      mode: edgeCount > 0 ? ('imports' as const) : ('none' as const),
      nodeCount: sources.length,
      edgeCount,
      sampleEdges: Object.freeze(sampleEdges),
      enricher: 'none' as const,
      adjacency: Object.freeze(adjacencyRecord),
      reverse: Object.freeze(reverseRecord),
    }),
    adjacency: frozenAdj,
    reverse: frozenRev,
    hubsByFanIn: Object.freeze(fanInHubs),
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
