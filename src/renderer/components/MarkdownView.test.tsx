/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownView } from './MarkdownView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
});

const SAMPLE = [
  '## Resumo',
  '',
  'Feito com **cuidado** e *calma*, sem ~~atalho~~; veja `npm test`.',
  'Segunda linha.',
  '',
  '1. primeiro',
  '2. segundo',
  '   - detalhe',
  '',
  '> citação',
  '',
  '```ts',
  'const x = "<b>";',
  '```',
  '',
  '| Arquivo | Linhas |',
  '|---|--:|',
  '| a.ts | 10 |',
  '',
  '---',
].join('\n');

describe('MarkdownView', () => {
  it('monta títulos, marcas, quebras, listas aninhadas, citação, código e tabela com elementos reais', () => {
    const host = render(<MarkdownView markdown={SAMPLE} />);
    expect(host.querySelector('h2')?.textContent).toBe('Resumo');
    const paragraph = host.querySelector('p.markdown-view__paragraph')!;
    expect(paragraph.querySelector('strong')?.textContent).toBe('cuidado');
    expect(paragraph.querySelector('em')?.textContent).toBe('calma');
    expect(paragraph.querySelector('s')?.textContent).toBe('atalho');
    expect(paragraph.querySelector('code')?.textContent).toBe('npm test');
    expect(paragraph.querySelector('br')).not.toBeNull();
    expect(host.querySelectorAll('ol > li')).toHaveLength(2);
    expect(host.querySelector('ol > li ul > li')?.textContent).toBe('detalhe');
    expect(host.querySelector('blockquote')?.textContent).toBe('citação');
    const code = host.querySelector('pre.markdown-view__code > code');
    expect(code?.className).toBe('language-ts');
    expect(code?.textContent).toBe('const x = "<b>";');
    expect(host.querySelector('pre b')).toBeNull();
    expect(host.querySelector('th')?.textContent).toBe('Arquivo');
    expect(host.querySelector('td.markdown-view__cell--right')?.textContent).toBe('10');
    expect(host.querySelector('hr')).not.toBeNull();
  });

  it('HTML cru do agente aparece como texto e não vira elemento', () => {
    const evil = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2"><a href="javascript:alert(1)">x</a>';
    const host = render(<MarkdownView markdown={evil} />);
    expect(host.querySelector('script, img, iframe')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toBe(evil);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('link http/https abre fora do app pelo helper seguro; esquema perigoso fica texto', () => {
    const openExternal = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, 'nexus', { configurable: true, value: { app: { openExternal } } });
    const host = render(<MarkdownView markdown={'[docs](https://example.com/x) e [mau](javascript:alert(1))'} />);
    const anchors = host.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('href')).toBe('https://example.com/x');
    expect(anchors[0]!.getAttribute('rel')).toBe('noreferrer noopener');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { anchors[0]!.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x');
    expect(host.textContent).toContain('[mau](javascript:alert(1))');
  });

  it('modo de links "text" mostra rótulo e URL sem âncora', () => {
    const host = render(<MarkdownView markdown={'[docs](https://example.com/x) e https://a.test/y'} links="text" />);
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toBe('docs (https://example.com/x) e https://a.test/y');
  });
});
