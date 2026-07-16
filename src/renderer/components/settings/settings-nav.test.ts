import { describe, expect, test } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_PRIMARY_GROUPS,
  SETTINGS_ADVANCED_GROUPS,
  filterSettingsGroups,
  isSettingsGroupExpanded,
  isAdvancedSettingsSection,
  toggleSettingsGroup,
  settingsSectionPillar,
  settingsPrimaryPillarOrder,
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

  test('primary nav is Você · App · Agentes · Sistema with 15 day-to-day entries', () => {
    const labels = SETTINGS_PRIMARY_GROUPS.map((g) => g.label);
    expect(labels).toEqual(['Você', 'App', 'Agentes', 'Sistema']);
    expect(settingsPrimaryPillarOrder()).toEqual([
      'you',
      'app',
      'agents',
      'system',
    ]);
    const primaryIds = SETTINGS_PRIMARY_GROUPS.flatMap((g) =>
      g.items.map((i) => i.id),
    );
    expect(primaryIds).toHaveLength(15);
    // Labs é primário por decisão: o painel de descoberta de flags não pode
    // ficar atrás do "Avançado" (achado de operador na 0.19).
    expect(primaryIds).toContain('labs');
    expect(isAdvancedSettingsSection('labs')).toBe(false);
    expect(primaryIds).toContain('voice');
    expect(primaryIds).toContain('appearance');
    expect(primaryIds).toContain('ranking');
    expect(primaryIds).toContain('usage-quota');
    expect(primaryIds).toContain('harness');
    expect(primaryIds).toContain('mcps');
    expect(primaryIds).toContain('tools');
    expect(primaryIds).toContain('media');
    expect(primaryIds).toContain('diagnostics');
    expect(primaryIds).not.toContain('agents');
    expect(isAdvancedSettingsSection('mcps')).toBe(false);
    expect(isAdvancedSettingsSection('tools')).toBe(false);
    expect(isAdvancedSettingsSection('media')).toBe(false);
    expect(isAdvancedSettingsSection('voice')).toBe(false);
  });

  test('primary groups carry emotional story kickers', () => {
    for (const group of SETTINGS_PRIMARY_GROUPS) {
      expect(group.story?.length).toBeGreaterThan(8);
      expect(group.pillarId).toBeTruthy();
    }
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
    expect(ids).not.toContain('mcps');
    expect(ids).not.toContain('tools');
    expect(ids).not.toContain('media');
    expect(SETTINGS_ADVANCED_GROUPS).toHaveLength(4);
    expect(
      Math.max(...SETTINGS_ADVANCED_GROUPS.map((g) => g.items.length)),
    ).toBeLessThanOrEqual(6);
  });

  test('reveals only a selected or explicitly expanded group', () => {
    const [system, integrations, catalog] = SETTINGS_ADVANCED_GROUPS;
    const expanded = toggleSettingsGroup(new Set<string>(), integrations.label);

    expect(isSettingsGroupExpanded(system, 'account', expanded)).toBe(false);
    expect(isSettingsGroupExpanded(integrations, 'account', expanded)).toBe(true);
    expect(isSettingsGroupExpanded(catalog, 'agents', new Set())).toBe(true);
    expect(isSettingsGroupExpanded(system, 'agents', new Set())).toBe(false);
    expect(toggleSettingsGroup(expanded, integrations.label).size).toBe(0);
  });
});

describe('settingsSectionPillar', () => {
  test('maps every section to an endorphin pillar story', () => {
    for (const id of SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id))) {
      const pillar = settingsSectionPillar(id);
      expect(pillar.story.length).toBeGreaterThan(8);
    }
  });

  test('voice lives under Você; diagnostics under Sistema', () => {
    expect(settingsSectionPillar('voice').id).toBe('you');
    expect(settingsSectionPillar('account').id).toBe('you');
    expect(settingsSectionPillar('diagnostics').id).toBe('system');
    expect(settingsSectionPillar('providers').id).toBe('agents');
  });
});
