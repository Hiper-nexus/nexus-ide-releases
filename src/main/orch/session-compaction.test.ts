import { describe, expect, it } from 'vitest';
import { compactHandoffSummaries, compactText } from './session-compaction';

describe('session-compaction', () => {
  it('leaves short text alone', () => {
    expect(compactText('hello', { maxChars: 100 })).toEqual({
      text: 'hello',
      omitted: false,
    });
  });

  it('truncates long text with marker', () => {
    const long = 'a'.repeat(500);
    const { text, omitted } = compactText(long, { maxChars: 100 });
    expect(omitted).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).toContain('compacted');
  });

  it('compacts multiple handoff summaries under budget', () => {
    const out = compactHandoffSummaries(
      ['x'.repeat(400), 'y'.repeat(400)],
      300,
    );
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
