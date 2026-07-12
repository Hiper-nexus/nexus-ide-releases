import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type {
  OrientationGraphSummary,
  ProjectOrientationMap,
} from './orientation-types';

export interface GraphifyDetectResult {
  readonly available: boolean;
  readonly graphPath?: string;
  readonly stale?: boolean;
  readonly reason?: string;
}

export function detectGraphify(
  scope: ProjectExecutionScope,
): GraphifyDetectResult {
  const root = scope.rootRealPath;
  const graphPath = path.join(root, '.graphify', 'graph.json');
  const needsUpdate = path.join(root, '.graphify', 'needs_update');
  const branchJson = path.join(root, '.graphify', 'branch.json');
  try {
    const stat = fs.lstatSync(graphPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { available: false, reason: 'graph.json is not a regular file' };
    }
  } catch {
    return { available: false, reason: 'no .graphify/graph.json' };
  }

  let stale = false;
  try {
    if (fs.existsSync(needsUpdate)) stale = true;
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(branchJson)) {
      const raw = JSON.parse(fs.readFileSync(branchJson, 'utf8')) as {
        stale?: unknown;
      };
      if (raw.stale === true) stale = true;
    }
  } catch {
    // ignore invalid branch metadata
  }

  return {
    available: true,
    graphPath: '.graphify/graph.json',
    stale,
  };
}

interface GraphifyNode {
  id?: unknown;
  label?: unknown;
  source_file?: unknown;
}

interface GraphifyEdge {
  source?: unknown;
  target?: unknown;
  relation?: unknown;
}

interface GraphifyGraph {
  nodes?: unknown;
  edges?: unknown;
  communities?: unknown;
}

/**
 * Optional enricher. Never fails the base map; returns null when unusable.
 */
export function enrichWithGraphify(
  scope: ProjectExecutionScope,
  base: Pick<ProjectOrientationMap, 'graph' | 'symbols'>,
): {
  graph: OrientationGraphSummary;
  warning?: string;
} | null {
  const detected = detectGraphify(scope);
  if (!detected.available || !detected.graphPath) return null;

  const absolute = path.join(scope.rootRealPath, detected.graphPath);
  let raw: GraphifyGraph;
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32 * 1024 * 1024) {
      return null;
    }
    raw = JSON.parse(fs.readFileSync(absolute, 'utf8')) as GraphifyGraph;
  } catch {
    return null;
  }

  const nodes = Array.isArray(raw.nodes) ? (raw.nodes as GraphifyNode[]) : [];
  const edges = Array.isArray(raw.edges) ? (raw.edges as GraphifyEdge[]) : [];
  if (nodes.length === 0 && edges.length === 0) return null;

  const idToLabel = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node.id !== 'string') continue;
    const label =
      typeof node.label === 'string' && node.label.trim()
        ? node.label.trim()
        : node.id;
    idToLabel.set(node.id, label.slice(0, 128));
  }

  const sampleEdges = edges
    .map((edge) => {
      if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
        return null;
      }
      const from = idToLabel.get(edge.source) ?? edge.source;
      const to = idToLabel.get(edge.target) ?? edge.target;
      const relation =
        typeof edge.relation === 'string' && /call/i.test(edge.relation)
          ? ('calls' as const)
          : ('imports' as const);
      return Object.freeze({ from: from.slice(0, 160), to: to.slice(0, 160), relation });
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .slice(0, 24);

  const mode =
    base.graph.mode === 'imports' || sampleEdges.some((e) => e.relation === 'calls')
      ? sampleEdges.some((e) => e.relation === 'calls')
        ? ('imports+calls' as const)
        : ('enriched' as const)
      : ('enriched' as const);

  return {
    graph: Object.freeze({
      mode,
      nodeCount: Math.max(base.graph.nodeCount, nodes.length),
      edgeCount: Math.max(base.graph.edgeCount, edges.length),
      sampleEdges: Object.freeze(
        sampleEdges.length > 0 ? sampleEdges : base.graph.sampleEdges,
      ),
      enricher: 'graphify' as const,
    }),
    warning: detected.stale
      ? 'Graphify graph is marked stale; using as advisory enrichment only'
      : undefined,
  };
}
