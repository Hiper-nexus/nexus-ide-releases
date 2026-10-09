import { describe, expect, it } from 'vitest';
import {
  markdownToTiptapContent,
  tiptapJsonToMarkdown,
} from './ComposerTiptapEditor';

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

  it('loads each newline as its own paragraph, including a blank line', () => {
    const doc = markdownToTiptapContent('foo\n\n**bar**');
    expect(doc.content).toHaveLength(3);
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'foo' }],
    });
    expect(doc.content[1]).toEqual({ type: 'paragraph' });
    expect(doc.content[2]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bar', marks: [{ type: 'bold' }] },
      ],
    });
    expect(tiptapJsonToMarkdown(doc)).toBe('foo\n\n**bar**');
    for (const paragraph of doc.content) {
      for (const node of paragraph.content ?? []) {
        expect(node.text.includes('\n')).toBe(false);
      }
    }
  });

  it('emits a newline for a hardBreak inside the paragraph', () => {
    expect(
      tiptapJsonToMarkdown({
        content: [
          {
            content: [
              { type: 'text', text: 'foo' },
              { type: 'hardBreak' },
              { type: 'text', text: 'bar' },
            ],
          },
        ],
      }),
    ).toBe('foo\nbar');
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
