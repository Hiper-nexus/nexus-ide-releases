import { listCachedItems, type UiKitCacheOptions } from './ui-kit-cache';
import type { UiKitId } from './ui-kit-cli';
import type { UiKitCandidate } from './ui-kit-pick';
import { withOperatorRegistries } from './ui-kit-registry';
import {
  boardUiCandidates,
  listBoardUiFreeSlugs,
  parseShadcnSearch,
  runShadcnCommand,
  shadcnSearchNamespaces,
  type UiKitServiceDeps,
} from './ui-kit-service';

/**
 * ONE place that answers "what items exist".
 *
 * There were three: the agent tool, the settings IPC and the recipe each built
 * their own list, and they drifted exactly as duplicated logic does — the
 * agent catalogue learned to union the cache while the settings one did not,
 * and the recipe kept resolving against a snapshot that no longer holds a
 * single Pro entry, so a licensed operator could never get a Pro template out
 * of it. Fixing each in turn is what produced the drift; this removes the
 * ability to drift.
 *
 * Two shapes, and the difference is whether a vendor process may run:
 * `offlineCandidates` never spawns (it is what the read-only lane uses), and
 * `liveCandidates` asks the vendor and folds the answer in.
 */

function matchesQuery(entry: UiKitCandidate, needle: string | undefined): boolean {
  if (!needle) return true;
  return (
    entry.slug.toLowerCase().includes(needle) ||
    entry.label.toLowerCase().includes(needle) ||
    entry.category.toLowerCase().includes(needle)
  );
}

/**
 * What the local cache holds, or nothing when it cannot be read.
 *
 * Two things here. The root comes from the SAME options the writer used —
 * listing the default root while `downloadItemsIntoCache` wrote an injected
 * one is how a listing silently loses the items it just fetched. And an
 * unreadable cache does not take the listing down with it: the BoardUI
 * snapshot needs no cache at all, so `NO_CACHE_ROOT` used to turn a tool that
 * could have answered from bundled data into a thrown error.
 */
function cachedCandidates(
  kit: UiKitId,
  options: UiKitCacheOptions | undefined,
): readonly UiKitCandidate[] {
  let cached: ReturnType<typeof listCachedItems>;
  try {
    cached = listCachedItems(kit, options ?? {});
  } catch {
    return [];
  }
  return cached.map((entry) => ({
    kit,
    slug: entry.slug,
    label: entry.slug,
    category: kit === 'boardui' ? 'cached' : 'registry-item',
    tier: entry.tier,
  }));
}

/** Snapshot ∪ cache, de-duplicated by slug, snapshot first. */
function union(
  base: readonly UiKitCandidate[],
  extra: readonly UiKitCandidate[],
): readonly UiKitCandidate[] {
  const known = new Set(base.map((entry) => entry.slug));
  return [...base, ...extra.filter((entry) => !known.has(entry.slug))];
}

/**
 * What exists without running anything: the bundled BoardUI snapshot plus
 * whatever was downloaded. An item a licensed operator already fetched lives
 * only in the cache, so leaving it out made it undiscoverable.
 */
export function offlineCandidates(
  kit: UiKitId,
  query?: string,
  cacheOptions?: UiKitCacheOptions,
): readonly UiKitCandidate[] {
  const needle = query?.trim().toLowerCase();
  const base = kit === 'boardui' ? boardUiCandidates() : [];
  return union(base, cachedCandidates(kit, cacheOptions)).filter((entry) =>
    matchesQuery(entry, needle),
  );
}

export interface LiveCatalogResult {
  readonly candidates: readonly UiKitCandidate[];
  readonly raw: string;
  /** True when the list came from scraping CLI text rather than a typed source. */
  readonly bestEffort: boolean;
  /** Configured registries the project does not declare, so unreachable here. */
  readonly unmappedRegistries?: readonly string[];
  readonly error?: string;
}

/**
 * What the vendor says exists, folded together with what we already know.
 *
 * For BoardUI this is what lets a licensed operator reach a Pro item at all:
 * the bundled snapshot deliberately holds no Pro entry, so a recipe resolving
 * against the snapshot alone could only ever pick free fallbacks.
 */
export interface LiveCatalogOptions {
  /** Catalogue words to search each registry FOR (see `searchTermsForTask`). */
  readonly taskQueries?: readonly string[];
  readonly now?: number;
}

