import type { TerminalSettings } from '../../shared/settings-types';
import type { VibeProductMigrations } from './vibe-product-floor';

export interface PinkCityDefaultMigrationInput {
  readonly terminal: TerminalSettings;
  readonly productMigrations: VibeProductMigrations;
}

export interface PinkCityDefaultMigrationResult {
  readonly terminal: TerminalSettings;
  readonly productMigrations: VibeProductMigrations;
  /** True when the terminal theme or migration stamp must be persisted. */
  readonly changed: boolean;
}

/**
 * Move installs from the former Nexus Dark default to Pink City once. Other
 * themes are explicit operator choices and only receive the migration stamp.
 */
export function applyPinkCityDefaultTheme(
  input: PinkCityDefaultMigrationInput,
): PinkCityDefaultMigrationResult {
  if (input.productMigrations.pinkCityDefault20260807 === true) {
    return {
      terminal: input.terminal,
      productMigrations: input.productMigrations,
      changed: false,
    };
  }

  return {
    terminal:
      input.terminal.themeId === 'nexus-dark'
        ? { ...input.terminal, themeId: 'nexus-pink-city' }
        : input.terminal,
    productMigrations: {
      ...input.productMigrations,
      pinkCityDefault20260807: true,
    },
    changed: true,
  };
}
