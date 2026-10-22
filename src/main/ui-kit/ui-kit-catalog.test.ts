import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiKitCliRunRequest } from './ui-kit-cli';
import { writeCachedItem } from './ui-kit-cache';
import {
  liveCandidates,
  offlineCandidates,
  resetLiveCandidatesCacheForTests,
} from './ui-kit-catalog';
import type { UiKitRegistry } from './ui-kit-registry';
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
  resetLiveCandidatesCacheForTests();
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

describe('a configured registry the project does not declare', () => {
  const PRIVATE: UiKitRegistry = {
    namespace: '@acme',
    url: 'https://registry.acme.test/r/{name}.json',
    auth: { kind: 'header', name: 'Authorization', envVar: 'ACME_REGISTRY_TOKEN' },
    secretKey: 'external:ui-kit-registry-acme',
  };

  it('is named in the result instead of coming back as an empty list', async () => {
    // The operator adds it in Settings, the project's components.json does
    // not declare it, so the search cannot reach it and its token is
    // withheld. Showing nothing with no reason was the whole complaint. The
    // registry bundled with Nexus rides the same search and is just as
    // undeclared here, so it is named too: an honest list, not a silent one.
    const h = harness(() => ({ stdout: JSON.stringify({ items: [] }) }));

    const result = await liveCandidates('shadcn', cwd, undefined, {
      ...h.deps,
      registries: () => [PRIVATE],
    });

    expect(result.unmappedRegistries).toEqual(['@acme', '@shadcnuikit']);
  });

  it('does not call a registry unreachable when its search answered', async () => {
    // @shadcnuikit resolves through the shadcn public directory with no
    // declaration at all (measured: 1 228 items) — the panel said "a busca
    // não alcança esse registry" right above them.
    const h = harness((request) => {
      const namespace = request.args.slice(1).find((arg) => arg.startsWith('@'));
      return {
        stdout: JSON.stringify({
          items: namespace === '@shadcnuikit' ? [{ name: 'pricing1', registry: '@shadcnuikit' }] : [],
        }),
      };
    });

    const result = await liveCandidates('shadcn', cwd, undefined, {
      ...h.deps,
      registries: () => [PRIVATE],
    });

    expect(result.unmappedRegistries).toEqual(['@acme']);
    // And its pricing is the vendor's, not "free".
    expect(result.candidates.find((entry) => entry.slug === '@shadcnuikit/pricing1')?.tier).toBe(
      'unknown',
    );
  });

  it('says nothing about it once the project declares it', async () => {
    fs.writeFileSync(
      path.join(cwd, 'components.json'),
      JSON.stringify({
        registries: {
          '@acme': {
            url: PRIVATE.url,
            headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
          },
          // The bundled registry the search just reached for; declaring it is
          // what stops it being noise in every result.
          '@shadcnuikit': {
            url: 'https://shadcnuikit.com/r/{name}.json',
            headers: { Authorization: 'Bearer ${SHADCNUIKIT_REGISTRY_TOKEN}' },
          },
        },
      }),
    );
    const h = harness(() => ({ stdout: JSON.stringify({ items: [] }) }));

    const result = await liveCandidates('shadcn', cwd, undefined, {
      ...h.deps,
      registries: () => [PRIVATE],
    });

    expect(result.unmappedRegistries).toBeUndefined();
  });
});

