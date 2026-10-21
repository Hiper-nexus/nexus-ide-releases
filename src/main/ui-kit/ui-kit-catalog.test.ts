import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiKitCliRunRequest } from './ui-kit-cli';
import { writeCachedItem } from './ui-kit-cache';
import { liveCandidates, offlineCandidates } from './ui-kit-catalog';
import {
  resetBoardUiFreeListCacheForTests,
  type UiKitServiceDeps,
} from './ui-kit-service';

let dir = '';
let cwd = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-cat-'));
  cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetBoardUiFreeListCacheForTests();
});

function harness(
  cli: (request: UiKitCliRunRequest) => { stdout?: string; stderr?: string; code?: number },
): { deps: UiKitServiceDeps; runs: UiKitCliRunRequest[] } {
  const runs: UiKitCliRunRequest[] = [];
  return {
    runs,
    deps: {
      runCli: async (request) => {
        runs.push(request);
        const out = cli(request);
        return { stdout: out.stdout ?? '', stderr: out.stderr ?? '', code: out.code ?? 0 };
      },
      getSecret: () => null,
      setSecret: () => ({ ok: true }),
      cacheOptions: { rootDir: dir },
    },
  };
}

const FREE_LIST = '  button    Primary button.\n  app-shell  The shell.\n';
/** The vendor listing a LICENSED operator sees: free items plus Pro ones. */
const LICENSED_LIST = `${FREE_LIST}  template-home-dashboard  Pro template.\n`;

describe('offlineCandidates', () => {
  it('never spawns — the read-only lane depends on that', async () => {
    const h = harness(() => ({ stdout: 'should not run' }));

    offlineCandidates('boardui', undefined, { rootDir: dir });
    offlineCandidates('shadcn', undefined, { rootDir: dir });

    expect(h.runs).toHaveLength(0);
  });

  it('still lists the bundled snapshot when the cache root is unconfigured', () => {
    // No rootDir and no resolver: the cache throws NO_CACHE_ROOT. BoardUI's
    // catalogue ships with Nexus and needs no cache, so an unreadable cache
    // must not blank the listing.
    expect(offlineCandidates('boardui').length).toBeGreaterThan(0);
    expect(offlineCandidates('shadcn')).toEqual([]);
  });

  it('includes a cached item the bundled snapshot does not list', () => {
    writeCachedItem(
      { kit: 'boardui', slug: 'template-home-dashboard', payload: 'x', source: 'vendor', tier: 'pro' },
      { rootDir: dir },
    );

    const found = offlineCandidates('boardui', undefined, { rootDir: dir }).find(
      (entry) => entry.slug === 'template-home-dashboard',
    );

    expect(found?.tier).toBe('pro');
  });

  it('reads the cache root the writer used, not another one', () => {
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'x', source: 'vendor' }, { rootDir: dir });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-other-'));

    expect(offlineCandidates('shadcn', undefined, { rootDir: dir })).toHaveLength(1);
    // The same call against another root sees nothing — which is the drift the
    // options thread closes: listing the default root while
    // `downloadItemsIntoCache` wrote an injected one lost every fetched item.
    expect(offlineCandidates('shadcn', undefined, { rootDir: elsewhere })).toHaveLength(0);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('filters by slug, label and category', () => {
    const hits = offlineCandidates('boardui', 'button', { rootDir: dir });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((entry) => `${entry.slug}${entry.label}${entry.category}`
      .toLowerCase()
      .includes('button'))).toBe(true);
  });
});

describe('liveCandidates', () => {
  it('surfaces a Pro item the bundled snapshot deliberately omits', async () => {
    // The point of the shared catalogue: a recipe resolving against the
    // snapshot alone could never pick a Pro template, because the snapshot
    // holds none — so a paid licence bought nothing.
    const h = harness(() => ({ stdout: LICENSED_LIST }));

    const result = await liveCandidates('boardui', cwd, undefined, h.deps);

    expect(result.candidates.map((entry) => entry.slug)).toContain(
      'template-home-dashboard',
    );
    expect(result.bestEffort).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('still answers from what is known when the vendor is unreachable', async () => {
    const h = harness(() => ({ code: 1, stderr: 'offline' }));

    const result = await liveCandidates('boardui', cwd, undefined, h.deps);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.error).toMatch(/catalogue/);
  });

  it('marks the shadcn search as a scrape, so empty is not proof of empty', async () => {
    const h = harness(() => ({ stdout: '' }));

    const result = await liveCandidates('shadcn', cwd, 'card', h.deps);

    expect(result.bestEffort).toBe(true);
    expect(h.runs[0]?.args).toContain('search');
  });

  it('reports the vendor error instead of an empty list', async () => {
    const h = harness(() => ({ code: 1, stderr: 'registry refused the token' }));

    const result = await liveCandidates('shadcn', cwd, undefined, h.deps);

    expect(result.error).toContain('registry refused the token');
  });
});
