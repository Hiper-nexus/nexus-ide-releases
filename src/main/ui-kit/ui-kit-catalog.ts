import { listCachedItems, type UiKitCacheOptions } from './ui-kit-cache';
import type { UiKitId } from './ui-kit-cli';
import type { UiKitCandidate } from './ui-kit-pick';
import {
  boardUiCandidates,
  listBoardUiFreeSlugs,
  parseShadcnSearchOutput,
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
  readonly error?: string;
}

/**
 * What the vendor says exists, folded together with what we already know.
 *
 * For BoardUI this is what lets a licensed operator reach a Pro item at all:
 * the bundled snapshot deliberately holds no Pro entry, so a recipe resolving
 * against the snapshot alone could only ever pick free fallbacks.
 */
export async function liveCandidates(
  kit: UiKitId,
  cwd: string,
  query: string | undefined,
  deps: UiKitServiceDeps = {},
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

  const result = await runShadcnCommand(
    {
      command: {
        kind: 'search',
        registries: shadcnSearchNamespaces(deps.registries?.() ?? []),
        ...(query ? { query } : {}),
        limit: 200,
      },
      cwd,
    },
    deps,
  );
  const parsed = parseShadcnSearchOutput(result.stdout);
  return {
    candidates: union(parsed, cachedCandidates(kit, deps.cacheOptions)).filter(
      (entry) => matchesQuery(entry, needle),
    ),
    raw: result.stdout.slice(0, 20_000),
    // The CLI has no --json for search, so the parse is a scrape: an empty
    // list never means "the registry has nothing".
    bestEffort: true,
    ...(result.ok ? {} : { error: (result.stderr || result.stdout).slice(0, 300) }),
  };
}
