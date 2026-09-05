import { expect, it } from 'vitest';
import { SETTINGS_GROUPS } from './settings-nav';
import { SETTINGS_CATEGORIES, settingsCategoryFor } from './settings-categories';

it('keeps every settings destination reachable once under nine primary categories', () => {
  const sections = SETTINGS_CATEGORIES.flatMap(category => category.sections);
  expect(SETTINGS_CATEGORIES).toHaveLength(9);
  expect(new Set(sections).size).toBe(sections.length);
  expect([...sections].sort()).toEqual(SETTINGS_GROUPS.flatMap(group => group.items.map(item => item.id)).sort());
  expect(sections).toContain('pets');
});

it('keeps media setup distinct from models and pets directly under appearance', () => {
  expect(settingsCategoryFor('media')?.id).toBe('media');
  expect(settingsCategoryFor('media-catalog')?.id).toBe('media');
  expect(settingsCategoryFor('pets')?.id).toBe('personalization');
});
