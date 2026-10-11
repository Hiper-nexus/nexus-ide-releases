import { useMemo, type ReactNode } from 'react';
import {
  parseMarkdownBlocks,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownTableAlign,
} from '../../shared/markdown-blocks';
import type { RichTextMark } from '../../shared/rich-text-marks';
import { openExternalFromAnchor } from '../lib/open-external';

/**
 * Prosa markdown dos agentes (item T3 `ChatMarkdown`), só com elementos
 * React: nenhum HTML do texto vira elemento, nada passa por innerHTML.
 *
 * Esta é a camada de prosa. Texto de agente entra pela
 * `MarkdownWithMermaid`, que separa os blocos ```mermaid e usa esta view
 * para o resto. Usar esta direto deixa diagramas como código.
 *
 * `links`:
 * - `external` (padrão): âncora que só abre fora do app, pelo
 *   `app:openExternal` (o Main ainda valida). Só existe para http/https.
 * - `text`: rótulo e URL como texto, para superfícies que já são
 *   clicáveis (um link dentro de role=button não tem foco confiável).
 */
export type MarkdownLinkMode = 'external' | 'text';

export interface MarkdownViewProps {
  readonly markdown: string;
  readonly links?: MarkdownLinkMode;
}

function marked(text: string, marks: readonly RichTextMark[], key: string): ReactNode {
  let node: ReactNode = text;
  if (marks.includes('code')) node = <code className="markdown-view__inline-code">{node}</code>;
  if (marks.includes('italic')) node = <em>{node}</em>;
  if (marks.includes('bold')) node = <strong>{node}</strong>;
  if (marks.includes('strike')) node = <s>{node}</s>;
  return <span key={key}>{node}</span>;
}

function alignClass(align: MarkdownTableAlign | undefined): string | undefined {
  return align ? `markdown-view__cell--${align}` : undefined;
}

function Inline({ nodes, links }: { readonly nodes: readonly MarkdownInline[]; readonly links: MarkdownLinkMode }) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = String(index);
        if (node.kind === 'break') return <br key={key} />;
        if (node.kind === 'text') return marked(node.text, node.marks, key);
        const label = node.label.map((span, i) => marked(span.text, span.marks, `${key}.${i}`));
        const labelText = node.label.map((span) => span.text).join('');
        if (links === 'text') {
          return (
            <span key={key} className="markdown-view__link-text">
              {label}
              {labelText !== node.href ? <span className="markdown-view__link-url"> ({node.href})</span> : null}
            </span>
          );
        }
        return (
          <a
            key={key}
            className="markdown-view__link"
            href={node.href}
            title={node.href}
            rel="noreferrer noopener"
            onClick={(event) => openExternalFromAnchor(event, node.href)}
          >
            {label}
          </a>
        );
      })}
    </>
  );
}

function Blocks({ blocks, links }: { readonly blocks: readonly MarkdownBlock[]; readonly links: MarkdownLinkMode }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${block.level}` as const;
            return (
              <Tag key={index} className={`markdown-view__heading markdown-view__heading--${block.level}`}>
                <Inline nodes={block.inline} links={links} />
              </Tag>
            );
          }
          case 'paragraph':
            return (
              <p key={index} className="markdown-view__paragraph">
                <Inline nodes={block.inline} links={links} />
              </p>
            );
          case 'code':
            return (
              <pre key={index} className="markdown-view__code" data-language={block.language || undefined}>
                <code className={block.language ? `language-${block.language}` : undefined}>{block.text}</code>
              </pre>
            );
          case 'quote':
            return (
              <blockquote key={index} className="markdown-view__quote">
                <Blocks blocks={block.blocks} links={links} />
              </blockquote>
            );
          case 'list': {
            const items = block.items.map((item, i) => (
              <li key={i}>
                <Blocks blocks={item} links={links} />
              </li>
            ));
            return block.ordered ? (
              <ol key={index} className="markdown-view__list" start={block.start === 1 ? undefined : block.start}>
                {items}
              </ol>
            ) : (
              <ul key={index} className="markdown-view__list">{items}</ul>
            );
          }
          case 'table':
            return (
              <div key={index} className="markdown-view__table-wrap">
                <table className="markdown-view__table">
                  <thead>
                    <tr>
                      {block.header.map((cell, i) => (
                        <th key={i} scope="col" className={alignClass(block.align[i])}>
                          <Inline nodes={cell} links={links} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, i) => (
                          <td key={i} className={alignClass(block.align[i])}>
                            <Inline nodes={cell} links={links} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return <hr key={index} className="markdown-view__rule" />;
        }
      })}
    </>
  );
}

export function MarkdownView({ markdown, links = 'external' }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  return (
    <div className="markdown-view">
      <Blocks blocks={blocks} links={links} />
    </div>
  );
}
