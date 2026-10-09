import { describe, expect, it } from 'vitest';
import {
  parseInlineMarkdown,
  serializeInlineMarkdown,
  spanText,
  type RichTextSpan,
} from './rich-text-marks';

describe('rich text marks (T3 composer core)', () => {
  it('parses bold, italic, strike and code', () => {
    expect(parseInlineMarkdown('**b**')).toEqual([
      { text: 'b', marks: ['bold'] },
    ]);
    expect(parseInlineMarkdown('*i*')).toEqual([
      { text: 'i', marks: ['italic'] },
    ]);
    expect(parseInlineMarkdown('~~s~~')).toEqual([
      { text: 's', marks: ['strike'] },
    ]);
    expect(parseInlineMarkdown('`c`')).toEqual([
      { text: 'c', marks: ['code'] },
    ]);
  });

  it('leaves unmatched markers literal so nothing typed is lost', () => {
    const spans = parseInlineMarkdown('**open and *mixed');
    expect(spanText(spans)).toBe('**open and *mixed');
  });

  it('keeps escaped markers literal', () => {
    expect(parseInlineMarkdown('\\*not italic\\*')).toEqual([
      { text: '*not italic*', marks: [] },
    ]);
  });

  it('nests bold inside italic', () => {
    const spans = parseInlineMarkdown('***both***');
    expect(spanText(spans)).toBe('both');
    expect(spans[0]?.marks).toContain('bold');
    expect(spans[0]?.marks).toContain('italic');
  });

  it('multi-backtick code stays literal', () => {
    expect(spanText(parseInlineMarkdown('``a``'))).toBe('``a``');
  });

  it('serializes marks back to markdown', () => {
    expect(
      serializeInlineMarkdown([{ text: 'b', marks: ['bold'] }]),
    ).toBe('**b**');
    expect(
      serializeInlineMarkdown([{ text: 'x', marks: ['bold', 'italic'] }]),
    ).toBe('***x***');
  });

  it('round-trips a mixed line', () => {
    const source = 'plain **bold** and `code`';
    const spans = parseInlineMarkdown(source);
    expect(spanText(spans)).toBe('plain bold and code');
    expect(serializeInlineMarkdown(spans)).toBe(source);
  });

  it('round-trips delimiter characters inside marks and plain text', () => {
    const cases: RichTextSpan[][] = [
      [{ text: 'a**b', marks: ['bold'] }],
      [{ text: '**not bold**', marks: [] }],
      [{ text: 'a`b', marks: ['code'] }],
      [{ text: 'a\\b_c~d', marks: ['italic'] }],
    ];
    for (const spans of cases) {
      expect(parseInlineMarkdown(serializeInlineMarkdown(spans))).toEqual(spans);
    }
  });
});
