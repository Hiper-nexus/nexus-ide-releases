// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiKitCliRunRequest } from './ui-kit-cli';
import {
  listCachedItems,
  readCachedItem,
  setUiKitCacheRootResolver,
} from './ui-kit-cache';
import {
  downloadItemsIntoCache,
  readItemSource,
  type UiKitServiceDeps,
} from './ui-kit-service';

/**
 * The flow test the last three review rounds argued for.
 *
 * Every other suite injects `rootDir` into each cache call, so the cache was
 * never exercised the way production uses it — through the resolver — and three
 * separate defects lived in that blind spot: the resolver was never wired, the
 * cache was never populated, and a namespaced identifier could not be written
 * at all (while the caller was told `cached: true`).
 *
 * So here the ONLY seam is the process boundary: the cache root is set the way
 * the boot sets it, and the CLI runner is stubbed because a test must not spawn.
 */
let root = '';
let cwd = '';
let runs: UiKitCliRunRequest[] = [];

function deps(stdout: string): UiKitServiceDeps {
  return {
    runCli: async (request) => {
      runs.push(request);
      return { stdout, stderr: '', code: 0 };
    },
    registries: () => [],
    // The vault is a different seam and is not what this test is about; the
    // cache is the one deliberately NOT injected.
    getSecret: () => null,
    setSecret: () => ({ ok: true }),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-flow-'));
  cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  runs = [];
  // Exactly what main.ts does at boot.
  setUiKitCacheRootResolver(() => root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fetch then read, with the cache resolved the way production resolves it', () => {
  it('caches a plain item and serves the second read without the CLI', async () => {
    const first = await readItemSource(
      { kit: 'shadcn', slug: 'button', cwd },
      deps('export const Button = 1'),
    );

    expect(first.fromCache).toBe(false);
    expect(first.cached).toBe(true);
    expect(runs).toHaveLength(1);

    const second = await readItemSource({ kit: 'shadcn', slug: 'button', cwd }, deps(''));

    expect(second.fromCache).toBe(true);
    expect(second.source).toBe('export const Button = 1');
    // The second call never reached the CLI.
    expect(runs).toHaveLength(1);
  });

  it('caches a NAMESPACED identifier, which silently failed before', async () => {
    // `@acme/auth` reaches the cache as the full identifier, and `@` and `/`
    // are refused in a filename — so the write threw, the error was swallowed,
    // and the caller was told `cached: true` for something that was not there.
    const result = await readItemSource(
      { kit: 'shadcn', slug: '@acme/auth', cwd },
      deps('export const Auth = 1'),
    );

    expect(result.cached).toBe(true);
    expect(readCachedItem('shadcn', '@acme/auth')?.payload).toBe('export const Auth = 1');
    expect(listCachedItems('shadcn').map((entry) => entry.slug)).toEqual(['@acme/auth']);
  });

  it('keeps a namespaced item and a flattened lookalike apart', async () => {
    // `@a/b` and `a-b` must not collide on one file: one would silently serve
    // the other's source.
    await readItemSource({ kit: 'shadcn', slug: '@a/b', cwd }, deps('namespaced'));
    await readItemSource({ kit: 'shadcn', slug: 'a-b', cwd }, deps('plain'));

    expect(readCachedItem('shadcn', '@a/b')?.payload).toBe('namespaced');
    expect(readCachedItem('shadcn', 'a-b')?.payload).toBe('plain');
  });

  it('reports cached:false when the vendor returned nothing to cache', async () => {
    const result = await readItemSource(
      { kit: 'shadcn', slug: 'empty-one', cwd },
      deps('   '),
    );

    expect(result.cached).toBe(false);
    expect(readCachedItem('shadcn', 'empty-one')).toBeNull();
  });

  it('refetches on refresh and replaces what was stored', async () => {
    await readItemSource({ kit: 'shadcn', slug: 'button', cwd }, deps('v1'));
    const again = await readItemSource(
      { kit: 'shadcn', slug: 'button', cwd, refresh: true },
      deps('v2'),
    );

    expect(again.source).toBe('v2');
    expect(readCachedItem('shadcn', 'button')?.payload).toBe('v2');
    expect(listCachedItems('shadcn')).toHaveLength(1);
  });
});

describe('a download is only "cached" when the cache says so', () => {
  it('reports the slug as failed when the cache refused the write', async () => {
    // `readItemSource` answers `cached: false` without throwing when the write
    // is refused, and the loop used to append the slug anyway — the caller was
    // told the item was available offline while the next read would miss.
    const readOnly = path.join(root, 'read-only-cache');
    // A file where a directory is required fails on Windows and POSIX,
    // including root; chmod alone cannot simulate write refusal on Windows.
    fs.writeFileSync(readOnly, 'not a directory');
    setUiKitCacheRootResolver(() => readOnly);
    try {
      const result = await downloadItemsIntoCache(
        { kit: 'shadcn', slugs: ['button'], cwd },
        deps(JSON.stringify({ name: 'button', type: 'registry:ui' })),
      );

      expect(result.cached).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.slug).toBe('button');
      expect(result.failed[0]?.reason).toMatch(/cache/i);
    } finally {
      setUiKitCacheRootResolver(() => root);
    }
  });

  it('reports it as cached when the write lands', async () => {
    const result = await downloadItemsIntoCache(
      { kit: 'shadcn', slugs: ['button'], cwd },
      deps(JSON.stringify({ name: 'button', type: 'registry:ui' })),
    );

    expect(result.cached).toEqual(['button']);
    expect(result.failed).toEqual([]);
  });
});
