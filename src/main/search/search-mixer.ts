import {
  rankAndLimitHits,
  searchQuerySchema,
  type SearchHit,
  type SearchPartialResult,
  type SearchQuery,
  type SearchSource,
  type SearchSourceProvider,
} from '../../shared/search-mixer-types';

export interface SearchMixerOptions {
  readonly debounceMs?: number;
  readonly defaultLimit?: number;
  readonly now?: () => number;
}

export type SearchListener = (result: SearchPartialResult) => void;

/**
 * Unified multi-source search with debounce, generation counter, and cancel.
 * Discard stale callbacks via generation. Fail-closed on invalid query.
 */
export class SearchMixer {
  readonly #providers = new Map<SearchSource, SearchSourceProvider>();
  readonly #debounceMs: number;
  readonly #defaultLimit: number;
  readonly #now: () => number;
  #generation = 0;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #activeAbort: AbortController | null = null;

  constructor(options: SearchMixerOptions = {}) {
    this.#debounceMs = options.debounceMs ?? 80;
    this.#defaultLimit = options.defaultLimit ?? 30;
    this.#now = options.now ?? Date.now;
  }

  register(provider: SearchSourceProvider): void {
    this.#providers.set(provider.source, provider);
  }

  unregister(source: SearchSource): void {
    this.#providers.delete(source);
  }

  /** Registered source keys (one provider per source — last register wins). */
  sources(): readonly SearchSource[] {
    return [...this.#providers.keys()];
  }

  get generation(): number {
    return this.#generation;
  }

  /** Cancel any in-flight search and debounce. */
  cancel(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    this.#activeAbort?.abort();
    this.#activeAbort = null;
  }

  /**
   * Debounced search. Listener may be called multiple times with partial=true.
   * Stale generations are never delivered.
   */
  search(raw: SearchQuery, listener: SearchListener): number {
    const query = searchQuerySchema.parse({
      ...raw,
      limit: raw.limit ?? this.#defaultLimit,
    });
    this.cancel();
    const generation = ++this.#generation;

    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#run(query, generation, listener);
    }, this.#debounceMs);

    return generation;
  }

  /** Immediate search (no debounce) — useful for tests and programmatic calls. */
  async searchNow(raw: SearchQuery): Promise<SearchPartialResult> {
    const query = searchQuerySchema.parse({
      ...raw,
      limit: raw.limit ?? this.#defaultLimit,
    });
    this.cancel();
    const generation = ++this.#generation;
    return this.#run(query, generation);
  }

  async #run(
    query: SearchQuery,
    generation: number,
    listener?: SearchListener,
  ): Promise<SearchPartialResult> {
    if (generation !== this.#generation) {
      return emptyResult(generation, query.text, true, 0);
    }

    const started = this.#now();
    const abort = new AbortController();
    this.#activeAbort = abort;

    const sources = resolveSources(query, this.#providers);
    const accumulated: SearchHit[] = [];
    const completed: SearchSource[] = [];

    const emit = (partial: boolean, cancelled: boolean): SearchPartialResult => {
      const result: SearchPartialResult = {
        generation,
        query: query.text,
        hits: rankAndLimitHits(accumulated, query.limit),
        partial,
        completedSources: [...completed],
        cancelled,
        elapsedMs: Math.max(0, this.#now() - started),
      };
      if (generation === this.#generation && listener) {
        listener(result);
      }
      return result;
    };

    for (const source of sources) {
      if (abort.signal.aborted || generation !== this.#generation) {
        return emit(true, true);
      }
      const provider = this.#providers.get(source);
      if (!provider) continue;

      try {
        const hits = await Promise.resolve(
          provider.search({ ...query, generation }, abort.signal),
        );
        if (abort.signal.aborted || generation !== this.#generation) {
          return emit(true, true);
        }
        for (const hit of hits) {
          if (hit.source === source) accumulated.push(hit);
        }
        completed.push(source);
        emit(true, false);
      } catch {
        // Source failure is non-fatal; continue with remaining sources.
        completed.push(source);
      }
    }

    return emit(false, abort.signal.aborted);
  }
}

function resolveSources(
  query: SearchQuery,
  providers: Map<SearchSource, SearchSourceProvider>,
): SearchSource[] {
  if (query.sources && query.sources.length > 0) {
    return query.sources.filter((s) => providers.has(s));
  }
  return [...providers.keys()];
}

function emptyResult(
  generation: number,
  query: string,
  cancelled: boolean,
  elapsedMs: number,
): SearchPartialResult {
  return {
    generation,
    query,
    hits: [],
    partial: false,
    completedSources: [],
    cancelled,
    elapsedMs,
  };
}

/** Simple substring score in [0, 1] for local providers. */
export function substringScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase().trim();
  if (!n) return 0;
  if (h === n) return 1;
  if (h.startsWith(n)) return 0.9;
  const idx = h.indexOf(n);
  if (idx < 0) return 0;
  return Math.max(0.1, 0.75 - idx / Math.max(h.length, 1));
}
