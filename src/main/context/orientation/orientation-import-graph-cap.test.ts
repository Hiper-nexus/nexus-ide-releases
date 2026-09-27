import { describe, expect, it } from 'vitest';
import { capPersistedAdjacency } from './orientation-import-graph';
import { DEFAULT_ORIENTATION_LIMITS } from './orientation-types';

describe('capPersistedAdjacency', () => {
  it('keeps nodes up to maxPersistedGraphNodes, ranked by degree', () => {
    // n0 is a hub fanning out to n1..n9 (degree 9); every other node has
    // degree 1. Only the hub and its two alphabetically-first leaves fit.
    const adjacency = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    adjacency.set('n0', new Set(Array.from({ length: 9 }, (_, j) => `n${j + 1}`)));
    for (let i = 1; i <= 9; i += 1) {
      reverse.set(`n${i}`, new Set(['n0']));
    }
    const capped = capPersistedAdjacency(adjacency, reverse, {
      ...DEFAULT_ORIENTATION_LIMITS,
      maxPersistedGraphNodes: 3,
      maxPersistedGraphBytes: 1024 * 1024,
    });
    expect(capped.nodeCount).toBe(3);
    expect(capped.adjacencyRecord.n0).toEqual(['n1', 'n2']);
    expect(capped.reverseRecord.n1).toEqual(['n0']);
    expect(capped.reverseRecord.n2).toEqual(['n0']);
  });

  it('stops before the node cap when the byte budget is exhausted', () => {
    const adjacency = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    const longSuffix = 'x'.repeat(500);
    for (let i = 0; i < 50; i += 1) {
      adjacency.set(`node-${i}-${longSuffix}`, new Set([`target-${i}-${longSuffix}`]));
    }
    const capped = capPersistedAdjacency(adjacency, reverse, {
      ...DEFAULT_ORIENTATION_LIMITS,
      maxPersistedGraphNodes: 50,
      maxPersistedGraphBytes: 4_000,
    });
    expect(capped.nodeCount).toBeGreaterThan(0);
    expect(capped.nodeCount).toBeLessThan(50);
  });

  it('always keeps at least one node even if it alone exceeds the byte budget', () => {
    const adjacency = new Map<string, Set<string>>([['only', new Set(['a', 'b'])]]);
    const capped = capPersistedAdjacency(adjacency, new Map(), {
      ...DEFAULT_ORIENTATION_LIMITS,
      maxPersistedGraphNodes: 50,
      maxPersistedGraphBytes: 1,
    });
    expect(capped.nodeCount).toBe(1);
  });
});
