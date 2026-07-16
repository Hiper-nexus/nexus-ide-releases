import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getWorkspaceMemoryStore,
  MAX_MEMORY_CONTENT_BYTES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
} from '../memory/workspace-memory';
import type { AgentGateContext } from './gate';
import type { McpToolDef } from './mcp-protocol';

/**
 * Tools de memória agentic por workspace (entrega C2, design derivado do
 * mnemopi do oh-my-pi). Compartilhada por TODAS as CLIs hospedadas: o escopo
 * vem exclusivamente do ProjectExecutionScope do gate (ctx.scope) — nunca de
 * argumentos do agente. Auditoria e confirmação são centrais no mcp-dispatch.
 */

function requireMemoryEnabled(): void {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    throw new Error('feature.memory.workspaceMemory is disabled');
  }
}

/** Proveniência default: missão quando houver, senão o pane/CLI que gravou. */
function defaultSource(ctx: AgentGateContext): string {
  const source = ctx.missionId
    ? `mission:${ctx.missionId}`
    : `pane:${ctx.providerId ?? ctx.label}`;
  return source.slice(0, 256);
}

const retainArgsSchema = z
  .object({
    content: z.string().min(1).max(MAX_MEMORY_CONTENT_BYTES),
    kind: z.enum(MEMORY_KINDS).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    scope: z.enum(MEMORY_SCOPES).optional(),
    supersedes: z.string().min(1).max(128).optional(),
  })
  .strict();

const recallArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(1_024),
    limit: z.number().int().min(1).max(32).optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    includeGlobal: z.boolean().optional(),
  })
  .strict();

const retainTool: McpToolDef = {
  name: 'nexus_memory_retain',
  description:
    'Persist a durable memory (fact, decision, preference, or note) shared by ' +
    'every CLI hosted in this workspace. Identical content is deduplicated; ' +
    'secret-like tokens are redacted before storage. Use importance 1-5 ' +
    '(default 3) and scope "global" only for user-level facts that apply to ' +
    'every project. Pass supersedes=<id> to replace an outdated memory.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The memory text to retain (max 8 KB).',
      },
      kind: { type: 'string', enum: [...MEMORY_KINDS] },
      importance: { type: 'number', description: '1 (trivia) to 5 (critical).' },
      scope: { type: 'string', enum: [...MEMORY_SCOPES] },
      supersedes: {
        type: 'string',
        description: 'Id of an existing memory this one replaces.',
      },
    },
    required: ['content'],
  },
  handler: async (args, ctx) => {
    requireMemoryEnabled();
    const input = retainArgsSchema.parse(args);
    const store = getWorkspaceMemoryStore(ctx.scope);
    return store.retain({ ...input, source: defaultSource(ctx) });
  },
};

const recallTool: McpToolDef = {
  name: 'nexus_memory_recall',
  description:
    'Search memories retained for this workspace using SQLite FTS5 full-text ' +
    'match with BM25 ranking boosted by importance and recency. Fills the ' +
    'remaining slots from the user-global bank (includeGlobal defaults to ' +
    'true). Returns up to `limit` (default 8) active memories; superseded ' +
    'memories are never returned.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text search terms.' },
      limit: { type: 'number' },
      kind: { type: 'string', enum: [...MEMORY_KINDS] },
      includeGlobal: { type: 'boolean' },
    },
    required: ['query'],
  },
  handler: async (args, ctx) => {
    requireMemoryEnabled();
    const input = recallArgsSchema.parse(args);
    const store = getWorkspaceMemoryStore(ctx.scope);
    return store.recall(input);
  },
};

const statsTool: McpToolDef = {
  name: 'nexus_memory_stats',
  description:
    'Read memory bank statistics for this workspace and the user-global ' +
    'bank: totals, active counts, counts per kind, and recall totals. ' +
    'Read-only; never returns memory contents or filesystem paths.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    requireMemoryEnabled();
    return getWorkspaceMemoryStore(ctx.scope).stats();
  },
};

export function buildMemoryTools(): McpToolDef[] {
  return [retainTool, recallTool, statsTool];
}
