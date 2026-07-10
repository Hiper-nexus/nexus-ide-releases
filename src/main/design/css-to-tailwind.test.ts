import { describe, expect, it } from 'vitest';
import { styleDiffToTailwind } from './css-to-tailwind';

describe('styleDiffToTailwind', () => {
  it('maps common design edits to tailwind classes', () => {
    const result = styleDiffToTailwind({
      'padding-top': '24px',
      'background-color': '#16a34a',
    });
    // px values become arbitrary-value classes; rem hits the default scale.
    expect(result.classes).toContain('pt-[24px]');
    expect(result.classes).toContain('bg-[#16a34a]');
    expect(Object.keys(result.unsupported)).toHaveLength(0);
    expect(styleDiffToTailwind({ 'padding-top': '1.5rem' }).classes).toContain('pt-6');
  });

  it('falls back to arbitrary values for off-scale numbers', () => {
    const result = styleDiffToTailwind({ 'font-size': '15px' });
    expect(result.classes).toContain('text-[15px]');
  });

  it('collects properties the translator cannot express', () => {
    const result = styleDiffToTailwind({ 'not-a-real-prop': 'zzz' });
    expect(result.classes).toHaveLength(0);
    expect(result.unsupported).toHaveProperty('not-a-real-prop', 'zzz');
  });

  it('returns nothing for an empty diff', () => {
    expect(styleDiffToTailwind({})).toEqual({ classes: [], unsupported: {} });
  });
});
