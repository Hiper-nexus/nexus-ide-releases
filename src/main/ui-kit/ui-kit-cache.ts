import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/atomic-write';
import { removeTreeSync } from '../util/remove-tree';
import { UiKitCliError, type UiKitId } from './ui-kit-cli';

/**
 * The downloaded half of the kit: component source kept INSIDE Nexus.
 *
 * Why it exists: `shadcn view` and BoardUI's `get_component` both cost an npx
 * boot plus a network round trip, and an agent that wants to read three
 * components before choosing one pays it three times. Cached, the catalog and
 * the source are available offline, instantly, and the settings panel can show
 * what the kit contains with no network and no key at all.
 *
 * Two rules that are not negotiable:
 *
 * - **Licensed content stays on the machine that licensed it.** A BoardUI Pro
 *   payload is cached under the user's own `userData` at 0600 and is never
 *   written into the repo, the app bundle or anything that ships. Caching is a
 *   local convenience, never redistribution.
 * - **A slug is untrusted.** It arrives from a model or a registry listing, so
 *   it is validated against a strict pattern before it is ever joined into a
 *   path. `..`, a dot, a slash or a backslash is refused rather than cleaned,
 *   because a "cleaned" traversal is the one that gets through.
 */

export const UI_KIT_CACHE_DIR_NAME = 'ui-kit';
export const UI_KIT_CACHE_MAX_ITEM_BYTES = 1_000_000;
export const UI_KIT_CACHE_MAX_ITEMS = 2_000;
export const UI_KIT_CACHE_MAX_TOTAL_BYTES = 64_000_000;
/** A component's source does not change often; a day is plenty. */
export const UI_KIT_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** No dots: a dot opens `..` and hidden files, and no slug needs one. */
export const UI_KIT_CACHE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const UI_KIT_CACHE_MAX_SLUG_CHARS = 96;

export type UiKitCachedTier = 'free' | 'pro' | 'unknown';

export interface UiKitCachedItem {
  readonly kit: UiKitId;
  readonly slug: string;
  readonly tier: UiKitCachedTier;
  /** Raw text as the vendor returned it. Data — never executed by Nexus. */
  readonly payload: string;
  readonly bytes: number;
  readonly hash: string;
  readonly fetchedAt: string;
  /** Auditable origin, e.g. `shadcn view` or `boardui get_component`. */
  readonly source: string;
}

export type UiKitCachedSummary = Omit<UiKitCachedItem, 'payload'>;

export interface UiKitCacheOptions {
  /** Injected in tests and by the service; defaults to Electron userData. */
  readonly rootDir?: string;
  readonly now?: () => Date;
}

let userDataResolver: (() => string) | null = null;

/** Set once at boot so this module never imports electron. */
export function setUiKitCacheRootResolver(resolver: () => string): void {
  userDataResolver = resolver;
}

export function resolveUiKitCacheDir(
  kit: UiKitId,
  options: UiKitCacheOptions = {},
): string {
  const root = options.rootDir ?? userDataResolver?.();
  if (!root) {
    throw new UiKitCliError(
      'NO_CACHE_ROOT',
      'the UI-kit cache root is not configured',
    );
  }
  return path.join(root, UI_KIT_CACHE_DIR_NAME, kit);
}

export function assertCacheSlug(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (
    value.length === 0 ||
    value.length > UI_KIT_CACHE_MAX_SLUG_CHARS ||
    !UI_KIT_CACHE_SLUG_PATTERN.test(value)
  ) {
    throw new UiKitCliError(
      'INVALID_CACHE_SLUG',
      `a cached item slug must match ${String(UI_KIT_CACHE_SLUG_PATTERN)} ` +
        `and stay under ${UI_KIT_CACHE_MAX_SLUG_CHARS} characters`,
    );
  }
  return value;
}

function itemFile(kit: UiKitId, slug: string, options: UiKitCacheOptions): string {
  const dir = path.join(resolveUiKitCacheDir(kit, options), 'items');
  const file = path.join(dir, `${assertCacheSlug(slug)}.json`);
  // Belt and braces: even with the pattern above, prove the join stayed inside.
  if (path.dirname(file) !== dir) {
    throw new UiKitCliError('INVALID_CACHE_SLUG', 'cached slug escaped the cache directory');
  }
  return file;
}

export function uiKitCacheHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function readItemFile(file: string): UiKitCachedItem | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written or hand-edited entry is treated as absent, never as data.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const entry = parsed as Partial<UiKitCachedItem>;
  if (
    typeof entry.slug !== 'string' ||
    typeof entry.payload !== 'string' ||
    typeof entry.fetchedAt !== 'string' ||
    typeof entry.kit !== 'string'
  ) {
    return null;
  }
  // The stored hash is checked, not trusted: a payload edited on disk must not
  // come back as a vendor component.
  if (entry.hash !== uiKitCacheHash(entry.payload)) return null;
  return {
    kit: entry.kit as UiKitId,
    slug: entry.slug,
    tier: (entry.tier ?? 'unknown') as UiKitCachedTier,
    payload: entry.payload,
    bytes: entry.payload.length,
    hash: entry.hash,
    fetchedAt: entry.fetchedAt,
    source: typeof entry.source === 'string' ? entry.source : 'unknown',
  };
}

