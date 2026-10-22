import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UiKitCliError } from './ui-kit-cli';
import {
  assertCacheSlug,
  cachedItemIsStale,
  clearUiKitCache,
  listCachedItems,
  readCachedItem,
  resolveUiKitCacheDir,
  uiKitCacheHash,
  uiKitCacheUsage,
  writeCachedItem,
  UI_KIT_CACHE_MAX_ITEM_BYTES,
} from './ui-kit-cache';

let rootDir = '';

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-cache-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function opts(now?: Date) {
  return now ? { rootDir, now: () => now } : { rootDir };
}

describe('assertCacheSlug', () => {
  it('accepts a plain slug', () => {
    expect(assertCacheSlug('Dashboard-01')).toBe('dashboard-01');
  });

  it('refuses traversal, dots, slashes and backslashes', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '.hidden', 'x.json', '/abs']) {
      expect(() => assertCacheSlug(bad)).toThrow(UiKitCliError);
    }
  });
});

describe('writeCachedItem / readCachedItem', () => {
  it('stores and returns an item', () => {
    const written = writeCachedItem(
      { kit: 'shadcn', slug: 'button', payload: 'export const Button = 1', source: 'shadcn view' },
      opts(),
    );

    expect(written.evicted).toBe(0);
    const read = readCachedItem('shadcn', 'button', opts());
    expect(read?.payload).toBe('export const Button = 1');
    expect(read?.hash).toBe(uiKitCacheHash('export const Button = 1'));
    expect(read?.source).toBe('shadcn view');
  });

  it('keeps the two kits apart', () => {
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'shadcn-button', source: 's' }, opts());
    writeCachedItem({ kit: 'boardui', slug: 'button', payload: 'boardui-button', source: 'b' }, opts());

    expect(readCachedItem('shadcn', 'button', opts())?.payload).toBe('shadcn-button');
    expect(readCachedItem('boardui', 'button', opts())?.payload).toBe('boardui-button');
  });

  it('records the Pro tier so the panel can label it', () => {
    writeCachedItem(
      { kit: 'boardui', slug: 'finance-dashboard', payload: 'x', source: 'boardui get_component', tier: 'pro' },
      opts(),
    );

    expect(readCachedItem('boardui', 'finance-dashboard', opts())?.tier).toBe('pro');
  });

  it('treats a payload edited on disk as absent, not as a component', () => {
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'real', source: 's' }, opts());
    const file = path.join(resolveUiKitCacheDir('shadcn', opts()), 'items', 'button.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.payload = 'injected by someone else';
    fs.writeFileSync(file, JSON.stringify(stored));

    // The stored hash no longer matches, so the entry does not come back.
    expect(readCachedItem('shadcn', 'button', opts())).toBeNull();
  });

  it('treats unparseable JSON as absent', () => {
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'real', source: 's' }, opts());
    const file = path.join(resolveUiKitCacheDir('shadcn', opts()), 'items', 'button.json');
    fs.writeFileSync(file, '{ truncated');

    expect(readCachedItem('shadcn', 'button', opts())).toBeNull();
  });

  it('returns null for an item never cached', () => {
    expect(readCachedItem('shadcn', 'never-seen', opts())).toBeNull();
  });

  it('refuses an oversized payload', () => {
    const huge = 'x'.repeat(UI_KIT_CACHE_MAX_ITEM_BYTES + 1);
    expect(() =>
      writeCachedItem({ kit: 'shadcn', slug: 'huge', payload: huge, source: 's' }, opts()),
    ).toThrow(/per-item cap/);
  });

  it('refuses an empty payload', () => {
    expect(() =>
      writeCachedItem({ kit: 'shadcn', slug: 'empty', payload: '', source: 's' }, opts()),
    ).toThrow(/nothing to cache/);
  });

  it('overwrites the same slug without evicting it', () => {
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'v1', source: 's' }, opts());
    const second = writeCachedItem(
      { kit: 'shadcn', slug: 'button', payload: 'v2', source: 's' },
      opts(),
    );

    expect(second.evicted).toBe(0);
    expect(readCachedItem('shadcn', 'button', opts())?.payload).toBe('v2');
    expect(listCachedItems('shadcn', opts())).toHaveLength(1);
  });
});

describe('listCachedItems and usage', () => {
  it('lists summaries sorted, without the payload', () => {
    writeCachedItem({ kit: 'shadcn', slug: 'sidebar', payload: 'aa', source: 's' }, opts());
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'bbb', source: 's' }, opts());

    const listed = listCachedItems('shadcn', opts());
    expect(listed.map((entry) => entry.slug)).toEqual(['button', 'sidebar']);
    expect(listed[0]).not.toHaveProperty('payload');
    expect(uiKitCacheUsage('shadcn', opts())).toEqual({ items: 2, bytes: 5 });
  });

  it('is empty before anything is cached', () => {
    expect(listCachedItems('boardui', opts())).toEqual([]);
    expect(uiKitCacheUsage('boardui', opts())).toEqual({ items: 0, bytes: 0 });
  });
});

describe('clearUiKitCache', () => {
  it('drops one kit and leaves the other', () => {
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'x', source: 's' }, opts());
    writeCachedItem({ kit: 'boardui', slug: 'button', payload: 'y', source: 'b' }, opts());

    clearUiKitCache('shadcn', opts());

    expect(listCachedItems('shadcn', opts())).toEqual([]);
    expect(listCachedItems('boardui', opts())).toHaveLength(1);
  });
});

describe('cachedItemIsStale', () => {
  const entry = {
    kit: 'shadcn' as const,
    slug: 'button',
    tier: 'free' as const,
    bytes: 1,
    hash: 'h',
    source: 's',
    fetchedAt: '2026-10-20T00:00:00.000Z',
  };

  it('is fresh inside the window and stale outside it', () => {
    expect(cachedItemIsStale(entry, 60_000, new Date('2026-10-20T00:00:30.000Z'))).toBe(false);
    expect(cachedItemIsStale(entry, 60_000, new Date('2026-10-20T00:02:00.000Z'))).toBe(true);
  });

  it('treats an unreadable timestamp as stale', () => {
    expect(cachedItemIsStale({ ...entry, fetchedAt: 'not a date' })).toBe(true);
  });
});

describe('resolveUiKitCacheDir', () => {
  it('refuses to guess a root when none is configured', () => {
    expect(() => resolveUiKitCacheDir('shadcn')).toThrow(/cache root is not configured/);
  });

  it('separates the kits on disk', () => {
    expect(resolveUiKitCacheDir('shadcn', opts())).toBe(
      path.join(rootDir, 'ui-kit', 'shadcn'),
    );
  });
});
