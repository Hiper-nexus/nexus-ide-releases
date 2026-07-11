import { describe, expect, it } from 'vitest';
import { extractDesignSystemFacts } from './designmd-ingestor-adapter';

const source = Object.freeze({ type: 'file' as const, locator: '.context/docs/design-system.md' });
const sourceHash = 'abcd1234';

describe('extractDesignSystemFacts', () => {
  it('extracts color and typography facts from a DESIGN.md', () => {
    const content = [
      '# DESIGN.md',
      '',
      '## Color Palette',
      '- Primary: #3b82f6',
      '- Background: #ffffff',
      '',
      '## Typography',
      '- Font family: Inter',
      '- Base size: 16px',
      '',
      '## Random Section',
      '- ignored item',
    ].join('\n');

    const facts = extractDesignSystemFacts(content, source, sourceHash);
    const keys = facts.map((fact) => fact.claimKey);

    expect(keys).toEqual(
      expect.arrayContaining([
        'color-primary',
        'color-background',
        'typography-font-family',
        'typography-base-size',
      ]),
    );
    // Unknown sections must not invent extra domains for "Random Section".
    expect(keys.some((k) => k.includes('random'))).toBe(false);
    const primary = facts.find((f) => f.claimKey === 'color-primary');
    expect(primary).toMatchObject({
      value: '#3b82f6',
      kind: 'observed',
      category: 'architecture',
      domains: ['color'],
    });
  });

  it('returns an empty array when no known sections are present', () => {
    const content = '# DESIGN.md\n\n## Business Goals\n- ship fast\n';
    expect(extractDesignSystemFacts(content, source, sourceHash)).toEqual([]);
  });

  it('uses the value as key for plain list items', () => {
    const content = '# DESIGN.md\n\n## Spacing\n- 4pt grid\n- 8pt baseline\n';
    const facts = extractDesignSystemFacts(content, source, sourceHash);
    expect(facts[0].claimKey).toBe('spacing-4pt-grid');
    expect(facts[0].value).toBe('4pt grid');
  });
});
