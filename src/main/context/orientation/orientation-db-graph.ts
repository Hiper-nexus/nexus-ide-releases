import type { DbUsageEdge, DbUsageRelation } from './orientation-db-usage';
import {
  capPersistedAdjacency,
  type ImportGraphBuildResult,
} from './orientation-import-graph';
import { dbNodeId, sortSchemaPathsByTimestamp, type SchemaEntityFact } from './orientation-schema';
import type {
  OrientationDbEntity,
  OrientationDbEntityKind,
  OrientationGraphSummary,
  OrientationLimits,
} from './orientation-types';

export interface DbGraphInputFile {
  readonly relativePath: string;
  readonly schemaFacts: readonly SchemaEntityFact[];
  readonly usageEdges: readonly DbUsageEdge[];
}

export interface DbGraphSampleEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: DbUsageRelation;
}

export interface DbGraphBuildResult {
  readonly dbEntities: readonly OrientationDbEntity[];
  /** Full, uncapped node graph — callers cap jointly with the import graph. */
  readonly adjacency: ReadonlyMap<string, ReadonlySet<string>>;
  readonly reverse: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sampleEdges: readonly DbGraphSampleEdge[];
  readonly edgeCount: number;
}

interface MergedEntity {
  readonly kind: OrientationDbEntityKind;
  readonly qualifiedName: string;
  readonly name: string;
  readonly definedIn: string[];
  rlsEnabled: boolean | undefined;
}

const DB_NODE_ID_RE = /^db:(table|function):(.+)$/;

function parseDbNodeId(
  nodeId: string,
): { readonly kind: OrientationDbEntityKind; readonly qualifiedName: string } | null {
  const match = DB_NODE_ID_RE.exec(nodeId);
  if (!match) return null;
  return { kind: match[1] as OrientationDbEntityKind, qualifiedName: match[2] };
}

function bareNameOf(qualifiedName: string): string {
  const index = qualifiedName.indexOf('.');
  return index >= 0 ? qualifiedName.slice(index + 1) : qualifiedName;
}

/**
 * Merge schema definitions and code-usage edges from every scanned file into
 * one code↔schema graph. Node ids are stable strings (`db:table:...` /
 * `db:function:...` for schema nodes, plain relativePath for source files),
 * so the result composes directly with the import graph's adjacency/reverse
 * maps before the shared persisted-adjacency cap runs (see
 * capPersistedAdjacency in orientation-import-graph.ts).
 */
