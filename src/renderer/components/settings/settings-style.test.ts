import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsCss = ['settings.css', 'settings-controls.css']
  .map((file) =>
    fs.readFileSync(new URL(`../../styles/${file}`, import.meta.url), 'utf8'),
  )
  .join('\n');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return settingsCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Settings visual invariants', () => {
  it('uses a hairline selection without a thick active side stripe', () => {
    expect(rule('.settings-nav__item--active')).not.toMatch(
      /box-shadow:\s*inset\s+[2-9]\d*px/,
    );
  });

  it('restores native scrollbars across the complete Settings surface', () => {
    const settingsSurface = rule('.settings__drawer,\n.settings__drawer *');
    expect(settingsSurface).toContain('scrollbar-color: auto');
    expect(settingsSurface).toContain('scrollbar-width: auto');
    expect(settingsCss).toMatch(
      /\.settings__drawer \*::-webkit-scrollbar[\s\S]*?all:\s*revert/,
    );
  });

  it('keeps primary help and form copy at a readable caption floor', () => {
    expect(rule('.settings-detail__hint')).toContain(
      'font-size: var(--text-sm)',
    );
    expect(rule('.settings-field')).toContain('font-size: var(--text-sm)');
    expect(rule('.settings-btn')).toContain('font-size: var(--text-sm)');
  });

  it('gives the long Oh My Pi controls two readable columns', () => {
    expect(
      rule('.settings-orchestrator__grid.settings-orchestrator__grid--omp'),
    ).toContain('grid-template-columns: repeat(2, minmax(240px, 1fr))');
    expect(settingsCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.settings-orchestrator__grid\.settings-orchestrator__grid--omp\s*\{\s*grid-template-columns:\s*1fr/,
    );
  });
});
