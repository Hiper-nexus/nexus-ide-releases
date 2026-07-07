/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAxTree } from './ax-tree';

const realDocument = globalThis.document;

afterEach(() => {
  vi.unstubAllGlobals();
  realDocument.body.innerHTML = '';
});

describe('getAxTree', () => {
  it('returns empty tree when document.body is null', () => {
    vi.stubGlobal('document', { body: null });

    const tree = getAxTree();
    expect(tree.tag).toBe('html');
    expect(tree.children).toHaveLength(0);
  });

  it('reads the active renderer DOM into an AX-like tree', () => {
    document.body.innerHTML = `
      <main>
        <button aria-label="Run mission">Start</button>
        <section role="status" aria-live="polite">Ready</section>
      </main>
    `;

    const tree = getAxTree();
    expect(tree.tag).toBe('body');
    expect(tree.children).toHaveLength(1);

    const main = tree.children[0];
    expect(main.tag).toBe('main');
    expect(main.children[0]).toMatchObject({
      tag: 'button',
      role: null,
      aria: { label: 'Run mission' },
      text: 'Start',
    });
    expect(main.children[1]).toMatchObject({
      tag: 'section',
      role: 'status',
      aria: { live: 'polite' },
      text: 'Ready',
    });
  });

  it('skips CSS-hidden and aria-hidden elements', () => {
    document.body.innerHTML = `
      <div>visible</div>
      <div style="display: none">hidden display</div>
      <div aria-hidden="true">hidden aria</div>
    `;

    const tree = getAxTree();
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].text).toBe('visible');
  });

  it('skips script and style tags', () => {
    document.body.innerHTML = `
      <p>text</p>
      <script>window.bad = true</script>
      <style>body { color: red; }</style>
    `;

    const tree = getAxTree();
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].tag).toBe('p');
  });
});
