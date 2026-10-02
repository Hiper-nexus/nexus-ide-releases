import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { collectBrowserVisualMasks } from './browser-visual-redaction';
import type { BrowserVisualRect } from '../shared/browser-visual';

type Collectable = Parameters<typeof collectBrowserVisualMasks>[0];

/** jsdom has no layout: `data-rect="x,y,w,h"` stands in for getBoundingClientRect. */
function page(html: string, size = { width: 1000, height: 800 }): { win: Collectable; dom: JSDOM } {
  const dom = new JSDOM(`<body>${html}</body>`);
  const win = dom.window as unknown as Collectable;
  Object.defineProperty(win, 'innerWidth', { value: size.width }); Object.defineProperty(win, 'innerHeight', { value: size.height });
  for (const element of dom.window.document.querySelectorAll<HTMLElement>('[data-rect]')) {
    const [x, y, width, height] = element.dataset.rect!.split(',').map(Number);
    element.getBoundingClientRect = () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height } as DOMRect);
  }
  return { win, dom };
}
const rects = (win: Collectable): BrowserVisualRect[] => collectBrowserVisualMasks(win).rectangles;

describe('isolated visual mask collection', () => {
  it('masks text fields, sensitive labels, nested shadow inputs and opaque frames without returning values', () => {
    const dom = new JSDOM('<input type="password" value="private-pass"><textarea>private-token</textarea><iframe></iframe><div data-api-token>private-key</div><section></section>');
    const shadow = dom.window.document.querySelector('section')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input value="shadow-private-key">';
    const nodes = [...dom.window.document.querySelectorAll('input,textarea,iframe,div'), shadow.querySelector('input')!];
    for (const element of nodes) element.getBoundingClientRect = () => ({ x: 10, y: 20, width: 60, height: 25 } as DOMRect);
    const masks = collectBrowserVisualMasks(dom.window as unknown as Window & typeof globalThis);
    expect(masks.rectangles.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(masks)).not.toContain('private-');
  });

  it('hides the value next to a sensitive label in a table row, definition list or paired blocks', () => {
    const { win } = page(`
      <table><tr data-rect="0,100,600,30"><td data-rect="0,100,200,30">API key</td><td data-rect="200,100,400,30">abc-not-a-pattern</td></tr></table>
      <dl data-rect="0,200,600,60"><dt data-rect="0,200,200,30">Webhook secret</dt><dd data-rect="200,200,400,30">opaque-value</dd></dl>
      <div data-rect="0,300,600,40"><div data-rect="0,300,200,40">Senha</div><div data-rect="200,300,400,40">opaque-value</div></div>
      <div data-rect="0,400,600,40"><div data-rect="0,400,200,40">Token de acesso</div><div data-rect="200,400,400,40">opaque-value</div></div>
    `);
    const found = rects(win);
    expect(found).toContainEqual({ x: 0, y: 100, width: 600, height: 30 });
    expect(found).toContainEqual({ x: 0, y: 200, width: 600, height: 60 });
    expect(found).toContainEqual({ x: 0, y: 400, width: 600, height: 40 });
  });

  it('hides tokens that the text redactor does not know, anywhere in a node', () => {
    const tokens = ['sk_live_51HabcdefghijKLMNOPQRstuv', 'whsec_8b1fabcdefghijklmnopqrstuvwxyz12', 'xoxb-1234567890-abcdefghijkl',
      'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'];
    const { win } = page(tokens.map((token, index) => `<p data-rect="0,${index * 50},500,20">Chave: ${token}</p>`).join(''));
    expect(rects(win)).toHaveLength(tokens.length);
  });

  it('masks sensitive text that sits directly under a shadow root through its host', () => {
    const { win, dom } = page('<div id="host" data-rect="10,20,300,40"></div>');
    const shadow = dom.window.document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.append(dom.window.document.createTextNode('Chave: sk_live_51HabcdefghijKLMNOPQRstuv'));
    expect(rects(win)).toEqual([{ x: 10, y: 20, width: 300, height: 40 }]);
  });

  it('leaves ordinary non-sensitive text visible (negative case)', () => {
    const { win } = page('<p data-rect="0,0,300,20">Pedido confirmado</p><h1 data-rect="0,40,300,30">Obrigado pela compra</h1>');
    expect(rects(win)).toEqual([]);
  });

  it('masks large images, svg, video and canvas once each but not small icons', () => {
    const { win } = page(`
      <img data-rect="0,0,400,300"><img data-rect="0,320,16,16">
      <svg data-rect="0,400,200,200"><path data-rect="10,410,5,5"></path><path data-rect="20,410,5,5"></path><text>chart</text></svg>
      <video data-rect="500,0,320,240"></video><canvas data-rect="500,300,320,240"></canvas>`);
    const found = rects(win);
    expect(found).toHaveLength(4);
    expect(found).not.toContainEqual({ x: 0, y: 320, width: 16, height: 16 });
  });

  it('never lets rendered-nowhere text (script, style) widen the mask', () => {
    const { win } = page('<div data-rect="0,0,800,600"><script>const k = "sk_live_51HabcdefghijKLMNOPQRstuv";</script><style>.token{}</style><p data-rect="0,0,100,20">ok</p></div>');
    expect(rects(win)).toEqual([]);
  });

  it('falls back to the text rectangles when the block would hide most of the viewport', () => {
    const dom = new JSDOM('<body><div data-rect="0,0,1000,800">Chave: sk_live_51HabcdefghijKLMNOPQRstuv e muito mais texto</div></body>');
    const win = dom.window as unknown as Collectable;
    Object.defineProperty(win, 'innerWidth', { value: 1000 }); Object.defineProperty(win, 'innerHeight', { value: 800 });
    const block = dom.window.document.querySelector<HTMLElement>('[data-rect]')!;
    block.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1000, height: 800 } as DOMRect);
    (dom.window.Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [{ x: 5, y: 6, width: 200, height: 18 } as DOMRect];
    expect(rects(win)).toEqual([{ x: 5, y: 6, width: 200, height: 18 }]);
  });
});
