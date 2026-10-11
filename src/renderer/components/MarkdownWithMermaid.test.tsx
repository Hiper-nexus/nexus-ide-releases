/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: api }));
import { MARKDOWN_MAX_DIAGRAMS, MarkdownWithMermaid } from './MarkdownWithMermaid';
import { MARKDOWN_MAX_CHARS } from '../../shared/markdown-blocks';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const pending: Array<() => void> = [];
const SOURCE = '```mermaid\ngraph TD; A-->B\n```';
const svg = (id: string) => `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><text>diagram</text></svg>`;
function render(node: ReactNode) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root); act(() => root.render(node));
  return { host, root };
}
async function settle() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function output(host: HTMLElement): SVGElement | null {
  return host.querySelector('[data-mermaid-rendered]')?.shadowRoot?.querySelector('svg') ?? host.querySelector('svg');
}
beforeEach(() => {
  api.initialize.mockClear();
  api.render.mockReset().mockImplementation(async (id: string) => ({ svg: svg(id) }));
});
afterEach(async () => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const resolve of pending.splice(0)) resolve();
  await settle(); document.body.replaceChildren();
});

describe('MarkdownWithMermaid real async consumer / real sanitizer', () => {
  it('keeps plaintext unescaped as a fallback, including failure', async () => {
    api.render.mockRejectedValue(new Error('syntax'));
    const ready = vi.fn(); const { host } = render(<MarkdownWithMermaid source={SOURCE} onMermaidReady={ready} />);
    expect(host.querySelector('code')?.textContent).toBe('graph TD; A-->B');
    await settle();
    expect(host.querySelector('code')?.textContent).toBe('graph TD; A-->B');
    expect(ready).not.toHaveBeenCalled();
  });
  it('F-1068: readiness follows sanitized SVG commit and caption survives', async () => {
    const ready = vi.fn((el: HTMLElement) => {
      expect(output(el)).not.toBeNull();
      expect(el.querySelector('code')).toBeNull();
    });
    const { host } = render(<MarkdownWithMermaid source={SOURCE} onMermaidReady={ready} />);
    expect(ready).not.toHaveBeenCalled(); await settle();
    expect(ready).toHaveBeenCalledOnce();
    expect(host.querySelector('figcaption')?.textContent).toBe('Diagrama Mermaid');
  });
  it('F-1068: a parent callback replacement does not rerender an unchanged source', async () => {
    const first = vi.fn(); const next = vi.fn();
    const { root } = render(<MarkdownWithMermaid source={SOURCE} onMermaidReady={first} />);
    await settle(); expect(first).toHaveBeenCalledOnce();
    act(() => root.render(<MarkdownWithMermaid source={SOURCE} onMermaidReady={next} />)); await settle();
    expect(api.render).toHaveBeenCalledOnce();
    act(() => root.render(<MarkdownWithMermaid source={'```mermaid\ngraph LR; X-->Y\n```'} onMermaidReady={next} />));
    await settle(); expect(next).toHaveBeenCalledOnce(); expect(first).toHaveBeenCalledOnce();
  });
  it('F-1068: config/render is serial and diagram IDs are globally unique across instances', async () => {
    let release!: () => void;
    api.render.mockImplementationOnce((id: string) => new Promise((resolve) => { release = () => resolve({ svg: svg(id) }); pending.push(release); }));
    render(<><MarkdownWithMermaid source={SOURCE} /><MarkdownWithMermaid source={SOURCE} /></>);
    await settle(); expect(api.render).toHaveBeenCalledTimes(1);
    release(); await settle(); expect(api.render).toHaveBeenCalledTimes(2);
    expect(api.render.mock.calls[0]?.[0]).not.toBe(api.render.mock.calls[1]?.[0]);
  });
  it('F-1068: unmount cancels late output and readiness', async () => {
    let release!: () => void;
    api.render.mockImplementationOnce((id: string) => new Promise((resolve) => { release = () => resolve({ svg: svg(id) }); pending.push(release); }));
    const ready = vi.fn(); const { root, host } = render(<MarkdownWithMermaid source={SOURCE} onMermaidReady={ready} />);
    await settle(); act(() => root.unmount()); roots.splice(roots.indexOf(root), 1);
    release(); await settle(); expect(ready).not.toHaveBeenCalled(); expect(output(host)).toBeNull();
  });
  it('F-1068: failure cleans Mermaid temporary elements', async () => {
    api.render.mockImplementationOnce(async (id: string) => {
      const temp = document.createElement('div'); temp.id = `d${id}`; document.body.appendChild(temp); throw new Error('bad diagram');
    });
    render(<MarkdownWithMermaid source={SOURCE} />); await settle();
    expect(document.querySelector('[id^="dnexus-mermaid-"]')).toBeNull();
  });
  it('F-1068: directives cannot relax security/html labels/CSS and theme is reapplied per render', async () => {
    const source = '```mermaid\n%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"body{}"}}%%\ngraph TD; A-->B\n```';
    const { root } = render(<MarkdownWithMermaid source={source} theme="light" />);
    await settle();
    expect(api.initialize.mock.calls.at(-1)?.[0]).toMatchObject({ securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, theme: 'default' });
    expect(api.initialize.mock.calls.at(-1)?.[0].secure).toEqual(expect.arrayContaining(['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS']));
    act(() => root.render(<MarkdownWithMermaid source={source} theme="dark" />)); await settle();
    expect(api.initialize.mock.calls.at(-1)?.[0].theme).toBe('dark');
  });
  it('F-1068: real DOMPurify strips script, foreign content, events, navigation/media and remote CSS URLs', async () => {
    api.render.mockResolvedValueOnce({ svg: `<svg xmlns="http://www.w3.org/2000/svg" onload="evil()">
      <script>evil()</script><foreignObject><div><img src="https://evil.test/x" onerror="evil()" /></div></foreignObject>
      <a href="https://evil.test"><text>link</text></a><image href="https://evil.test/x" />
      <style>@import "https://evil.test/style"; rect { fill:url(https://evil.test/x); filter:url(#local); }</style>
      <defs><filter id="local" /></defs><rect fill="url(https://evil.test/x)" style="stroke:url(https://evil.test/y);filter:url(#local)" onclick="evil()" />
      </svg>` });
    const { host } = render(<MarkdownWithMermaid source={SOURCE} />); await settle();
    const rendered = output(host)!; expect(rendered).not.toBeNull();
    expect(rendered.querySelector('script,foreignObject,img,image,a')).toBeNull();
    expect(rendered.outerHTML).not.toMatch(/evil\.test|onload|onclick|onerror/);
    expect(rendered.outerHTML).toContain('url(#local)');
  });
  it('F-1169: prose around the diagram is formatted markdown, not raw <pre>', async () => {
    const source = '## Plano\n\n- **um**\n- dois\n\n' + SOURCE + '\n\nFim com `código`.';
    const { host } = render(<MarkdownWithMermaid source={source} className="extra" id="md" />); await settle();
    const root = host.querySelector('#md')!;
    expect(root.className).toBe('markdown-with-mermaid extra');
    expect(root.querySelector('h2')?.textContent).toBe('Plano');
    expect(root.querySelector('ul li strong')?.textContent).toBe('um');
    expect(root.querySelector('figure.markdown-with-mermaid__diagram')).not.toBeNull();
    expect(output(host)).not.toBeNull();
    expect(root.querySelector('p code')?.textContent).toBe('código');
    expect(root.querySelector('pre.markdown-with-mermaid__text')).toBeNull();
  });
  it('F-1169: raw HTML in prose stays literal text', async () => {
    const { host } = render(<MarkdownWithMermaid source={'<img src=x onerror=alert(1)><script>alert(2)</script>'} />); await settle();
    expect(host.querySelector('img,script')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('F-1169: caps diagrams and oversized text', async () => {
    const many = Array.from({ length: MARKDOWN_MAX_DIAGRAMS + 2 }, (_, i) => `\`\`\`mermaid\ngraph TD; N${i}-->M\n\`\`\``).join('\n\n');
    const { host } = render(<MarkdownWithMermaid source={many} />); await settle();
    expect(host.querySelectorAll('figure')).toHaveLength(MARKDOWN_MAX_DIAGRAMS);
    expect(host.querySelectorAll('pre > code.language-mermaid')).toHaveLength(2);
    expect(api.render).toHaveBeenCalledTimes(MARKDOWN_MAX_DIAGRAMS);
    const big = render(<MarkdownWithMermaid source={'a'.repeat(MARKDOWN_MAX_CHARS + 5)} />);
    expect(big.host.querySelector('[role="note"]')?.textContent).toMatch(/Texto longo/);
    expect(big.host.querySelector('p')?.textContent).toHaveLength(MARKDOWN_MAX_CHARS);
  });
});
