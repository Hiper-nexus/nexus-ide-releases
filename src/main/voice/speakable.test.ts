import { describe, expect, it } from 'vitest';
import { cleanText, splitSentences, toSpeakable } from './speakable';

describe('cleanText', () => {
  it('strips ANSI escape codes', () => {
    expect(cleanText('\x1b[31mhello\x1b[0m world')).toBe('hello world');
  });

  it('removes fenced and inline code', () => {
    const raw = 'Here is code:\n```js\nconst x = 1;\n```\nand `inline` too.';
    const cleaned = cleanText(raw);
    expect(cleaned).not.toContain('const x');
    expect(cleaned).not.toContain('inline');
    expect(cleaned).toContain('Here is code');
  });

  it('collapses whitespace and trims prompt noise', () => {
    expect(cleanText('  $ foo   bar  ')).toBe('foo bar');
  });
});

describe('splitSentences', () => {
  it('splits on sentence boundaries', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });
});

describe('toSpeakable', () => {
  it('returns empty for mode off', () => {
    expect(toSpeakable('anything at all here', 'off')).toBe('');
  });

  it('summary keeps at most three sentences', () => {
    const raw = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const out = toSpeakable(raw, 'summary');
    expect(out).toContain('First sentence.');
    expect(out).toContain('Third sentence.');
    expect(out).not.toContain('Fourth sentence.');
  });

  it('summary caps very long single sentences with an ellipsis', () => {
    const long = `${'word '.repeat(120)}.`;
    const out = toSpeakable(long, 'summary');
    expect(out.length).toBeLessThanOrEqual(242);
    expect(out.endsWith('…')).toBe(true);
  });

  it('summary of a code-only response returns a generic spoken line', () => {
    const out = toSpeakable('```js\nconst x = 1;\nconst y = 2;\n```', 'summary');
    expect(out).toBe('Done. The response is mostly code — check the pane.');
  });

  it('returns empty when there is nothing meaningful and no code', () => {
    expect(toSpeakable('   \n\n   ', 'summary')).toBe('');
  });

  it('full mode returns cleaned text without sentence limiting', () => {
    const raw = 'Alpha. Beta. Gamma. Delta. Epsilon.';
    expect(toSpeakable(raw, 'full')).toBe('Alpha. Beta. Gamma. Delta. Epsilon.');
  });
});
