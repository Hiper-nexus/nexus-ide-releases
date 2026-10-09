import { useEffect, useId, useMemo, useRef } from 'react';
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

function mountMermaidSvg(host: HTMLElement, svg: string): boolean {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    root.localName !== 'svg' ||
    parsed.querySelector('parsererror')
  ) {
    return false;
  }
  host.replaceChildren(host.ownerDocument.importNode(root, true));
  return true;
}

function mermaidRenderId(instanceId: string, index: number): string {
  const safe = instanceId.replace(/[^A-Za-z0-9]/g, '') || 'diagram';
  return `nexus-mermaid-${safe}-${index}`;
}

function MermaidBlock({
  source,
  index,
  instanceId,
  onReady,
}: {
  source: string;
  index: number;
  instanceId: string;
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
        const { svg } = await api.render(
          mermaidRenderId(instanceId, index),
          source,
        );
        if (cancelled || !ref.current) return;
        if (!mountMermaidSvg(ref.current, svg)) return;
        onReady?.(ref.current, source);
      })
      .catch(() => {
        // Render falhou: o <pre> com a fonte continua como fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [source, index, instanceId, onReady]);

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
  const instanceId = useId();
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
            instanceId={instanceId}
            onReady={onMermaidReady}
          />
        ),
      )}
    </div>
  );
}
