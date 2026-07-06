import { describe, expect, test } from 'vitest';
import { SETTINGS_GROUPS, filterSettingsGroups } from './settings-nav';

describe('SETTINGS_GROUPS', () => {
  test('covers every settings section exactly once (no duplicates, no gaps)', () => {
    const ids = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids).toContain('account');
    expect(ids).toContain('shortcuts');
  });

  test('never shows the bare word "MÍDIA" in two different rows', () => {
    const titles = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.title));
    const midia = titles.filter((t) => t === 'MÍDIA');
    expect(midia.length).toBeLessThanOrEqual(1);
  });
});

describe('filterSettingsGroups', () => {
  test('returns all groups unchanged for an empty query', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, '');
    expect(result).toEqual(SETTINGS_GROUPS);
  });

  test('matches on title, case-insensitively', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voice');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('voice');
    expect(ids).not.toContain('terminal');
  });

  test('matches on subtitle too', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'shell');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('terminal');
  });

  test('ignores diacritics both ways (query "atalho" finds "ATALHOS")', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'atalho');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('shortcuts');
  });

  test('drops groups that have no matching items', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voice');
    expect(result.every((g) => g.items.length > 0)).toBe(true);
  });

  test('returns nothing for a query that matches no section', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'zzzznotathing');
    expect(result).toEqual([]);
  });
});
