import { describe, expect, it } from 'vitest';
import {
  WorktreePool,
  type PooledWorktreeEntry,
} from './worktree-pool';

const SCOPE = 'scope-key';
const BASE_SHA = 'a'.repeat(40);

function entry(overrides: Partial<PooledWorktreeEntry> = {}): PooledWorktreeEntry {
  return {
    scopeKey: SCOPE,
    worktreePath: '/wt/pool/one',
    branchRef: 'refs/heads/nexus-pool/one',
    baseSha: BASE_SHA,
    createdAt: 1,
    ...overrides,
  };
}

describe('WorktreePool', () => {
  it('reserves a matching entry (valid adoption)', () => {
    const pool = new WorktreePool();
    pool.stage(entry());
    const { entry: got, stale } = pool.reserve(SCOPE, {}, BASE_SHA);
    expect(got).toBeDefined();
    expect(got?.branchRef).toBe('refs/heads/nexus-pool/one');
    expect(stale).toEqual([]);
    expect(pool.size).toBe(0);
  });

  it('returns no entry when the pool is empty', () => {
    const pool = new WorktreePool();
    expect(pool.reserve(SCOPE, {}, BASE_SHA)).toEqual({ stale: [] });
  });

  it('rejects obsolete entries (HEAD moved) and reports them stale', () => {
    const pool = new WorktreePool();
    const stale = entry({ branchRef: 'stale' });
    pool.stage(stale);
    const moved = 'b'.repeat(40);
    const { entry: got, stale: staleList } = pool.reserve(SCOPE, {}, moved);
    expect(got).toBeUndefined();
    expect(staleList).toEqual([stale]);
    expect(pool.size).toBe(0);
  });

  it('does not match a different base (tab with its own isolated folder)', () => {
    const pool = new WorktreePool();
    const coordination = entry({ baseRootRealPath: undefined });
    pool.stage(coordination);
    const { entry: got, stale } = pool.reserve(SCOPE, { baseRootRealPath: '/tab/worktree' }, BASE_SHA);
    expect(got).toBeUndefined();
    // Different base: not stale (still valid for a coordination writer), kept.
    expect(stale).toEqual([]);
    expect(pool.size).toBe(1);
  });

  it('matches a different baseRef only when the ref equals the request', () => {
    const pool = new WorktreePool();
    const byRef = entry({ baseRef: 'origin/feature' });
    pool.stage(byRef);
    expect(pool.reserve(SCOPE, { baseRef: 'origin/feature' }, BASE_SHA).entry).toBe(byRef);
    // Re-stage and ask for a different ref: no match, not stale.
    pool.stage(byRef);
    expect(pool.reserve(SCOPE, { baseRef: 'main' }, BASE_SHA)).toEqual({ stale: [] });
  });

  it('gives two concurrent writers distinct entries (no double handout)', () => {
    const pool = new WorktreePool();
    pool.stage(entry({ branchRef: 'one' }));
    pool.stage(entry({ branchRef: 'two' }));
    const first = pool.reserve(SCOPE, {}, BASE_SHA);
    const second = pool.reserve(SCOPE, {}, BASE_SHA);
    expect(first.entry).toBeDefined();
    expect(second.entry).toBeDefined();
    expect(first.entry?.branchRef).not.toBe(second.entry?.branchRef);
    expect(pool.size).toBe(0);
    // A third writer finds the pool drained.
    expect(pool.reserve(SCOPE, {}, BASE_SHA).entry).toBeUndefined();
  });

  it('enforces the per-scope limit', () => {
    const pool = new WorktreePool({ maxPerScope: 2 });
    pool.stage(entry({ branchRef: 'a' }));
    pool.stage(entry({ branchRef: 'b' }));
    pool.stage(entry({ branchRef: 'c' }));
    expect(pool.size).toBe(2);
    expect(pool.entriesFor(SCOPE).map((e) => e.branchRef)).toEqual(['a', 'b']);
  });

  it('supports disabling via maxPerScope 0', () => {
    const pool = new WorktreePool({ maxPerScope: 0 });
    pool.stage(entry());
    expect(pool.size).toBe(0);
  });

  it('discards and clears scope entries', () => {
    const pool = new WorktreePool();
    const one = entry({ branchRef: 'one' });
    const two = entry({ branchRef: 'two' });
    pool.stage(one);
    pool.stage(two);
    expect(pool.discard(SCOPE, one)).toBe(true);
    expect(pool.discard(SCOPE, one)).toBe(false);
    expect(pool.size).toBe(1);
    expect(pool.clearScope(SCOPE)).toEqual([two]);
    expect(pool.size).toBe(0);
  });
});