describe('a search wider than the CLI accepts', () => {
  function registry(index: number): UiKitRegistry {
    return {
      namespace: `@r${index}`,
      url: `https://r${index}.test/r/{name}.json`,
    };
  }

  it('runs one search per registry and merges, instead of throwing', async () => {
    // 16 configured registries plus `@shadcn` is 17, over the CLI's limit of
    // 16 — this used to throw and take the whole live catalogue with it. Each
    // registry now runs on its own: a shared `--limit` let the first one take
    // every slot.
    const runs: string[][] = [];
    const deps: UiKitServiceDeps = {
      runCli: async (request) => {
        const registries = request.args.slice(1).filter((arg) => arg.startsWith('@'));
        runs.push(registries);
        return {
          stdout: JSON.stringify({
            items: registries.map((namespace) => ({
              name: `item-${namespace.slice(1)}`,
              type: 'registry:ui',
              registry: namespace,
            })),
          }),
          stderr: '',
          code: 0,
        };
      },
      getSecret: () => null,
      setSecret: () => ({ ok: true }),
      cacheOptions: { rootDir: dir },
      registries: () => Array.from({ length: 16 }, (_, index) => registry(index)),
    };

    const result = await liveCandidates('shadcn', cwd, undefined, deps);

    expect(runs.every((registries) => registries.length === 1)).toBe(true);
    expect(runs[0]).toEqual(['@shadcn']);
    expect(result.error).toBeUndefined();
    // Lossless, stated as the invariant rather than a count: every namespace
    // that was searched contributed its item. (The bundled-operator namespace
    // joins the list too, so a hardcoded number would be brittle.)
    expect(result.candidates).toHaveLength(runs.flat().length);
    expect(runs.flat().length).toBeGreaterThan(16);
  });

  it('reports the FIRST batch failure and still returns what answered', async () => {
    let call = 0;
    const deps: UiKitServiceDeps = {
      runCli: async () => {
        call += 1;
        if (call === 1) return { stdout: '', stderr: 'registry refused', code: 1 };
        return {
          stdout: JSON.stringify({
            items: [{ name: 'late', type: 'registry:ui', registry: '@r15' }],
          }),
          stderr: '',
          code: 0,
        };
      },
      getSecret: () => null,
      setSecret: () => ({ ok: true }),
      cacheOptions: { rootDir: dir },
      registries: () => Array.from({ length: 16 }, (_, index) => registry(index)),
    };

    const result = await liveCandidates('shadcn', cwd, undefined, deps);

    // A later batch succeeding does not make the earlier refusal untrue.
    expect(result.error).toContain('registry refused');
    expect(result.candidates.map((entry) => entry.label)).toContain('late');
  });
});

describe('every registry keeps its place in the live catalogue', () => {
  /** Answers like the real CLI: per registry, honouring --query and --limit. */
  function registryFake(catalog: Record<string, readonly string[]>) {
    const runs: { registries: string[]; query?: string; limit?: number }[] = [];
    const deps: UiKitServiceDeps = {
      runCli: async (request) => {
        const registries = request.args.slice(1).filter((arg) => arg.startsWith('@'));
        const queryAt = request.args.indexOf('--query');
        const limitAt = request.args.indexOf('--limit');
        const query = queryAt >= 0 ? request.args[queryAt + 1] : undefined;
        const limit = limitAt >= 0 ? Number(request.args[limitAt + 1]) : 100;
        runs.push({ registries, ...(query ? { query } : {}), limit });
        const items = registries
          .flatMap((namespace) =>
            (catalog[namespace] ?? [])
              .filter((name) => !query || name.includes(query))
              .map((name) => ({ name, type: 'registry:block', registry: namespace })),
          )
          .slice(0, limit);
        return { stdout: JSON.stringify({ items }), stderr: '', code: 0 };
      },
      getSecret: () => null,
      setSecret: () => ({ ok: true }),
      cacheOptions: { rootDir: dir },
    };
    return { deps, runs };
  }

  const SHADCN = Array.from({ length: 300 }, (_, i) => `block-${i}`);
  const KIT = [...Array.from({ length: 400 }, (_, i) => `misc${i}`), 'pricing1', 'pricing2'];

  it('reaches a big operator registry that a shared limit hid behind @shadcn', async () => {
    const { deps } = registryFake({ '@shadcn': SHADCN, '@shadcnuikit': KIT });

    const result = await liveCandidates('shadcn', cwd, undefined, deps, {
      taskQueries: ['pricing'],
    });

    const slugs = result.candidates.map((entry) => entry.slug);
    expect(slugs).toContain('@shadcnuikit/pricing1');
    expect(slugs.some((slug) => !slug.startsWith('@'))).toBe(true);
  });

  it('answers from the cache for five minutes, then asks again', async () => {
    const { deps, runs } = registryFake({ '@shadcn': ['button'] });

    await liveCandidates('shadcn', cwd, undefined, deps, { now: 1_000 });
    const first = runs.length;
    await liveCandidates('shadcn', cwd, undefined, deps, { now: 1_000 + 60_000 });
    expect(runs).toHaveLength(first);
    await liveCandidates('shadcn', cwd, undefined, deps, { now: 1_000 + 6 * 60_000 });
    expect(runs.length).toBeGreaterThan(first);
  });
});
