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
});