export function readCachedItem(
  kit: UiKitId,
  slug: string,
  options: UiKitCacheOptions = {},
): UiKitCachedItem | null {
  return readItemFile(itemFile(kit, slug, options));
}

export function listCachedItems(
  kit: UiKitId,
  options: UiKitCacheOptions = {},
): readonly UiKitCachedSummary[] {
  const dir = path.join(resolveUiKitCacheDir(kit, options), 'items');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: UiKitCachedSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const entry = readItemFile(path.join(dir, name));
    if (!entry) continue;
    const { payload: _payload, ...summary } = entry;
    out.push(summary);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface UiKitCacheUsage {
  readonly items: number;
  readonly bytes: number;
}

export function uiKitCacheUsage(
  kit: UiKitId,
  options: UiKitCacheOptions = {},
): UiKitCacheUsage {
  const summaries = listCachedItems(kit, options);
  return {
    items: summaries.length,
    bytes: summaries.reduce((total, entry) => total + entry.bytes, 0),
  };
}

export interface WriteCachedItemRequest {
  readonly kit: UiKitId;
  readonly slug: string;
  readonly payload: string;
  readonly source: string;
  readonly tier?: UiKitCachedTier;
}

export interface WriteCachedItemResult {
  readonly item: UiKitCachedSummary;
  /** Oldest entries dropped to make room. Reported, never silent. */
  readonly evicted: number;
}

/**
 * Store one item. When the cache is at its cap the oldest entries are evicted
 * to make room and the count comes back in the result, so a quiet shrink never
 * looks like a successful write of everything.
 */
export function writeCachedItem(
  request: WriteCachedItemRequest,
  options: UiKitCacheOptions = {},
): WriteCachedItemResult {
  const slug = assertCacheSlug(request.slug);
  if (request.payload.length === 0) {
    throw new UiKitCliError('EMPTY_PAYLOAD', `nothing to cache for ${slug}`);
  }
  if (request.payload.length > UI_KIT_CACHE_MAX_ITEM_BYTES) {
    throw new UiKitCliError(
      'ITEM_TOO_LARGE',
      `${slug} is ${request.payload.length} bytes, over the ` +
        `${UI_KIT_CACHE_MAX_ITEM_BYTES}-byte per-item cap`,
    );
  }

  const existing = listCachedItems(request.kit, options);
  const others = existing.filter((entry) => entry.slug !== slug);
  let evicted = 0;
  let bytes = others.reduce((total, entry) => total + entry.bytes, 0);
  const oldestFirst = [...others].sort((a, b) =>
    a.fetchedAt.localeCompare(b.fetchedAt),
  );
  while (
    oldestFirst.length > 0 &&
    (others.length - evicted + 1 > UI_KIT_CACHE_MAX_ITEMS ||
      bytes + request.payload.length > UI_KIT_CACHE_MAX_TOTAL_BYTES)
  ) {
    const victim = oldestFirst.shift();
    if (!victim) break;
    try {
      fs.rmSync(itemFile(request.kit, victim.slug, options));
    } catch {
      // Already gone; the accounting below still holds.
    }
    bytes -= victim.bytes;
    evicted += 1;
  }

  const now = (options.now ?? (() => new Date()))();
  const item: UiKitCachedItem = {
    kit: request.kit,
    slug,
    tier: request.tier ?? 'unknown',
    payload: request.payload,
    bytes: request.payload.length,
    hash: uiKitCacheHash(request.payload),
    fetchedAt: now.toISOString(),
    source: request.source,
  };
  // 0600: a Pro payload is licensed content, not world-readable material.
  writeJsonAtomic(itemFile(request.kit, slug, options), item, 0o600);
  const { payload: _payload, ...summary } = item;
  return { item: summary, evicted };
}

export function cachedItemIsStale(
  entry: UiKitCachedSummary,
  ttlMs: number = UI_KIT_CACHE_DEFAULT_TTL_MS,
  now: Date = new Date(),
): boolean {
  const fetched = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetched)) return true;
  return now.getTime() - fetched > ttlMs;
}

/** Drop everything cached for one kit. The panel's "clear" button. */
export function clearUiKitCache(
  kit: UiKitId,
  options: UiKitCacheOptions = {},
): void {
  // removeTreeSync, not fs.rmSync: the recursive rm in this Node traverses a
  // junction on Windows and would delete through a link instead of removing it.
  removeTreeSync(resolveUiKitCacheDir(kit, options));
}
