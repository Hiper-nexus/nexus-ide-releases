import { useMemo } from 'react';
import {
  escapeMermaidSource,
  splitMarkdownMermaid,
} from '../../shared/mermaid-fences';

/**
 * Markdown + Mermaid (item T3). Renderiza prosa como texto pré-formatado e
 * cada bloco ```mermaid como `<figure data-mermaid>` com a fonte canônica —
 * pronta para o renderizador Mermaid (lazy) ou inspeção. Nenhum HTML cru do
 * markdown é injetado.
 */
export interface MarkdownWithMermaidProps {
  readonly source: string;
  readonly onMermaidReady?: (el: HTMLElement, source: string) => void;
}

export function MarkdownWithMermaid({ source, onMermaidReady }: MarkdownWithMermaidProps) {
  const parts = useMemo(() => splitMarkdownMermaid(source), [source]);
  return (
    <div className="markdown-with-mermaid">
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <pre key={`t${i}`} className="markdown-with-mermaid__text">
            {part.text}
          </pre>
        ) : (
          <figure
            key={`m${part.index}`}
            className="markdown-with-mermaid__diagram"
            data-mermaid={part.index}
            ref={(el) => {
              if (el && onMermaidReady) onMermaidReady(el, part.source);
            }}
          >
            <figcaption className="markdown-with-mermaid__caption">
              Diagrama Mermaid
            </figcaption>
            <pre className="markdown-with-mermaid__source">
              <code>{escapeMermaidSource(part.source)}</code>
            </pre>
          </figure>
        ),
      )}
    </div>
  );
}
