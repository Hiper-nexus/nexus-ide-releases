import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_MAX_BLOCKS,
  MARKDOWN_MAX_CHARS,
  MARKDOWN_MAX_DEPTH,
  limitMarkdownSource,
  parseMarkdownBlocks,
  parseMarkdownInline,
  safeExternalHref,
  type MarkdownBlock,
} from './markdown-blocks';

function only(source: string): MarkdownBlock {
  const blocks = parseMarkdownBlocks(source);
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

describe('parseMarkdownBlocks', () => {
  it('títulos de 1 a 6 com marcas inline; 7 cerquilhas viram parágrafo', () => {
    expect(only('# Título **forte**')).toEqual({
      kind: 'heading',
      level: 1,
      inline: [
        { kind: 'text', text: 'Título ', marks: [] },
        { kind: 'text', text: 'forte', marks: ['bold'] },
      ],
    });
    expect(only('###### seis ##')).toMatchObject({ kind: 'heading', level: 6 });
    expect(only('####### sete')).toMatchObject({ kind: 'paragraph' });
  });

  it('parágrafos separados por linha em branco; quebra simples vira break', () => {
    const blocks = parseMarkdownBlocks('linha um\nlinha dois\n\noutro parágrafo');
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'linha um', marks: [] },
          { kind: 'break' },
          { kind: 'text', text: 'linha dois', marks: [] },
        ],
      },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'outro parágrafo', marks: [] }] },
    ]);
  });

  it('listas não ordenadas e ordenadas, com início e aninhamento simples', () => {
    const list = only('- a\n- b\n  - b1\n  - b2\n- c');
    expect(list).toMatchObject({ kind: 'list', ordered: false });
    if (list.kind !== 'list') throw new Error('lista');
    expect(list.items).toHaveLength(3);
    expect(list.items[1]).toMatchObject([
      { kind: 'paragraph' },
      { kind: 'list', ordered: false, items: [[{ kind: 'paragraph' }], [{ kind: 'paragraph' }]] },
    ]);

    const ordered = only('3. três\n4. quatro\n   - sub');
    expect(ordered).toMatchObject({ kind: 'list', ordered: true, start: 3 });
    if (ordered.kind !== 'list') throw new Error('lista');
    expect(ordered.items[1]?.[1]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('aninhamento com 2 espaços sob item ordenado (estilo comum dos agentes)', () => {
    const ordered = only('1. passo\n  - detalhe\n2. outro');
    if (ordered.kind !== 'list') throw new Error('lista');
    expect(ordered.items).toHaveLength(2);
    expect(ordered.items[0]?.[1]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('marcador diferente encerra a lista e abre outra', () => {
    const blocks = parseMarkdownBlocks('- a\n1. b');
    expect(blocks.map((b) => b.kind === 'list' && b.ordered)).toEqual([false, true]);
  });

  it('citação com conteúdo em bloco', () => {
    const quote = only('> **nota**\n> - item');
    expect(quote).toMatchObject({
      kind: 'quote',
      blocks: [{ kind: 'paragraph' }, { kind: 'list' }],
    });
  });

  it('bloco de código cercado preserva o texto literal e a linguagem saneada', () => {
    expect(only('```ts\nconst a = 1 < 2 && "<b>";\n  **não é negrito**\n```')).toEqual({
      kind: 'code',
      language: 'ts',
      text: 'const a = 1 < 2 && "<b>";\n  **não é negrito**',
    });
    expect(only('~~~~\n```\ndentro\n```\n~~~~')).toEqual({
      kind: 'code',
      language: '',
      text: '```\ndentro\n```',
    });
    expect(only('```c++ extra\nx\n```')).toMatchObject({ kind: 'code', language: 'c++' });
    expect(only('```"><img src=x>\nx\n```')).toMatchObject({ kind: 'code', language: '' });
  });

  it('cerca sem fechamento vai até o fim', () => {
    expect(only('```\naberto\nsem fim')).toEqual({ kind: 'code', language: '', text: 'aberto\nsem fim' });
  });

  it('linha horizontal', () => {
    expect(parseMarkdownBlocks('a\n\n---\n\nb').map((b) => b.kind)).toEqual(['paragraph', 'rule', 'paragraph']);
  });

  it('tabela GFM simples com alinhamento, células escapadas e linhas desiguais', () => {
    const table = only('| Nome | Valor |\n|:--|--:|\n| a \\| b | `x|y` |\n| só |');
    expect(table).toMatchObject({ kind: 'table', align: ['left', 'right'] });
    if (table.kind !== 'table') throw new Error('tabela');
    expect(table.header.map((cell) => cell.map((n) => (n.kind === 'text' ? n.text : '')).join(''))).toEqual(['Nome', 'Valor']);
    expect(table.rows[0]?.[0]).toEqual([{ kind: 'text', text: 'a | b', marks: [] }]);
    expect(table.rows[0]?.[1]).toEqual([{ kind: 'text', text: 'x|y', marks: ['code'] }]);
    expect(table.rows[1]).toHaveLength(2);
    expect(table.rows[1]?.[1]).toEqual([]);
  });

  it('sem linha delimitadora não há tabela', () => {
    expect(only('a | b\nc | d')).toMatchObject({ kind: 'paragraph' });
  });

  it('HTML cru é texto literal, nunca elemento', () => {
    const block = only('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(block).toEqual({
      kind: 'paragraph',
      inline: [{ kind: 'text', text: '<script>alert(1)</script><img src=x onerror=alert(1)>', marks: [] }],
    });
  });

  it('entrada vazia e só espaços não gera blocos', () => {
    expect(parseMarkdownBlocks('')).toEqual([]);
    expect(parseMarkdownBlocks('  \n\t\n')).toEqual([]);
  });

  it('aninhamento patológico de citação/lista é limitado sem estourar a pilha', () => {
    const deepQuote = '>'.repeat(50_000) + ' fundo';
    const blocks = parseMarkdownBlocks(deepQuote);
    let depth = 0;
    let cursor: MarkdownBlock | undefined = blocks[0];
    while (cursor?.kind === 'quote') {
      depth += 1;
      cursor = cursor.blocks[0];
    }
    expect(depth).toBeLessThanOrEqual(MARKDOWN_MAX_DEPTH);
    expect(cursor?.kind).toBe('paragraph');

    const deepList = Array.from({ length: 2_000 }, (_, i) => `${'  '.repeat(i)}- n${i}`).join('\n');
    expect(() => parseMarkdownBlocks(deepList)).not.toThrow();
  });

  it('o número de blocos é limitado', () => {
    const many = Array.from({ length: MARKDOWN_MAX_BLOCKS + 500 }, (_, i) => `p${i}`).join('\n\n');
    const blocks = parseMarkdownBlocks(many);
    expect(blocks.length).toBeLessThanOrEqual(MARKDOWN_MAX_BLOCKS);
  });

  it('entrada adversarial grande termina rápido', () => {
    const inputs = [
      '`'.repeat(MARKDOWN_MAX_CHARS),
      '['.repeat(MARKDOWN_MAX_CHARS),
      '[a]('.repeat(MARKDOWN_MAX_CHARS / 4),
      '|'.repeat(MARKDOWN_MAX_CHARS),
      '*_'.repeat(MARKDOWN_MAX_CHARS / 2),
      'https://'.repeat(MARKDOWN_MAX_CHARS / 8),
      '- '.repeat(MARKDOWN_MAX_CHARS / 2),
    ];
    const started = performance.now();
    for (const input of inputs) parseMarkdownBlocks(input);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe('parseMarkdownInline', () => {
  it('reaproveita negrito/itálico/tachado/código do parser do composer', () => {
    expect(parseMarkdownInline('**a** *b* ~~c~~ `d`')).toEqual([
      { kind: 'text', text: 'a', marks: ['bold'] },
      { kind: 'text', text: ' ', marks: [] },
      { kind: 'text', text: 'b', marks: ['italic'] },
      { kind: 'text', text: ' ', marks: [] },
      { kind: 'text', text: 'c', marks: ['strike'] },
      { kind: 'text', text: ' ', marks: [] },
      { kind: 'text', text: 'd', marks: ['code'] },
    ]);
  });

  it('link http/https vira nó de link com rótulo marcado', () => {
    expect(parseMarkdownInline('veja [o **doc**](https://example.com/a_b) agora')).toEqual([
      { kind: 'text', text: 'veja ', marks: [] },
      {
        kind: 'link',
        href: 'https://example.com/a_b',
        label: [
          { text: 'o ', marks: [] },
          { text: 'doc', marks: ['bold'] },
        ],
      },
      { kind: 'text', text: ' agora', marks: [] },
    ]);
  });

  it('autolink e URL solta, sem pontuação final', () => {
    expect(parseMarkdownInline('<https://a.test/x>')).toEqual([
      { kind: 'link', href: 'https://a.test/x', label: [{ text: 'https://a.test/x', marks: [] }] },
    ]);
    expect(parseMarkdownInline('em http://a.test/x_y_z.')).toEqual([
      { kind: 'text', text: 'em ', marks: [] },
      { kind: 'link', href: 'http://a.test/x_y_z', label: [{ text: 'http://a.test/x_y_z', marks: [] }] },
      { kind: 'text', text: '.', marks: [] },
    ]);
  });

  it('link com esquema perigoso fica como texto literal', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', 'vbscript:x', '/relativo', '#ancora']) {
      const nodes = parseMarkdownInline(`[clique](${href})`);
      expect(nodes.every((node) => node.kind === 'text')).toBe(true);
      expect(nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('')).toBe(`[clique](${href})`);
    }
  });

  it('link dentro de código inline não vira link', () => {
    expect(parseMarkdownInline('`[a](https://x.test)`')).toEqual([
      { kind: 'text', text: '[a](https://x.test)', marks: ['code'] },
    ]);
  });
});

describe('safeExternalHref', () => {
  it('só aceita http/https sem credenciais', () => {
    expect(safeExternalHref('https://a.test/x?y=1')).toBe('https://a.test/x?y=1');
    expect(safeExternalHref('http://a.test')).toBe('http://a.test/');
    expect(safeExternalHref('https://user:pw@a.test')).toBeNull();
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeExternalHref('mailto:a@b.c')).toBeNull();
    expect(safeExternalHref('nada')).toBeNull();
  });
});

describe('limitMarkdownSource', () => {
  it('corta acima do teto e avisa', () => {
    expect(limitMarkdownSource('curto')).toEqual({ text: 'curto', truncated: false });
    const long = limitMarkdownSource('x'.repeat(MARKDOWN_MAX_CHARS + 10));
    expect(long.text).toHaveLength(MARKDOWN_MAX_CHARS);
    expect(long.truncated).toBe(true);
    expect(limitMarkdownSource(undefined as unknown as string)).toEqual({ text: '', truncated: false });
  });
});
