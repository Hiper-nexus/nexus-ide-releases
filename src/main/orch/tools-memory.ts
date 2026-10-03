import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getWorkspaceMemoryStore,
  MAX_MEMORY_CONTENT_BYTES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
} from '../memory/workspace-memory';
import {
  backlinks,
  listOrphans,
  suggestConnections,
} from '../memory/nexus-memory';
import { missionLinkTarget } from '../memory/memory-links';
import type { AgentGateContext } from './gate';
import type { McpToolDef } from './mcp-protocol';
import { getProjectDomainStores } from './project-domain-store-registry';
import { isSessionWebExposed } from './session-web-exposure';

/**
 * F-764: a projeção é gravada fora do caminho da gravação; quem lê o grafo
 * logo depois de um retain espera a própria gravação chegar ao disco.
 */
async function resolveMemoryProjectionRoot(
  ctx: AgentGateContext,
): Promise<string> {
  const store = getWorkspaceMemoryStore(ctx.scope);
  await store.flushProjections();
  return store.projectionRoot;
}

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

/**
 * Proveniência default opaque derivada exclusivamente da autoridade física
 * emitida pelo Main. O hash evita colisões por delimitadores controláveis e
 * impede outro pane/worker da mesma missão de usurpar supersession.
 */
function defaultSource(ctx: AgentGateContext): string {
  const authority = createHash('sha256')
    .update(
      JSON.stringify([
        ctx.scope.installationId,
        ctx.scope.projectId,
        ctx.scope.checkoutId,
        ctx.role,
        ctx.missionId ?? null,
        ctx.providerId ?? null,
        ctx.agentName ?? null,
        ctx.workerIncarnationId ?? null,
        ctx.sessionId ?? null,
        ctx.label,
      ]),
    )
    .digest('hex');
  return `agent-authored:${ctx.missionId ? 'mission' : 'pane'}:${authority}`;
}

/** Missão de consulta ("sem alterar nada"): o pane é tratado como read-only. */
function isConsultMission(ctx: AgentGateContext): boolean {
  if (!ctx.missionId) return false;
  try {
    return (
      getProjectDomainStores(ctx.scope).missions.get(ctx.missionId)?.intentContract?.lane ===
      'consult'
    );
  } catch {
    return false;
  }
}

/**
 * Contexto Main-derived da gravação (F-806/F-808). Nada aqui vem de argumento
 * do agente: a quarentena e o veto ao vault seguem a sessão física.
 */
