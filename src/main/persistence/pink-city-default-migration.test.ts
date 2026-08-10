import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_SETTINGS } from '../../shared/settings-types';
import { applyPinkCityDefaultTheme } from './pink-city-default-migration';

const migrationCases = [
  {
    name: 'unstamped nexus-dark catches treating the former default as an explicit choice',
    themeId: 'nexus-dark',
    stamped: false,
    expectedThemeId: 'nexus-pink-city',
    expectedChanged: true,
  },
  {
    name: 'unstamped nexus-pink-city catches failing to stamp a fresh default before a later dark selection',
    themeId: 'nexus-pink-city',
    stamped: false,
    expectedThemeId: 'nexus-pink-city',
    expectedChanged: true,
  },
  {
    name: 'unstamped nexus-light catches overwriting an explicit light choice',
    themeId: 'nexus-light',
    stamped: false,
    expectedThemeId: 'nexus-light',
    expectedChanged: true,
  },
  {
    name: 'unstamped dracula catches overwriting an explicit Dracula choice',
    themeId: 'dracula',
    stamped: false,
    expectedThemeId: 'dracula',
    expectedChanged: true,
  },
  {
    name: 'unstamped solarized-dark catches overwriting an explicit Solarized choice',
    themeId: 'solarized-dark',
    stamped: false,
    expectedThemeId: 'solarized-dark',
    expectedChanged: true,
  },
  {
    name: 'stamped nexus-dark catches rerunning migration after the operator returns to dark',
    themeId: 'nexus-dark',
    stamped: true,
    expectedThemeId: 'nexus-dark',
    expectedChanged: false,
  },
  {
    name: 'stamped nexus-pink-city catches persisting an already-migrated default again',
    themeId: 'nexus-pink-city',
    stamped: true,
    expectedThemeId: 'nexus-pink-city',
    expectedChanged: false,
  },
] as const;

describe('applyPinkCityDefaultTheme', () => {
  it.each(migrationCases)(
    '$name',
    ({ themeId, stamped, expectedThemeId, expectedChanged }) => {
      const terminal = {
        ...DEFAULT_TERMINAL_SETTINGS,
        themeId,
        fontFamily: 'Operator Mono',
        fontSize: 15,
        shell: '/bin/zsh',
        performanceMode: 'quality' as const,
      };
      const productMigrations = {
        vibeNoSandboxFloor20260803: true,
        ...(stamped ? { pinkCityDefault20260807: true } : {}),
      };
      const input = { terminal, productMigrations };
      const inputBeforeMigration = structuredClone(input);

      const result = applyPinkCityDefaultTheme(input);

      expect(result.terminal).toEqual({
        ...terminal,
        themeId: expectedThemeId,
      });
      expect(result.productMigrations).toEqual({
        ...productMigrations,
        pinkCityDefault20260807: true,
      });
      expect(result.changed).toBe(expectedChanged);
      expect(input).toEqual(inputBeforeMigration);
    },
  );
});
