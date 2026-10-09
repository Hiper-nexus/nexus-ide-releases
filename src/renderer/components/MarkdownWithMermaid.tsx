import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { splitMarkdownMermaid } from '../../shared/mermaid-fences';

export interface MarkdownWithMermaidProps {
  readonly source: string;
  readonly theme?: 'light' | 'dark';
  /** Called after a fresh sanitized source/theme result is committed. */
  readonly onMermaidReady?: (el: HTMLElement, source: string) => void;
}
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};
let mermaidLoading: Promise<MermaidApi> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;
let purifier: ReturnType<typeof DOMPurify> | null = null;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function loadMermaid(): Promise<MermaidApi> {
  mermaidLoading ??= import('mermaid').then((module) => {
    const api = (module.default ?? module) as unknown as MermaidApi;
    if (typeof api.initialize !== 'function' || typeof api.render !== 'function') {
      throw new Error('Mermaid renderer unavailable');
    }
    return api;
  }).catch((error: unknown) => { mermaidLoading = null; throw error; });
  return mermaidLoading;
}

/** CSS can paint locally, but cannot load assets or smuggle escaped URL functions. */
function localCss(css: string): string {
  if (/\\|@(?:import|font-face)|image-set\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(css)) return '';
  return css.replace(/url\s*\(\s*([^)]*)\)/gi, (_match, raw: string) => {
    const reference = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    return /^#[A-Za-z_][\w.:-]*$/.test(reference) ? `url(${reference})` : 'none';
  });
}

function sanitizedSvg(svg: string): SVGElement {
  if (svg.length > 2_000_000) throw new Error('Mermaid SVG exceeds display budget');
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook('uponSanitizeElement', (node, data) => {
      if (data.tagName === 'style' && node.textContent) node.textContent = localCss(node.textContent);
    });
    purifier.addHook('uponSanitizeAttribute', (_node, data) => {
      if (['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'cursor'].includes(data.attrName)) {
        data.attrValue = localCss(data.attrValue);
      }
    });
  }
  const fragment = purifier.sanitize(svg, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction'],
    FORBID_TAGS: ['a', 'img', 'image', 'feImage', 'script', 'foreignObject', 'iframe', 'animate', 'animateMotion', 'animateTransform', 'set'],
  });
  const element = fragment.querySelector('svg');
  if (!element || element.namespaceURI !== SVG_NAMESPACE) throw new Error('Mermaid returned no SVG');
  return element;
}

function MermaidBlock({ source, index, theme, onReady }: {
  source: string; index: number; theme: 'light' | 'dark';
  onReady?: (el: HTMLElement, source: string) => void;
}) {
  const figure = useRef<HTMLElement | null>(null);
  const target = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onReady);
  callback.current = onReady;
  const [ready, setReady] = useState<{ id: string; source: string; theme: string } | null>(null);
  const current = ready?.source === source && ready.theme === theme;

  useEffect(() => {
    let cancelled = false;
    const host = target.current;
    if (!host) return;
    setReady(null);
    host.shadowRoot?.replaceChildren();
    // Mermaid initializes shared global config while rendering; serialize both.
    const task = renderQueue.then(async () => {
      if (cancelled) return;
      const api = await loadMermaid();
      if (cancelled) return;
      const id = `nexus-mermaid-${nextDiagramId++}`;
      try {
        api.initialize({
          startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS'],
          htmlLabels: false, flowchart: { htmlLabels: false }, themeCSS: '',
          maxTextSize: 50_000, maxEdges: 500,
          theme: theme === 'dark' ? 'dark' : 'default',
          fontFamily: getComputedStyle(document.body).fontFamily,
        });
        const result = await api.render(id, source);
        if (cancelled) return;
        const node = sanitizedSvg(result.svg);
        // Shadow scope also keeps diagram stylesheet selectors out of app chrome.
        const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
        root.replaceChildren(node);
        setReady({ id, source, theme });
      } finally {
        document.getElementById(`d${id}`)?.remove();
      }
    });
    renderQueue = task.catch(() => undefined);
    void task.catch(() => { if (!cancelled) setReady(null); });
    return () => { cancelled = true; host.shadowRoot?.replaceChildren(); };
  }, [source, theme]);

  useLayoutEffect(() => {
    if (current && figure.current) callback.current?.(figure.current, source);
  }, [ready, current, source]);

  return (
    <figure ref={figure} className="markdown-with-mermaid__diagram" data-mermaid={index}>
      <figcaption className="markdown-with-mermaid__caption">Diagrama Mermaid</figcaption>
      <div ref={target} data-mermaid-rendered hidden={!current} />
      {!current ? <pre className="markdown-with-mermaid__source"><code>{source}</code></pre> : null}
    </figure>
  );
}

export function MarkdownWithMermaid({ source, theme, onMermaidReady }: MarkdownWithMermaidProps) {
  const parts = useMemo(() => splitMarkdownMermaid(source), [source]);
  const displayTheme = theme ?? (document.documentElement.dataset.theme?.includes('light') ? 'light' : 'dark');
  return (
    <div className="markdown-with-mermaid">
      {parts.map((part, i) => part.kind === 'text'
        ? <pre key={`t${i}`} className="markdown-with-mermaid__text">{part.text}</pre>
        : <MermaidBlock key={`m${part.index}`} source={part.source} index={part.index} theme={displayTheme} onReady={onMermaidReady} />)}
    </div>
  );
}
