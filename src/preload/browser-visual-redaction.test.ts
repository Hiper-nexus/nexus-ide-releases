import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { collectBrowserVisualMasks } from './browser-visual-redaction';

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
});
