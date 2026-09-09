import { describe, expect, it } from 'vitest';
import type { EnrichedCatalogInfo, InstalledItemInfo } from '../../../shared/types';
import {
  buildHarnessInventory,
  filterHarnessInventory,
  harnessOrigin,
} from './harness-view-model';

const items: InstalledItemInfo[] = [
  { kind: 'agent', name: 'reviewer', file: '/home/u/.claude/agents/reviewer.md', size: 1, modifiedAt: 1 },
  { kind: 'skill', name: 'imagegen', file: '/home/u/.codex/skills/imagegen/SKILL.md', size: 1, modifiedAt: 1 },
  { kind: 'plugin', name: 'ignored', file: '/home/u/.nexus/plugins/x', size: 1, modifiedAt: 1 },
];

const enriched: EnrichedCatalogInfo = {
  version: 1,
  updatedAt: 1,
  items: [
    {
      kind: 'agent',
      name: 'reviewer',
      tier: 'reviewer',
      blurb: 'Audita entregas',
      whenToUse: 'Antes do merge',
    },
  ],
};

describe('harness view model', () => {
  it('reports the real CLI home as provenance', () => {
    expect(harnessOrigin('C:\\Users\\u\\.gemini\\config\\skills\\x')).toBe(
      'Antigravity',
    );
    expect(harnessOrigin('/home/u/.nexus/plugins/x')).toBe('Nexus');
  });

  it('joins exact kind/name annotations and ignores unrelated catalog kinds', () => {
    const rows = buildHarnessInventory(items, enriched);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.item.name === 'reviewer')).toMatchObject({
      origin: 'Claude',
      tier: 'reviewer',
    });
    expect(rows.find((row) => row.item.name === 'imagegen')?.tier).toBeUndefined();
  });

  it('filters by intent text, tier, kind and origin', () => {
    const rows = buildHarnessInventory(items, enriched);
    expect(
      filterHarnessInventory(rows, {
        query: 'merge',
        kind: 'agent',
        tier: 'reviewer',
        origin: 'Claude',
      }).map((row) => row.item.name),
    ).toEqual(['reviewer']);
    expect(
      filterHarnessInventory(rows, {
        query: '',
        kind: 'todos',
        tier: 'pendente',
        origin: 'todas',
      }).map((row) => row.item.name),
    ).toEqual(['imagegen']);
  });
});
