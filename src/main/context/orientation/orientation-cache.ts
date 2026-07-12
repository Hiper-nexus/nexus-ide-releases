import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type {
  ProjectOrientationMap,
  ProjectOrientationMapJson,
} from './orientation-types';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function orientationCacheDirectory(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): string {
  return path.join(
    cacheRoot,
    `project-${digest(scope.projectId)}`,
    `checkout-${digest(scope.checkoutId)}`,
  );
}

export function orientationCurrentPath(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): string {
  return path.join(orientationCacheDirectory(cacheRoot, scope), 'current.json');
}

export function toOrientationJson(map: ProjectOrientationMap): ProjectOrientationMapJson {
  return Object.freeze({
    schemaVersion: 1,
    projectId: map.projectId,
    checkoutId: map.checkoutId,
    headSha: map.headSha,
    treeFingerprint: map.treeFingerprint,
    builtAt: map.builtAt,
    buildDurationMs: map.buildDurationMs,
    status: map.status,
    error: map.error,
    limits: map.limits,
    inventory: map.inventory,
    symbols: Object.freeze({
      filesScanned: map.symbols.filesScanned,
      symbolCount: map.symbols.symbolCount,
      hubs: map.symbols.hubs,
      coverage: map.symbols.coverage,
    }),
    graph: map.graph,
    docs: map.docs,
    contextSummary: map.contextSummary,
    orientationMarkdown: map.orientationMarkdown,
    mapHash: map.mapHash,
  });
}

export function fromOrientationJson(raw: ProjectOrientationMapJson): ProjectOrientationMap {
  // Cache does not persist the full symbol set (too large). Reconstruct a
  // useful known-symbol set from hubs so readiness/stale checks stay honest.
  const symbols = new Set<string>();
  for (const hub of raw.symbols.hubs) {
    if (hub.name) symbols.add(hub.name);
    for (const sample of hub.samplePaths) {
      const base = sample.split('/').pop()?.replace(/\.[^.]+$/, '');
      if (base) symbols.add(base);
    }
  }
  return Object.freeze({
    ...raw,
    graph: Object.freeze({
      ...raw.graph,
      adjacency: raw.graph.adjacency
        ? Object.freeze({ ...raw.graph.adjacency })
        : undefined,
      reverse: raw.graph.reverse
        ? Object.freeze({ ...raw.graph.reverse })
        : undefined,
      sampleEdges: Object.freeze([...(raw.graph.sampleEdges ?? [])]),
    }),
    symbols: Object.freeze({
      ...raw.symbols,
      hubs: Object.freeze([...(raw.symbols.hubs ?? [])]),
      coverage: Object.freeze([...(raw.symbols.coverage ?? [])]),
      symbols,
    }),
  });
}

export function readOrientationCache(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): ProjectOrientationMap | null {
  const file = orientationCurrentPath(cacheRoot, scope);
  try {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(content) as ProjectOrientationMapJson;
    if (parsed.schemaVersion !== 1) return null;
    if (parsed.projectId !== scope.projectId || parsed.checkoutId !== scope.checkoutId) {
      return null;
    }
    return fromOrientationJson(parsed);
  } catch {
    return null;
  }
}

export function writeOrientationCache(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  map: ProjectOrientationMap,
): void {
  const dir = orientationCacheDirectory(cacheRoot, scope);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = orientationCurrentPath(cacheRoot, scope);
  const tmp = `${target}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(toOrientationJson(map), null, 2)}\n`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, target);
}
