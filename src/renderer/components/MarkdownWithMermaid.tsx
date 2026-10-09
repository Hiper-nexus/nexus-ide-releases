import { useEffect, useMemo, useRef } from 'react';
import { splitMarkdownMermaid } from '../../shared/mermaid-fences';

/**
 * Markdown + Mermaid renderizado de verdade (item T3).
 * Cada bloco ```mermaid vira SVG via `mermaid.render`; falha cai no source.
 */
export interface MarkdownWithMermaidProps {
  readonly source: string;
  readonly onMermaidReady?: (el: HTMLElement, source: string) => void;
}

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidApi: MermaidApi | null = null;
let mermaidLoading: Promise<MermaidApi | null> | null = null;

async function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidApi) return mermaidApi;
  if (!mermaidLoading) {
    mermaidLoading = import('mermaid').then((mod) => {
      const api = (mod.default ?? mod) as unknown as MermaidApi;
      if (api && typeof api.render === 'function') {
        api.initialize?.({ startOnLoad: false, securityLevel: 'strict' });
        mermaidApi = api;
        return api;
      }
      return null;
    });
  }
  return mermaidLoading;
}

function MermaidBlock({
  source,
  index,
  onReady,
}: {
  source: string;
  index: number;
  onReady?: (el: HTMLElement, source: string) => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    if (!el) return;
    void loadMermaid()
      .then(async (api) => {
        if (!api || cancelled || !ref.current) return;
        const { svg } = await api.render(`nexus-mermaid-${index}`, source);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        onReady?.(ref.current, source);
      })
      .catch(() => {
        // Render falhou: o <pre> com a fonte continua como fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [source, index, onReady]);

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
            onReady={onMermaidReady}
          />
        ),
      )}
    </div>
  );
}
