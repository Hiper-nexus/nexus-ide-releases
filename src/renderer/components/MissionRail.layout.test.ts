import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const railCss = fs.readFileSync(
  new URL('../styles/rail-onboarding.css', import.meta.url),
  'utf8',
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return railCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('MissionRail action layout invariants', () => {
  it('keeps every row action at least 32 by 32 pixels', () => {
    const actionRule = rule('.mission-rail__row-action');

    expect(actionRule).toContain('min-width: 32px');
    expect(actionRule).toContain('min-height: 32px');
  });

  it('reserves the complete three-action strip beside mission copy', () => {
    expect(railCss).toMatch(
      /\.mission-rail__row\[data-action-count=["']3["']\][^{]*\{[^}]*padding-right:\s*111px/,
    );
    expect(rule('.mission-rail__row-actions')).toContain('width: 100px');
  });

  it('wraps action slots when the rail switches to its narrow width', () => {
    expect(railCss).toMatch(
      /@media \(max-width:\s*1120px\)[\s\S]*?data-action-count=["']3["'][\s\S]*?width:\s*66px/,
    );
    expect(railCss).toMatch(
      /@media \(max-width:\s*1120px\)[\s\S]*?data-action-count=["']3["'][\s\S]*?min-height:\s*75px/,
    );
  });
});
