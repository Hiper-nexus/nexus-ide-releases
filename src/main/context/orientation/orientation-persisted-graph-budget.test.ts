import { describe, expect, it } from 'vitest';
import { capPersistedAdjacency } from './orientation-import-graph';
import { DEFAULT_ORIENTATION_LIMITS } from './orientation-types';

/**
 * A repo with 500 lightly-connected files (a realistic shape: every file
 * imports the next one, degree 1-2 each) used to lose everything past the
 * 200th node even though the persisted JSON was nowhere near any byte
 * budget. Blast radius and portao-regressao both read this same persisted
 * adjacency, so files/tests beyond node 200 were silently invisible to them.
 */
function chainGraph(size: number): {
  adjacency: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
} {
  const adjacency = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (let i = 0; i < size - 1; i += 1) {
    const from = `src/file-${String(i).padStart(4, '0')}.ts`;
    const to = `src/file-${String(i + 1).padStart(4, '0')}.ts`;
    adjacency.set(from, new Set([to]));
    reverse.set(to, new Set([from]));
  }
  return { adjacency, reverse };
}

describe('DEFAULT_ORIENTATION_LIMITS: persisted graph budget', () => {
  it('persists more than 200 nodes by default for a graph well within the byte budget', () => {
    const { adjacency, reverse } = chainGraph(500);
    const capped = capPersistedAdjacency(adjacency, reverse, DEFAULT_ORIENTATION_LIMITS);
    expect(capped.nodeCount).toBeGreaterThan(200);
  });

  it('raises the node cap well beyond 200 while keeping an explicit byte budget', () => {
    expect(DEFAULT_ORIENTATION_LIMITS.maxPersistedGraphNodes).toBeGreaterThan(200);
    expect(DEFAULT_ORIENTATION_LIMITS.maxPersistedGraphBytes).toBeGreaterThan(0);
  });

  it('still respects the byte budget even under the new higher node cap', () => {
    const adjacency = new Map<string, Set<string>>();
    const longSuffix = 'x'.repeat(2_000);
    for (let i = 0; i < DEFAULT_ORIENTATION_LIMITS.maxPersistedGraphNodes + 500; i += 1) {
      adjacency.set(`src/very-long-directory-name-${i}-${longSuffix}.ts`, new Set());
    }
    const capped = capPersistedAdjacency(adjacency, new Map(), DEFAULT_ORIENTATION_LIMITS);
    expect(capped.nodeCount).toBeLessThan(DEFAULT_ORIENTATION_LIMITS.maxPersistedGraphNodes);
  });

  it('keeps the serialized adjacency+reverse within the byte budget for a dense graph', () => {
    // 100 long paths, every node imports every other one: the old 24-bytes-
    // per-edge estimate let ~3 MB through a 512 KB budget.
    const nodes = Array.from(
      { length: 100 },
      (_, i) => `src/features/some-deeply/nested-module-${i}/${'segment/'.repeat(8)}file-${i}.ts`,
    );
    const adjacency = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    for (const from of nodes) {
      adjacency.set(from, new Set(nodes.filter((to) => to !== from)));
      reverse.set(from, new Set(nodes.filter((to) => to !== from)));
    }
    const capped = capPersistedAdjacency(adjacency, reverse, DEFAULT_ORIENTATION_LIMITS);
    const serialized = JSON.stringify({
      adjacency: capped.adjacencyRecord,
      reverse: capped.reverseRecord,
    });
    expect(capped.nodeCount).toBeGreaterThan(1);
    expect(serialized.length).toBeLessThanOrEqual(DEFAULT_ORIENTATION_LIMITS.maxPersistedGraphBytes);
  });
});
