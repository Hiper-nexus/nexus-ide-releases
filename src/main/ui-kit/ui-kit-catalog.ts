import { listCachedItems, type UiKitCacheOptions } from './ui-kit-cache';
import type { UiKitId } from './ui-kit-cli';
import type { UiKitCandidate } from './ui-kit-pick';
import { withOperatorRegistries } from './ui-kit-registry';
import { chunkShadcnSearchRegistries } from './shadcn-source';
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

  // ONE RUN PER BATCH. The CLI refuses more than `SHADCN_MAX_REGISTRIES`
  // namespaces in a single search, and the settings schema allows twice that,
  // so a 16-registry operator used to lose live shadcn discovery entirely
  // rather than merely wait a little longer.
  const batches = chunkShadcnSearchRegistries(
    // The effective list: a namespace a bundled operator token exists
    // for is searchable even before anyone configures it in settings.
    shadcnSearchNamespaces(withOperatorRegistries(deps.registries?.() ?? [])),
  );
  const found: UiKitCandidate[] = [];
  const raws: string[] = [];
  let bestEffort = false;
  let failure: string | undefined;
  let unmapped: readonly string[] | undefined;
  for (const registries of batches) {
    const result = await runShadcnCommand(
      {
        command: {
          kind: 'search',
          registries,
          ...(query ? { query } : {}),
          limit: 200,
        },
        cwd,
      },
      deps,
    );
    const parsed = parseShadcnSearch(result.stdout);
    found.push(...parsed.candidates);
    raws.push(result.stdout);
    // Any scraped batch makes the whole answer best-effort: one typed batch
    // does not vouch for a batch that was only read as text.
    if (parsed.bestEffort) bestEffort = true;
    // The FIRST failure is the one reported; a later batch succeeding does not
    // make an earlier refusal untrue.
    if (!result.ok && !failure) {
      failure = (result.stderr || result.stdout).slice(0, 300);
    }
    if (result.unmappedRegistries && result.unmappedRegistries.length > 0) {
      unmapped = [...(unmapped ?? []), ...result.unmappedRegistries];
    }
  }
  return {
    candidates: union(found, cachedCandidates(kit, deps.cacheOptions)).filter(
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
}
