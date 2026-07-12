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
  handler: async (_args, ctx) => {
    const service = requireService();
    let map = service.get(ctx.scope);
    if (!map) {
      map = await service.ensure(ctx.scope, { reason: 'mcp' });
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
  handler: async (_args, ctx) => {
    if (ctx.role === 'worker') {
      throw new Error('only an orchestrator or user may force orientation refresh');
    }
    const service = requireService();
    const map = await service.refresh(ctx.scope);
    return service.toSnapshot(map);
  },
};

const queryTool: McpToolDef = {
  name: 'nexus_code_map_query',
  description:
    'Deterministic filter over the orientation map: match hubs/paths by substring. No LLM and no vector search.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Case-insensitive substring' },
      limit: { type: 'number' },
    },
    required: ['q'],
  },
  handler: async (args, ctx) => {
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
      map = await service.ensure(ctx.scope, { reason: 'mcp' });
    }
    const needle = input.q.toLowerCase();
    const hubs = map.symbols.hubs
      .filter(
        (hub) =>
          hub.name.toLowerCase().includes(needle) ||
          hub.samplePaths.some((p) => p.toLowerCase().includes(needle)),
      )
      .slice(0, input.limit);
    const paths = [
      ...map.inventory.entrypoints,
      ...map.inventory.manifests,
      ...map.docs.rootDocs,
      ...map.inventory.topDirs.map((dir) => dir.path),
    ]
      .filter((item) => item.toLowerCase().includes(needle))
      .slice(0, input.limit);
    return Object.freeze({
      mapHash: map.mapHash,
      status: map.status,
      hubs,
      paths,
    });
  },
};

export function buildCodeMapTools(): McpToolDef[] {
  return [getTool, refreshTool, queryTool, blastTool];
}
