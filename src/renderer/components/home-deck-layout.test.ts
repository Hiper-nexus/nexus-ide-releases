import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeDeckCss = fs.readFileSync(
  new URL('../styles/home-deck.css', import.meta.url),
  'utf8',
);
const baseCss = fs.readFileSync(
  new URL('../styles/base.css', import.meta.url),
  'utf8',
);
const railCss = fs.readFileSync(
  new URL('../styles/rail-onboarding.css', import.meta.url),
  'utf8',
);

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Home Deck layout invariants', () => {
  it('includes padding and border in the centered panel dimensions', () => {
    expect(rule(homeDeckCss, '.home-deck__panel')).toContain(
      'box-sizing: border-box',
    );
  });

  it('uses a continuous surface instead of a decorative grid or ghost card', () => {
    expect(rule(homeDeckCss, '.home-deck')).not.toContain(
      'repeating-linear-gradient',
    );
    expect(rule(homeDeckCss, '.home-deck__panel')).toContain(
      'background: transparent',
    );
    expect(rule(homeDeckCss, '.home-deck__panel')).toContain('box-shadow: none');
  });

  it('centers the deck inside the pane area after the mission rail', () => {
    expect(rule(baseCss, '.app__body')).toContain(
      '--mission-rail-width: 248px',
    );
    expect(rule(railCss, '.mission-rail')).toContain(
      'width: var(--mission-rail-width)',
    );
    expect(rule(homeDeckCss, '.home-deck')).toContain(
      'left: calc(var(--app-body-inset) + var(--mission-rail-width) + var(--app-body-inset))',
    );
  });

  it('keeps the opened contextual panel above the Home empty state', () => {
    expect(homeDeckCss).toMatch(
      /\.app__body > \.mission-rail,\s*\.app__body > \.files,\s*\.app__body > \.ctx-panel\s*\{[^}]*z-index:\s*31/,
    );
    expect(rule(homeDeckCss, '.home-deck')).toContain('z-index: 30');
  });
});
