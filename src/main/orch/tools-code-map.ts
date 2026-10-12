import { z } from 'zod';
import type { McpToolDef } from './mcp-protocol';
import { ensureBlastRadius } from '../context/orientation/orientation-blast-radius';
import { tryGetProjectOrientationService } from '../context/orientation/orientation-service';

function requireService() {
  const service = tryGetProjectOrientationService();
  if (!service) {
    throw new Error('project orientation service is not initialized');
  }
  return service;
}

const getTool: McpToolDef = {
  name: 'nexus_code_map_get',
  description:
    'Read the structural Project Orientation Map for this checkout (inventory, hubs, import graph, docs presence, context readiness). The Nexus pilot warms this automatically on workspace open and before freeze — agents rarely need to call this unless debugging. Orientation only — not business authority.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx, invocation) => {
    const service = requireService();
    let map = service.get(ctx.scope);
    if (!map) {
      map = await service.ensure(ctx.scope, {
        reason: 'mcp',
        signal: invocation?.signal,
      });
    }
    return service.toSnapshot(map);
  },
};

const blastTool: McpToolDef = {
  name: 'nexus_code_map_blast_radius',
  description:
    'Structural blast radius for a goal or seed files/symbols (import neighborhood + hubs). Auto-used by freeze and worktree ownership expansion. Advisory only.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      seedFiles: { type: 'array', items: { type: 'string' } },
      seedSymbols: { type: 'array', items: { type: 'string' } },
      depth: { type: 'number' },
    },
  },
  handler: async (args, ctx) => {
    const input = z
      .object({
        goal: z.string().trim().max(16_384).optional(),
        seedFiles: z.array(z.string().trim().min(1).max(4_096)).max(256).default([]),
        seedSymbols: z.array(z.string().trim().min(1).max(512)).max(256).default([]),
        depth: z.number().int().min(0).max(4).default(2),
      })
      .strict()
      .parse(args);
    return ensureBlastRadius(ctx.scope, input);
  },
};

const refreshTool: McpToolDef = {
  name: 'nexus_code_map_refresh',
  description:
    'Force a rebuild of the structural Project Orientation Map for this checkout. Orchestrators may refresh after large refactors; workers should prefer nexus_code_map_get.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx, invocation) => {
    if (ctx.role === 'worker') {
      throw new Error('only an orchestrator or user may force orientation refresh');
    }
    const service = requireService();
    const map = await service.refresh(ctx.scope, invocation?.signal);
    return service.toSnapshot(map);
  },
};

const queryTool: McpToolDef = {
  name: 'nexus_code_map_query',
  description:
    'Search the Project Orientation Map. Uses a local ranked inverted index ' +
    '(TF-style, no embeddings/LLM) when ready; falls back to substring match. ' +
    'Never blocks squad arming — index builds async after map is available.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Search query (tokens or substring)' },
      limit: { type: 'number' },
    },
    required: ['q'],
  },
  handler: async (args, ctx, invocation) => {
    const input = z
      .object({
        q: z.string().trim().min(1).max(256),
        limit: z.number().int().min(1).max(64).default(16),
      })
      .strict()
      .parse(args);
    const service = requireService();
    let map = service.get(ctx.scope);
    if (!map) {
      map = await service.ensure(ctx.scope, {
        reason: 'mcp',
        signal: invocation?.signal,
      });
    }

    // Async local index — fire-and-forget rebuild when map hash changes.
    const { getOrientationLocalIndex } = await import(
      '../context/orientation/orientation-local-index'
    );
    const index = getOrientationLocalIndex(map.mapHash);
    const files = await service.indexedPaths(ctx.scope);
    if (!index.snapshot.ready || index.snapshot.mapHash !== map.mapHash) {
      void index.build(map, { files, signal: invocation?.signal }).catch(() => {
        /* index is optional */
      });
    }
    const ranked = index.search(input.q, input.limit);
    if (ranked.length > 0) {
      return Object.freeze({
        mapHash: map.mapHash,
        status: map.status,
        mode: 'local-index' as const,
        index: index.snapshot,
        hits: ranked,
        // Back-compat fields for older callers.
        hubs: ranked
          .filter((hit) => hit.kind === 'hub')
          .map((hit) => ({
            name: hit.title,
            samplePaths: hit.path ? [hit.path] : [],
            score: hit.score,
          })),
        paths: ranked
          .filter((hit) => hit.kind !== 'hub')
          .map((hit) => hit.path ?? hit.title)
          .slice(0, input.limit),
      });
    }

    // F-1256: "tokens or substring" — cada palavra conta; quem casa mais vem
    // antes. A consulta inteira como uma substring só nunca achava nada com
    // duas palavras, justamente na 1ª chamada, enquanto o índice ainda nasce.
    const tokens = [...new Set(input.q.toLowerCase().split(/\s+/).filter(Boolean))];
    const matches = (text: string): number => {
      const lower = text.toLowerCase();
      return tokens.filter((token) => lower.includes(token)).length;
    };
    const byMatches = <T>(items: readonly T[], score: (item: T) => number): T[] =>
      items
        .map((item, order) => ({ item, order, score: score(item) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, input.limit)
        .map((entry) => entry.item);
    const hubs = byMatches(map.symbols.hubs, (hub) =>
      Math.max(matches(hub.name), ...hub.samplePaths.map(matches)),
    );
    const paths = byMatches([...new Set([
      ...map.inventory.entrypoints,
      ...map.inventory.manifests,
      ...map.docs.rootDocs,
      ...map.inventory.topDirs.map((dir) => dir.path),
      ...files,
    ])], matches);
    return Object.freeze({
      mapHash: map.mapHash,
      status: map.status,
      mode: 'substring' as const,
      fallbackReason:
        index.snapshot.ready && index.snapshot.mapHash === map.mapHash
          ? ('no-index-hits' as const)
          : ('index-building' as const),
      index: index.snapshot,
      hubs,
      paths,
    });
  },
};

export function buildCodeMapTools(): McpToolDef[] {
  return [getTool, refreshTool, queryTool, blastTool];
}