export function agentRetainContext(ctx: AgentGateContext): {
  readonly readOnlyContext: boolean;
  readonly quarantine: string | null;
  readonly links: string[];
} {
  const readOnlyContext = ctx.readOnly === true || isConsultMission(ctx);
  const quarantine = isSessionWebExposed(ctx.sessionId)
    ? 'web-exposed session'
    : readOnlyContext
      ? 'read-only session'
      : null;
  const mission = ctx.missionId ? missionLinkTarget(ctx.missionId) : null;
  return { readOnlyContext, quarantine, links: mission ? [mission] : [] };
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
    'Persist one durable fact about THIS workspace, shared by every CLI hosted ' +
    'in it.\n' +
    'Retain when you learned something the next session would otherwise have to ' +
    'rediscover: a decision and its reason, a constraint the code does not show, ' +
    'a dead end and why it is dead. One idea per call, written so it still reads ' +
    'correctly a month from now — no pronouns pointing at this conversation.\n' +
    'Do NOT retain: what the repo, git history or a file already records; ' +
    'progress narration ("finished step 2"); anything true only inside this ' +
    'task. Retaining noise costs every future agent context.\n' +
    'Behaviour to count on: identical content is deduplicated (the same id comes ' +
    'back, only its timestamp is renewed), a new "# Title" that repeats the title ' +
    'of an earlier note of yours replaces it instead of piling up, secret-like ' +
    'tokens are masked before anything touches disk, and provenance is fixed by ' +
    'Nexus — you cannot choose it. What you retain is a *candidate*: explicit ' +
    'recall returns it; the automatic prompt context of other panes only shows it ' +
    'to workers of the SAME mission, in a section marked unverified, and never ' +
    'when it was retained from a read-only or web-exposed session (the operator ' +
    'can promote it later). Everything writes the memory bank in userData, never ' +
    'the project tree.\n' +
    'Use supersedes=<id> only to correct a memory this same agent authority ' +
    'retained in the same scope; a denial names up to three ids you may replace. ' +
    'Correcting is better than piling a second memory on top of a stale one. ' +
    'Rate limit: 20 retains per 10 minutes per agent — consolidate.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'The memory, self-contained, max 8 KB. Start with a "# Title" line: ' +
          'it becomes the heading the operator sees in the readable projection.',
      },
      kind: {
        type: 'string',
        enum: [...MEMORY_KINDS],
        description:
          'fact = how the system behaves; decision = a choice plus its reason; ' +
          'preference = how this workspace wants things done; note = the rest.',
      },
      importance: {
        type: 'number',
        description:
          '1 (trivia) to 5 (critical). Default 3. Raises ranking in recall — ' +
          'inflating it buries everything else, so reserve 5 for what would ' +
          'cause real rework if forgotten.',
      },
      scope: {
        type: 'string',
        enum: [...MEMORY_SCOPES],
        description:
          "workspace (default) = true for this project only; global = true for " +
          'this user everywhere. Anything naming a path, service or module of ' +
          'this repo is workspace.',
      },
      supersedes: {
        type: 'string',
        description:
          'Id returned by an earlier retain of this same authority, whose ' +
          'content this call corrects.',
      },
    },
    required: ['content'],
  },
  handler: async (args, ctx) => {
    requireMemoryEnabled();
    const input = retainArgsSchema.parse(args);
    const store = getWorkspaceMemoryStore(ctx.scope);
    const context = agentRetainContext(ctx);
    return store.retainAgentAuthored(
      input,
      { source: defaultSource(ctx) },
      {
        links: context.links,
        quarantine: context.quarantine,
        // F-806: contexto read-only/consulta nunca dispara escrita na pasta do
        // projeto (o vault opt-in); a projeção em userData segue normal.
        vault: !context.readOnlyContext,
      },
    );
  },
};

const recallTool: McpToolDef = {
  name: 'nexus_memory_recall',
  description:
    'Look up what this workspace already knows, before investigating from ' +
    'scratch.\n' +
    'Call it early — when you start on an unfamiliar area, before proposing an ' +
    'architectural change, and whenever a choice smells like one somebody has ' +
    'already made here. It is cheap; re-deriving a decision that is already ' +
    'recorded is not.\n' +
    'Matching is FTS5 keyword, not semantic: send the domain nouns (file, ' +
    'module, service, error string), not a sentence. Terms are OR-ed and ' +
    'documents matching more of them rank higher, so two or three sharp words ' +
    'beat a paraphrase of the question. Nothing back means nothing was ' +
    'retained under those words — try other nouns before concluding it is ' +
    'unknown.\n' +
    'Results are ranked by relevance, importance and recency, and only active ' +
    'memories are returned (a superseded one never resurfaces). Treat a hit as ' +
    'a claim with provenance: `source` says who retained it. An ' +
    'agent-authored memory is another agent\'s note, not verified truth — ' +
    'check it against the code before acting on it.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Keywords, not prose. "pgvector migration timeout" — not "why did ' +
          'the pgvector migration time out?".',
      },
      limit: {
        type: 'number',
        description: '1..32, default 8. Raise only when triaging a topic.',
      },
      kind: {
        type: 'string',
        enum: [...MEMORY_KINDS],
        description: 'Narrow to one kind; omit to search all.',
      },
      includeGlobal: {
        type: 'boolean',
        description:
          'Default true: fills leftover slots from the user-global bank after ' +
          'this workspace. Set false to see only what this project recorded.',
      },
    },
    required: ['query'],
  },
  handler: async (args, ctx) => {
    requireMemoryEnabled();
    const input = recallArgsSchema.parse(args);
    const store = getWorkspaceMemoryStore(ctx.scope);
    const hits = store.recall(input);
    // Tudo que esta chamada devolve é injetado no contexto do agente — é
    // exatamente o que o contador honesto deve registrar (F-769).
    store.markRecalled(hits.map((hit) => hit.id));
    return hits;
  },
};

