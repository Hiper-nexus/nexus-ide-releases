import { describe, expect, test } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_PRIMARY_GROUPS,
  SETTINGS_ADVANCED_GROUPS,
  filterSettingsGroups,
  isSettingsGroupExpanded,
  isAdvancedSettingsSection,
  toggleSettingsGroup,
} from './settings-nav';

describe('SETTINGS_GROUPS', () => {
  test('covers every settings section exactly once (no duplicates, no gaps)', () => {
    const ids = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids).toContain('account');
    expect(ids).toContain('appearance');
    expect(ids).toContain('shortcuts');
  });

  test('primary nav stays compact (8 items)', () => {
    const primaryIds = SETTINGS_PRIMARY_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(primaryIds).toHaveLength(8);
    expect(primaryIds).toContain('appearance');
    expect(primaryIds).not.toContain('agents');
  });

  test('advanced sections are flagged correctly', () => {
    expect(isAdvancedSettingsSection('agents')).toBe(true);
    expect(isAdvancedSettingsSection('appearance')).toBe(false);
    expect(isAdvancedSettingsSection('system')).toBe(true);
  });

  test('never shows the bare word "Mídia" in two different rows', () => {
    const titles = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.title));
    const midia = titles.filter((t) => t.toLowerCase() === 'mídia');
    expect(midia.length).toBeLessThanOrEqual(1);
  });
});

describe('filterSettingsGroups', () => {
  test('returns all groups unchanged for an empty query', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, '');
    expect(result).toEqual(SETTINGS_GROUPS);
  });

  test('matches on title, case-insensitively', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voz');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('voice');
    expect(ids).not.toContain('terminal');
  });

  test('matches English aliases without changing Portuguese labels', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voice');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('voice');
  });

  test('matches appearance by pixel subtitle', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'pixel');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('appearance');
  });

  test('matches on subtitle too', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'shell');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('terminal');
  });

  test('ignores diacritics both ways (query "atalho" finds "Atalhos")', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'atalho');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('shortcuts');
  });

  test('drops groups that have no matching items', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voz');
    expect(result.every((g) => g.items.length > 0)).toBe(true);
  });

  test('returns nothing for a query that matches no section', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'zzzznotathing');
    expect(result).toEqual([]);
  });
});

describe('SETTINGS_ADVANCED_GROUPS', () => {
  test('holds catalog and system sections in small operational clusters', () => {
    const ids = SETTINGS_ADVANCED_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('llms');
    expect(ids).toContain('system');
    expect(SETTINGS_ADVANCED_GROUPS).toHaveLength(4);
    expect(Math.max(...SETTINGS_ADVANCED_GROUPS.map((g) => g.items.length))).toBeLessThanOrEqual(6);
  });

  test('reveals only a selected or explicitly expanded group', () => {
    const [system, integrations, arsenal] = SETTINGS_ADVANCED_GROUPS;
    const expanded = toggleSettingsGroup(new Set<string>(), integrations.label);

    expect(isSettingsGroupExpanded(system, 'account', expanded)).toBe(false);
    expect(isSettingsGroupExpanded(integrations, 'account', expanded)).toBe(true);
    expect(isSettingsGroupExpanded(arsenal, 'agents', new Set())).toBe(true);
    expect(isSettingsGroupExpanded(system, 'agents', new Set())).toBe(false);
    expect(toggleSettingsGroup(expanded, integrations.label).size).toBe(0);
  });
});
