import { z } from 'zod';

/**
 * Unified search mixer contracts: multi-source, cancellable, generation-safe.
 */

export const SEARCH_SOURCES = [
  'files',
  'commands',
  'symbols',
  'panes',
  'missions',
  'agents',
  'settings',
  'skills',
  'mcp_tools',
  'workspaces',
  'handoffs',
] as const;

export type SearchSource = (typeof SEARCH_SOURCES)[number];

export const searchSourceSchema = z.enum(SEARCH_SOURCES);

/** Higher number = higher priority when scores tie. */
export const SEARCH_SOURCE_PRIORITY: Readonly<Record<SearchSource, number>> = {
  missions: 100,
  panes: 95,
  agents: 90,
  commands: 85,
  handoffs: 80,
  skills: 75,
  mcp_tools: 70,
  settings: 65,
  workspaces: 60,
  symbols: 55,
  files: 50,
};

export const searchQuerySchema = z
  .object({
    text: z.string().max(512),
    sources: z.array(searchSourceSchema).min(1).max(SEARCH_SOURCES.length).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    workspaceId: z.string().min(1).max(128).optional(),
    projectRoot: z.string().min(1).max(4096).optional(),
    /** Opaque generation assigned by the mixer; callers should not set. */
    generation: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchHitSchema = z
  .object({
    id: z.string().min(1).max(256),
    source: searchSourceSchema,
    title: z.string().max(512),
    subtitle: z.string().max(1024).optional(),
    /** Stable score; higher is better. Sources should use [0, 1]. */
    score: z.number().min(0).max(1),
    /** Already-redacted snippet for UI. */
    snippet: z.string().max(1024).optional(),
    path: z.string().max(4096).optional(),
    meta: z.record(z.string().max(64), z.unknown()).optional(),
  })
  .strict();

export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchPartialResultSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    query: z.string().max(512),
    hits: z.array(searchHitSchema).max(100),
    /** True when more sources may still report. */
    partial: z.boolean(),
    completedSources: z.array(searchSourceSchema).max(SEARCH_SOURCES.length),
    cancelled: z.boolean().default(false),
    elapsedMs: z.number().int().nonnegative(),
    /**
     * Triagem Jev (researchTriage): melhor hit + se a pergunta está respondida
     * — para o agente saber se fecha a pesquisa ou busca outra fonte.
     */
    triage: z
      .object({
        bestHitId: z.string().max(256).nullable(),
        bestConfidence: z.number().min(0).max(1),
        answered: z.boolean(),
        answeredConfidence: z.number().min(0).max(1),
        model: z.string().max(64),
        inputTokens: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .strict();

export type SearchPartialResult = z.infer<typeof searchPartialResultSchema>;

export interface SearchSourceProvider {
  readonly source: SearchSource;
  /**
   * Sync providers return hits immediately. Async providers may ignore and
   * use the async path when implemented by the mixer.
   */
  search(
    query: SearchQuery,
    signal: AbortSignal,
  ): Promise<readonly SearchHit[]> | readonly SearchHit[];
}

/** Stable ranking: score desc, source priority desc, id asc. */
export function compareSearchHits(a: SearchHit, b: SearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  const prio =
    SEARCH_SOURCE_PRIORITY[b.source] - SEARCH_SOURCE_PRIORITY[a.source];
  if (prio !== 0) return prio;
  return a.id.localeCompare(b.id);
}

export function rankAndLimitHits(
  hits: readonly SearchHit[],
  limit: number,
): SearchHit[] {
  return [...hits].sort(compareSearchHits).slice(0, Math.max(0, limit));
}
