import { describe, expect, it } from 'vitest';
import { WorkspaceGrantRegistry } from './workspace-grants';

describe('WorkspaceGrantRegistry', () => {
  it('makes folder-picker grants owner-bound and single-use', () => {
    const grants = new WorkspaceGrantRegistry(60_000);
    grants.grant({ id: 1 }, '/workspace/a', 1_000);

    expect(grants.consume({ id: 2 }, '/workspace/a', 1_001)).toBe(false);
    expect(grants.consume({ id: 1 }, '/workspace/a', 1_001)).toBe(true);
    expect(grants.consume({ id: 1 }, '/workspace/a', 1_002)).toBe(false);
  });

  it('rejects expired grants', () => {
    const grants = new WorkspaceGrantRegistry(1_000);
    grants.grant({ id: 1 }, '/workspace/a', 1_000);

    expect(grants.consume({ id: 1 }, '/workspace/a', 2_001)).toBe(false);
  });

  it('clears every grant owned by a destroyed renderer', () => {
    const grants = new WorkspaceGrantRegistry(60_000);
    grants.grant({ id: 1 }, '/workspace/a', 1_000);
    grants.grant({ id: 1 }, '/workspace/b', 1_000);
    grants.clear({ id: 1 });

    expect(grants.consume({ id: 1 }, '/workspace/a', 1_001)).toBe(false);
    expect(grants.consume({ id: 1 }, '/workspace/b', 1_001)).toBe(false);
  });
});
