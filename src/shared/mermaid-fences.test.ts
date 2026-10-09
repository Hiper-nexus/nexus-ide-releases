import { describe, expect, it } from 'vitest';
import {
  escapeMermaidSource,
  hasMermaidBlock,
  splitMarkdownMermaid,
} from './mermaid-fences';

describe('mermaid fences (T3 markdown)', () => {
  it('splits prose and mermaid blocks in order', () => {
    const parts = splitMarkdownMermaid(
      ['# Título', '', '```mermaid', 'graph TD; A-->B', '```', 'fim'].join('\n'),
    );
    expect(parts.map((p) => p.kind)).toEqual(['text', 'mermaid', 'text']);
    const mermaid = parts.find((p) => p.kind === 'mermaid');
    expect(mermaid && mermaid.kind === 'mermaid' && mermaid.source).toBe(
      'graph TD; A-->B',
    );
  });

  it('accepts ```mmd and indented fences', () => {
    const parts = splitMarkdownMermaid(
      ['  ```mmd', '  sequenceDiagram', '    A->>B: hi', '  ```'].join('\n'),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe('mermaid');
    expect(parts[0]?.kind === 'mermaid' && parts[0].source).toContain(
      'sequenceDiagram',
    );
    expect(parts[0]?.kind === 'mermaid' && parts[0].source).not.toContain('  ```');
  });

  it('leaves non-mermaid fences intact in text', () => {
    const md = ['```ts', 'const a = 1;', '```'].join('\n');
    const parts = splitMarkdownMermaid(md);
    expect(parts).toEqual([{ kind: 'text', text: md }]);
    expect(hasMermaidBlock(md)).toBe(false);
  });

  it('numbers mermaid blocks for stable ids', () => {
    const parts = splitMarkdownMermaid(
      [
        '```mermaid',
        'graph LR; X-->Y',
        '```',
        'texto',
        '```mermaid',
        'graph LR; Y-->Z',
        '```',
      ].join('\n'),
    );
    const diagrams = parts.filter((p) => p.kind === 'mermaid');
    expect(diagrams.map((d) => (d.kind === 'mermaid' ? d.index : -1))).toEqual([
      0, 1,
    ]);
    expect(hasMermaidBlock('```mermaid\nx\n```')).toBe(true);
  });

  it('unclosed mermaid fence still yields the source', () => {
    const parts = splitMarkdownMermaid('```mermaid\ngraph TD; A-->B');
    expect(parts[0]?.kind).toBe('mermaid');
  });

  it('escapes source for safe pre text', () => {
    expect(escapeMermaidSource('<script>&')).toBe('&lt;script&gt;&amp;');
  });
});
