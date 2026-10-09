import { describe, expect, it } from 'vitest';
import { tiptapJsonToMarkdown } from './ComposerTiptapEditor';

describe('ComposerTiptapEditor serialization', () => {
  it('keeps a line break between paragraphs', () => {
    expect(
      tiptapJsonToMarkdown({
        content: [
          { content: [{ text: 'hello' }] },
          { content: [{ text: 'world' }] },
        ],
      }),
    ).toBe('hello\nworld');
  });

  it('keeps an empty paragraph as a blank line and marks inside the block', () => {
    expect(
      tiptapJsonToMarkdown({
        content: [
          { content: [{ text: 'hello', marks: [{ type: 'bold' }] }] },
          { content: [] },
          { content: [{ text: 'world' }] },
        ],
      }),
    ).toBe('**hello**\n\nworld');
  });
});
