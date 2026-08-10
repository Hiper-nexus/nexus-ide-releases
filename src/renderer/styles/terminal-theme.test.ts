import { describe, expect, it } from 'vitest';
import { TERMINAL_THEME, TERMINAL_THEMES } from './terminal-theme';

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
