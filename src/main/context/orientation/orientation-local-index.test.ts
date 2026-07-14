// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  OrientationLocalIndex,
  documentsFromOrientationMap,
  resetOrientationLocalIndexes,
} from './orientation-local-index';

const sampleMap = {
  mapHash: 'hash-abc',
  symbols: {
    hubs: [
      {
        name: 'MissionIntent',
        samplePaths: ['src/shared/mission-intent.ts'],
      },
      {
        name: 'CostTracker',
        samplePaths: ['src/main/orch/cost-tracker.ts'],
      },
    ],
  },
  inventory: {
    entrypoints: ['src/main/main.ts', 'src/renderer/main.tsx'],
    manifests: ['package.json'],
    topDirs: [{ path: 'src/main/orch' }, { path: 'src/shared' }],
  },
  docs: { rootDocs: ['README.md', 'docs/ARCHITECTURE.md'] },
};

describe('orientation local index', () => {
  it('extracts documents from orientation map', () => {
    const docs = documentsFromOrientationMap(sampleMap);
    expect(docs.some((d) => d.kind === 'hub' && d.title === 'MissionIntent')).toBe(
      true,
    );
    expect(docs.some((d) => d.path === 'package.json')).toBe(true);
  });

  it('builds asynchronously and ranks semantic-ish queries', async () => {
    resetOrientationLocalIndexes();
    const index = new OrientationLocalIndex();
    const snap = await index.build(sampleMap, { chunkSize: 2 });
    expect(snap.ready).toBe(true);
    expect(snap.documentCount).toBeGreaterThan(5);

    const hits = index.search('mission intent contract', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title.toLowerCase()).toMatch(/mission|intent|shared/);
  });

  it('cancel leaves search empty (fail-soft)', async () => {
    const index = new OrientationLocalIndex();
    const building = index.build(sampleMap, { chunkSize: 1 });
    index.cancel();
    await building;
    expect(index.search('mission').length).toBe(0);
  });

  it('processes an event-loop cancellation before publishing a large build', async () => {
    const index = new OrientationLocalIndex();
    const controller = new AbortController();
    const largeMap = {
      ...sampleMap,
      mapHash: 'hash-large',
      inventory: {
        ...sampleMap.inventory,
        topDirs: Array.from({ length: 1_000 }, (_, i) => ({
          path: `src/generated-${i}`,
        })),
      },
    };
    setImmediate(() => controller.abort());

    const snapshot = await index.build(largeMap, {
      chunkSize: 1,
      signal: controller.signal,
    });

    expect(snapshot).toMatchObject({ ready: false, cancelled: true });
    expect(index.search('generated')).toEqual([]);
  });

  it('rejects a non-positive chunk size instead of looping forever', async () => {
    const index = new OrientationLocalIndex();
    await expect(index.build(sampleMap, { chunkSize: 0 })).rejects.toThrow(/chunkSize/i);
  });

  it('does not let a superseded build clobber a newer completed index', async () => {
    const index = new OrientationLocalIndex();
    const oldBuild = index.build(sampleMap, { chunkSize: 1 });
    const emptyMap = {
      mapHash: 'hash-new',
      symbols: { hubs: [] },
      inventory: { entrypoints: [], manifests: [], topDirs: [] },
      docs: { rootDocs: [] },
    };
    const latest = await index.build(emptyMap);
    await oldBuild;
    expect(latest).toMatchObject({ mapHash: 'hash-new', ready: true });
    expect(index.snapshot).toMatchObject({
      mapHash: 'hash-new', ready: true, cancelled: false,
    });
  });

  it('normalizes ranked scores against the actual highest score', async () => {
    const index = new OrientationLocalIndex();
    await index.build({
      mapHash: 'hash-ranking',
      symbols: { hubs: [
        { name: 'Mission', samplePaths: ['src/one.ts'] },
        { name: 'MissionIntent', samplePaths: ['src/mission-intent/mission.ts'] },
      ] },
      inventory: { entrypoints: [], manifests: [], topDirs: [] },
      docs: { rootDocs: [] },
    });
    const hits = index.search('mission intent');
    expect(hits[0]?.score).toBe(1);
    expect(hits[1]?.score).toBeLessThan(1);
  });
});
