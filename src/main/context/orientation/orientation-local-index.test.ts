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
});