export function buildDbGraphFromFiles(
  files: readonly DbGraphInputFile[],
  limits: Pick<OrientationLimits, 'maxDbEntities'>,
): DbGraphBuildResult {
  const orderedPaths = sortSchemaPathsByTimestamp(files.map((file) => file.relativePath));
  const byPath = new Map(files.map((file) => [file.relativePath, file] as const));

  const merged = new Map<string, MergedEntity>();
  for (const relativePath of orderedPaths) {
    const file = byPath.get(relativePath);
    if (!file) continue;
    for (const fact of file.schemaFacts) {
      const key = `${fact.kind}:${fact.qualifiedName}`;
      const existing = merged.get(key);
      if (existing) {
        if (!existing.definedIn.includes(fact.definedIn)) existing.definedIn.push(fact.definedIn);
        // Files are visited oldest-first, so the last explicit toggle wins.
        if (fact.rlsEnabled !== undefined) existing.rlsEnabled = fact.rlsEnabled;
      } else {
        merged.set(key, {
          kind: fact.kind,
          qualifiedName: fact.qualifiedName,
          name: fact.name,
          definedIn: [fact.definedIn],
          rlsEnabled: fact.rlsEnabled,
        });
      }
    }
  }

  const byBareName = new Map<string, MergedEntity[]>();
  const byPrismaModel = new Map<string, MergedEntity>();
  const drizzleBindings = new Map<string, { readonly file: string; readonly entity: MergedEntity }[]>();
  for (const entity of merged.values()) {
    const bareKey = `${entity.kind}:${entity.name}`;
    const list = byBareName.get(bareKey) ?? [];
    list.push(entity);
    byBareName.set(bareKey, list);
  }
  for (const file of files) {
    for (const fact of file.schemaFacts) {
      const entity = merged.get(`${fact.kind}:${fact.qualifiedName}`);
      if (!entity) continue;
      // Prisma client accessors are the model name in lowerCamel case.
      if (fact.modelName) byPrismaModel.set(fact.modelName.toLowerCase(), entity);
      if (fact.drizzleBinding) {
        const list = drizzleBindings.get(fact.drizzleBinding) ?? [];
        list.push({ file: file.relativePath, entity });
        drizzleBindings.set(fact.drizzleBinding, list);
      }
    }
  }

  // Identifiers are already normalized by the extractors (PostgreSQL folding
  // for unquoted SQL, verbatim for quoted/ORM names), so matching is exact;
  // only the schema may differ (unqualified reference vs `auth.x` definition).
  function resolveNodeId(usage: DbUsageEdge): string | null {
    if (usage.drizzleBinding) {
      const candidates = drizzleBindings.get(usage.drizzleBinding) ?? [];
      const local = candidates.find((candidate) => candidate.file === usage.from);
      // A binding defined in exactly one schema file is taken as the imported
      // one; ambiguous or unknown bindings (e.g. Array.from(items)) are dropped.
      const target = local ?? (candidates.length === 1 ? candidates[0] : null);
      return target ? dbNodeId(target.entity.kind, target.entity.qualifiedName) : null;
    }
    if (usage.prismaModel) {
      const model = byPrismaModel.get(usage.prismaModel.toLowerCase());
      if (model) return dbNodeId(model.kind, model.qualifiedName);
    }
    const kind = usage.toKind;
    const exact = merged.get(`${kind}:${usage.toQualifiedName}`);
    if (exact) return dbNodeId(exact.kind, exact.qualifiedName);
    const candidates = byBareName.get(`${kind}:${bareNameOf(usage.toQualifiedName)}`);
    if (candidates && candidates.length > 0) {
      return dbNodeId(candidates[0].kind, candidates[0].qualifiedName);
    }
    // Usage-only reference: no schema definition found for this name, but the
    // edge is still worth surfacing (it may indicate schema drift).
    return dbNodeId(kind, usage.toQualifiedName);
  }

  const adjacency = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const sampleEdges: DbGraphSampleEdge[] = [];
  let edgeCount = 0;

  function addEdge(from: string, to: string, relation: DbUsageRelation): void {
    if (!from || from === to) return;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    if (!reverse.has(to)) reverse.set(to, new Set());
    const outSet = adjacency.get(from)!;
    if (outSet.has(to)) return;
    outSet.add(to);
    reverse.get(to)!.add(from);
    edgeCount += 1;
    if (sampleEdges.length < 64) sampleEdges.push(Object.freeze({ from, to, relation }));
  }

  for (const file of files) {
    for (const usageEdge of file.usageEdges) {
      const target = resolveNodeId(usageEdge);
      if (target) addEdge(usageEdge.from, target, usageEdge.relation);
    }
  }

  const allNodeIds = new Set<string>();
  for (const entity of merged.values()) allNodeIds.add(dbNodeId(entity.kind, entity.qualifiedName));
  for (const nodeId of [...adjacency.keys(), ...reverse.keys()]) {
    if (nodeId.startsWith('db:')) allNodeIds.add(nodeId);
  }

  const degreeOf = (nodeId: string) =>
    (adjacency.get(nodeId)?.size ?? 0) + (reverse.get(nodeId)?.size ?? 0);

  const dbEntities: OrientationDbEntity[] = [];
  for (const nodeId of allNodeIds) {
    const parsed = parseDbNodeId(nodeId);
    if (!parsed) continue;
    const known = merged.get(`${parsed.kind}:${parsed.qualifiedName}`);
    dbEntities.push(Object.freeze({
      nodeId,
      kind: parsed.kind,
      name: known?.name ?? bareNameOf(parsed.qualifiedName),
      qualifiedName: parsed.qualifiedName,
      definedIn: Object.freeze(known ? [...known.definedIn] : []),
      rlsEnabled: known?.rlsEnabled,
    }));
  }

  const cappedEntities = dbEntities
    .sort(
      (a, b) =>
        degreeOf(b.nodeId) - degreeOf(a.nodeId) || a.qualifiedName.localeCompare(b.qualifiedName),
    )
    .slice(0, limits.maxDbEntities);

  return Object.freeze({
    dbEntities: Object.freeze(cappedEntities),
    adjacency,
    reverse,
    sampleEdges: Object.freeze(sampleEdges.slice(0, 24)),
    edgeCount,
  });
}

/**
 * Combine the import graph with the db-usage graph into one persisted
 * OrientationGraphSummary: adjacency/reverse are merged (same node-id space,
 * see module docs above) before the shared node/byte cap runs once over the
 * combined graph, so schema nodes cannot be evicted by import-only fan-in and
 * vice versa. `mode`/`nodeCount`/`edgeCount` keep their historical
 * import-only meaning; db stats live in `dbEntities`/`dbEdgeCount`.
 */
export function mergeDbGraphWithImportGraph(
  importGraph: ImportGraphBuildResult,
  dbGraph: DbGraphBuildResult,
  limits: OrientationLimits,
): OrientationGraphSummary {
  const adjacency = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const addAll = (
    target: Map<string, Set<string>>,
    source: ReadonlyMap<string, readonly string[] | ReadonlySet<string>>,
  ): void => {
    for (const [key, values] of source) {
      const set = target.get(key) ?? new Set<string>();
      for (const value of values) set.add(value);
      target.set(key, set);
    }
  };
  addAll(adjacency, importGraph.adjacency);
  addAll(reverse, importGraph.reverse);
  addAll(adjacency, dbGraph.adjacency);
  addAll(reverse, dbGraph.reverse);

  const capped = capPersistedAdjacency(adjacency, reverse, limits);

  return Object.freeze({
    mode: importGraph.graph.mode,
    nodeCount: importGraph.graph.nodeCount,
    edgeCount: importGraph.graph.edgeCount,
    sampleEdges: Object.freeze([...importGraph.graph.sampleEdges, ...dbGraph.sampleEdges]),
    enricher: importGraph.graph.enricher,
    adjacency: capped.adjacencyRecord,
    reverse: capped.reverseRecord,
    dbEntities: dbGraph.dbEntities,
    dbEdgeCount: dbGraph.edgeCount,
  });
}