export async function liveCandidates(
  kit: UiKitId,
  cwd: string,
  query: string | undefined,
  deps: UiKitServiceDeps = {},
  options: LiveCatalogOptions = {},
): Promise<LiveCatalogResult> {
  const needle = query?.trim().toLowerCase();

  if (kit === 'boardui') {
    const live = await listBoardUiFreeSlugs(cwd, deps);
    const known = boardUiCandidates();
    const knownSlugs = new Set(known.map((entry) => entry.slug));
    // With a licence the vendor's listing is wider than the bundled snapshot;
    // anything new is tier-unknown here and the install gate resolves it.
    const extra: readonly UiKitCandidate[] = live
      ? [...live]
          .filter((slug) => !knownSlugs.has(slug))
          .map((slug) => ({
            kit,
            slug,
            label: slug,
            category: 'vendor',
            tier: 'unknown' as const,
          }))
      : [];
    const candidates = union(
      union(known, extra),
      cachedCandidates(kit, deps.cacheOptions),
    ).filter((entry) => matchesQuery(entry, needle));
    return {
      candidates,
      raw: '',
      bestEffort: false,
      ...(live ? {} : { error: 'could not reach the BoardUI catalogue' }),
    };
  }

  // The effective list: a namespace a bundled operator token exists for is
  // searchable even before anyone configures it in settings.
  const namespaces = shadcnSearchNamespaces(withOperatorRegistries(deps.registries?.() ?? []));
  const taskQueries = options.taskQueries ?? [];
  const cacheKey = [cwd, namespaces.join(','), query ?? '', taskQueries.join('|')].join('\0');
  const now = options.now ?? Date.now();
  const hit = liveCache.get(cacheKey);
  if (hit && now - hit.at < LIVE_CACHE_TTL_MS) return hit.result;

  // ONE RUN PER REGISTRY, never one shared `--limit`. The CLI answers a
  // multi-registry search in registry order and cuts at the limit, so the 471
  // @shadcn items took all 200 slots and @shadcnuikit's 1 228 — 20 `pricing*`,
  // 26 `hero*` — were invisible to every task pick (measured 22/10/2026).
  // With a task, the first few registries are also searched FOR it: their own
  // first 200 are their order, not the task's.
  const plan: { readonly namespace: string; readonly query?: string; readonly limit: number }[] = [];
  namespaces.forEach((namespace, index) => {
    if (index < LIVE_TASK_QUERY_REGISTRIES) {
      for (const term of taskQueries) {
        plan.push({ namespace, query: term, limit: LIVE_SEARCH_QUERY_LIMIT });
      }
    }
    plan.push({ namespace, ...(query ? { query } : {}), limit: LIVE_SEARCH_BREADTH_LIMIT });
  });
  const results = await mapWithConcurrency(plan, LIVE_SEARCH_CONCURRENCY, (run) =>
    runShadcnCommand(
      {
        command: {
          kind: 'search',
          registries: [run.namespace],
          ...(run.query ? { query: run.query } : {}),
          limit: run.limit,
        },
        cwd,
      },
      deps,
    ),
  );

  const found: UiKitCandidate[] = [];
  const raws: string[] = [];
  let bestEffort = false;
  let failure: string | undefined;
  let unmapped: readonly string[] | undefined;
  results.forEach((result) => {
    const parsed = parseShadcnSearch(result.stdout);
    found.push(...parsed.candidates);
    raws.push(result.stdout);
    // Any scraped run makes the whole answer best-effort: one typed run does
    // not vouch for a run that was only read as text.
    if (parsed.bestEffort) bestEffort = true;
    // The FIRST failure is the one reported; a later run succeeding does not
    // make an earlier refusal untrue.
    if (!result.ok && !failure) {
      failure = (result.stderr || result.stdout).slice(0, 300);
    }
    if (result.unmappedRegistries && result.unmappedRegistries.length > 0) {
      unmapped = [...new Set([...(unmapped ?? []), ...result.unmappedRegistries])];
    }
  });
  const answer: LiveCatalogResult = {
    candidates: union(dedupe(found), cachedCandidates(kit, deps.cacheOptions)).filter(
      (entry) => matchesQuery(entry, needle),
    ),
    raw: raws.join('\n').slice(0, 20_000),
    bestEffort,
    // A registry the operator configured in Nexus but the PROJECT does not
    // declare: the search cannot reach it and no token was released, so say
    // which one rather than showing an empty list.
    ...(unmapped && unmapped.length > 0 ? { unmappedRegistries: unmapped } : {}),
    ...(failure ? { error: failure } : {}),
  };
  // A failure is not worth remembering: the next call should try again.
  if (!failure) liveCache.set(cacheKey, { at: now, result: answer });
  return answer;
}

/** Five minutes: `add({task})` used to pay a fresh vendor search every call. */
const LIVE_CACHE_TTL_MS = 5 * 60_000;
const LIVE_SEARCH_CONCURRENCY = 6;
const LIVE_SEARCH_BREADTH_LIMIT = 200;
const LIVE_SEARCH_QUERY_LIMIT = 50;
/** Registries searched FOR the task too; the rest only get their breadth run. */
const LIVE_TASK_QUERY_REGISTRIES = 4;

const liveCache = new Map<string, { readonly at: number; readonly result: LiveCatalogResult }>();

export function resetLiveCandidatesCacheForTests(): void {
  liveCache.clear();
}

function dedupe(candidates: readonly UiKitCandidate[]): readonly UiKitCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((entry) => {
    if (seen.has(entry.slug)) return false;
    seen.add(entry.slug);
    return true;
  });
}

/** Results in input order, at most `limit` running at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
