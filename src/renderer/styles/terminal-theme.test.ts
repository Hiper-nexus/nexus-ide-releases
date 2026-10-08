import { describe, expect, it } from 'vitest';
import {
  IMPORTED_TERMINAL_KEYS,
  importedThemeSchema,
} from '../../shared/settings-types';
import {
  LEGACY_NEXUS_CYAN_TERMINAL,
  TERMINAL_THEME,
  TERMINAL_THEMES,
} from './terminal-theme';
import { LEGACY_NEXUS_CYAN_PALETTE, PALETTES } from './ui-theme';

/** Minúsculo, como o schema do tema importado exige. */
const HEX = /^#[0-9a-f]{6}$/;
/** Borda translúcida documentada (DESIGN.md §2): branco com alpha. */
const TRANSLUCENT_BORDER = /^rgb\(255 255 255 \/ 0\.\d+\)$/;

describe('Pink City terminal palette', () => {
  it('is selectable beside Nexus Dark', () => {
    expect(Object.keys(TERMINAL_THEMES)).toEqual(
      expect.arrayContaining(['nexus-pink-city', 'nexus-dark']),
    );
    expect(
      Object.entries(TERMINAL_THEMES).find(
        ([id]) => id === 'nexus-pink-city',
      )?.[1].label,
    ).toBe('Pink City');
  });

  it('reuses the existing untinted dark xterm palette', () => {
    const pinkCity = Object.entries(TERMINAL_THEMES).find(
      ([id]) => id === 'nexus-pink-city',
    )?.[1];

    expect(pinkCity?.theme).toBe(TERMINAL_THEME);
    expect(pinkCity?.theme).toBe(TERMINAL_THEMES['nexus-dark'].theme);
    expect(pinkCity?.theme).toMatchObject({
      background: '#0b0b0c',
      cursor: '#7c86ff',
      selectionBackground: '#2d3055',
    });
  });
});

describe('paletas embutidas só têm cores válidas', () => {
  const terminalThemes = [
    ...Object.entries(TERMINAL_THEMES).map(([id, entry]) => [id, entry.theme] as const),
    ['legacy-cyan', LEGACY_NEXUS_CYAN_TERMINAL] as const,
  ];
  const uiPalettes = [
    ...Object.entries(PALETTES),
    ['legacy-cyan', LEGACY_NEXUS_CYAN_PALETTE] as const,
  ];

  it.each(terminalThemes)('xterm %s: toda cor é #rrggbb', (_id, theme) => {
    for (const [key, value] of Object.entries(theme)) {
      expect(value, key).toMatch(HEX);
    }
    // Base do import do VS Code: o mesmo schema que guarda settings.json.
    const subset = Object.fromEntries(
      IMPORTED_TERMINAL_KEYS.map((key) => [key, String(theme[key])]),
    );
    expect(importedThemeSchema.shape.terminal.safeParse(subset).success).toBe(true);
  });

  it.each(uiPalettes)('UI %s: toda cor é #rrggbb (borda pode ser branco translúcido)', (_id, palette) => {
    for (const [key, value] of Object.entries(palette)) {
      const border = key === 'border' || key === 'borderStrong';
      expect(HEX.test(value) || (border && TRANSLUCENT_BORDER.test(value)), `${key}=${value}`).toBe(
        true,
      );
    }
  });
});