const statsTool: McpToolDef = {
  name: 'nexus_memory_stats',
  description:
    'Cheap shape-of-the-bank check: totals, active counts, counts per kind and ' +
    'recall totals for this workspace and the user-global bank, plus counts of ' +
    'the readable markdown projection kept in Nexus userData (a copy inside the ' +
    'project folder exists only when the operator enabled it in Settings).\n' +
    'Counts only — it never reads memory contents, never returns filesystem ' +
    'paths, and never walks the projection directory when nothing has changed ' +
    'since the last read. Use it to decide whether recall is even worth a call ' +
    '(an empty bank has nothing to tell you) or to confirm a retain landed. ' +
    'To read memories, use nexus_memory_recall.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    requireMemoryEnabled();
    return getWorkspaceMemoryStore(ctx.scope).stats();
  },
};

const backlinksArgsSchema = z
  .object({
    title: z.string().trim().min(1).max(256),
  })
  .strict();

const backlinksTool: McpToolDef = {
  name: 'nexus_memory_backlinks',
  description:
    'Find all memory notes in this workspace that reference [[title]]. ' +
    'Useful to explore knowledge graph relationships and discover dependent decisions.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Target memory title to find inbound wikilinks for.',
      },
    },
    required: ['title'],
  },
  handler: async (args, ctx) => {
    requireMemoryEnabled();
    const input = backlinksArgsSchema.parse(args);
    const root = await resolveMemoryProjectionRoot(ctx);
    const notes = backlinks(root, input.title);
    return {
      target: input.title,
      backlinksCount: notes.length,
      backlinks: notes.map((n) => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        updatedAt: n.updatedAt,
      })),
    };
  },
};

const orphansTool: McpToolDef = {
  name: 'nexus_memory_orphans',
  description:
    'Find disconnected memory notes in this workspace (notes with 0 inbound wikilinks and 0 outbound wikilinks). ' +
    'Helps maintain an interconnected knowledge graph and connect isolated facts.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    requireMemoryEnabled();
    const root = await resolveMemoryProjectionRoot(ctx);
    const notes = listOrphans(root);
    return {
      orphansCount: notes.length,
      orphans: notes.map((n) => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        updatedAt: n.updatedAt,
      })),
    };
  },
};

const suggestConnectionsArgsSchema = z
  .object({
    identifier: z.string().trim().min(1).max(256),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const suggestConnectionsTool: McpToolDef = {
  name: 'nexus_memory_suggest_connections',
  description:
    'Suggest notes in this workspace that share distinctive concepts with a given note, but are not yet linked. ' +
    'Call this to enrich knowledge cross-referencing and synthesize insights across sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'Memory title or id to find suggestions for.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of suggestions (default 5, max 20).',
      },
    },
    required: ['identifier'],
  },
  handler: async (args, ctx) => {
    requireMemoryEnabled();
    const input = suggestConnectionsArgsSchema.parse(args);
    const root = await resolveMemoryProjectionRoot(ctx);
    const suggestions = suggestConnections(
      root,
      input.identifier,
      input.limit ?? 5,
    );
    return {
      target: input.identifier,
      suggestions: suggestions.map((s) => ({
        id: s.note.id,
        title: s.note.title,
        kind: s.note.kind,
        score: s.score,
        sharedTerms: s.sharedTerms,
      })),
    };
  },
};

export function buildMemoryTools(): McpToolDef[] {
  return [
    retainTool,
    recallTool,
    statsTool,
    backlinksTool,
    orphansTool,
    suggestConnectionsTool,
  ];
}
