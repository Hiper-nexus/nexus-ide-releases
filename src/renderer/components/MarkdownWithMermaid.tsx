import { useEffect, useMemo, useRef } from 'react';
import { splitMarkdownMermaid } from '../../shared/mermaid-fences';

/**
 * Markdown + Mermaid (item T3). Renderiza prosa como texto pré-formatado e
 * cada bloco ```mermaid como `<figure data-mermaid>` com a fonte canônica —
 * pronta para o renderizador Mermaid (lazy) ou inspeção. Nenhum HTML cru do
 * markdown é injetado. O texto do diagrama vai como filho React: o runtime
 * já escapa, e escapar de novo mostraria `&gt;` na tela.
 */
export interface MarkdownWithMermaidProps {
  readonly source: string;
  readonly onMermaidReady?: (el: HTMLElement, source: string) => void;
}

function MermaidBlock({
  source,
  index,
  onMermaidReady,
}: {
  readonly source: string;
  readonly index: number;
  readonly onMermaidReady?: (el: HTMLElement, source: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && onMermaidReady) onMermaidReady(el, source);
  }, [source, onMermaidReady]);
  return (
    <figure
      ref={ref}
      className="markdown-with-mermaid__diagram"
      data-mermaid={index}
    >
      <figcaption className="markdown-with-mermaid__caption">
        Diagrama Mermaid
      </figcaption>
      <pre className="markdown-with-mermaid__source">
        <code>{source}</code>
      </pre>
    </figure>
  );
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
          <MermaidBlock
            key={`m${part.index}`}
            source={part.source}
            index={part.index}
            onMermaidReady={onMermaidReady}
          />
        ),
      )}
    </div>
  );
}
