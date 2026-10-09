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

  it('matching multiple-backtick code preserves its literal body', () => {
    expect(parseInlineMarkdown('``a``')).toEqual([{text:'a',marks:['code']}]);
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

describe('F-1079: lossless stored Markdown and literal marks', () => {
  const literals = [String.raw`C:\Users\Alice\repo`, String.raw`\\server\share\folder`, String.raw`\n \d+\s regex`, String.raw`{"path":"C:\\Users","line":"\n"}`, 'trailing\\', 'repeated\\\\slashes'];
  it.each(literals)('retains non-delimiter backslashes from stored input: %s', (source) => {
    expect(spanText(parseInlineMarkdown(source))).toBe(source);
    expect(spanText(parseInlineMarkdown('`' + source + '`'))).toBe(source);
  });
  const code = ['x`y', 'x``y', '`edge', 'edge`', '``runs``', ' x ', '   ', String.raw`C:\Users\Alice`, String.raw`\\server\share`, 'trailing\\', String.raw`\n\d`, '***literal***'];
  it.each(code)('serializes code text without losing slash/tick content: %s', (text) => {
    const parsed = parseInlineMarkdown(serializeInlineMarkdown([{ text, marks: ['code'] }]));
    expect(spanText(parsed)).toBe(text);
    expect(parsed.every(span => span.marks.includes('code'))).toBe(true);
  });
  it.each(['x*y','x**y','x~~y','x`y','x\\*y','x\\\\*y'])('serializes literal delimiters under bold: %s', (text) => {
    const parsed = parseInlineMarkdown(serializeInlineMarkdown([{ text, marks: ['bold'] }]));
    expect(spanText(parsed)).toBe(text);
    expect(parsed.every(span => span.marks.includes('bold'))).toBe(true);
  });
  it('keeps multiline code text as separately delimited lines', () => {
    expect(spanText(parseInlineMarkdown(serializeInlineMarkdown([{text:'one\ntwo',marks:['code']}])))).toBe('one\ntwo');
  });
});

it('F-1079: unmarked trailing slashes and adjacent code spans preserve literal text', () => {
  for (const text of ['trailing\\','trailing\\\\',String.raw`\\server\share`,String.raw`x\*y`]) {
    expect(spanText(parseInlineMarkdown(serializeInlineMarkdown([{text,marks:[]}])))).toBe(text);
  }
  expect(spanText(parseInlineMarkdown(serializeInlineMarkdown([{text:'a',marks:['code']},{text:'b',marks:['code']}])))).toBe('ab');
  for (const marks of [['bold'],['code']] as const) {
    expect(spanText(parseInlineMarkdown(serializeInlineMarkdown([{text:'a\\',marks:[]},{text:'b',marks:[...marks]}])))).toBe('a\\b');
    expect(spanText(parseInlineMarkdown(serializeInlineMarkdown([{text:'a\\',marks:[]},{text:' *',marks:[...marks]}])))).toBe('a\\ *');
  }
});
