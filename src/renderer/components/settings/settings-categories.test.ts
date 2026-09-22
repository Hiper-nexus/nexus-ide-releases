import { expect, it } from 'vitest';
import { SETTINGS_GROUPS } from './settings-nav';

const SETTINGS_ITEMS = SETTINGS_GROUPS.flatMap(group => group.items);
import { SETTINGS_CATEGORIES, settingsCategoryFor } from './settings-categories';

it('keeps every settings destination reachable once under seven task categories', () => {
  const sections = SETTINGS_CATEGORIES.flatMap(category => category.sections);
  expect(SETTINGS_CATEGORIES).toHaveLength(7);
  expect(new Set(sections).size).toBe(sections.length);
  expect([...sections].sort()).toEqual(SETTINGS_GROUPS.flatMap(group => group.items.map(item => item.id)).sort());
});

it('gives every destination one unique name (no "Ferramentas" in three places)', () => {
  const titles = SETTINGS_ITEMS.map(item => item.title.toLocaleLowerCase('pt-BR'));
  expect(new Set(titles).size).toBe(titles.length);
});

it('keeps advanced tabs as a trailing subset of their category', () => {
  for (const category of SETTINGS_CATEGORIES) {
    const advanced = category.advanced ?? [];
    expect(category.sections.slice(category.sections.length - advanced.length)).toEqual(advanced);
  }
});

it('puts credentials and spend together, and pets under appearance', () => {
  for (const id of ['account', 'providers', 'api-keys', 'usage-quota'] as const) {
    expect(settingsCategoryFor(id)?.id).toBe('account');
  }
  expect(settingsCategoryFor('pets')?.id).toBe('personalization');
  expect(settingsCategoryFor('terminal')?.id).toBe('personalization');
  expect(settingsCategoryFor('media')?.id).toBe('ai');
  expect(settingsCategoryFor('mcps')?.id).toBe('connections');
});
