/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { getAxTree } from './ax-tree';

describe('getAxTree', () => {
  it('returns empty tree when document.body is null', () => {
    // Simulate no body
    const originalBody = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    );
    const fakeDoc = { body: null };
    Object.defineProperty(globalThis, 'document', {
      value: fakeDoc,
      writable: true,
      configurable: true,
    });

    const tree = getAxTree();
    expect(tree.tag).toBe('html');
    expect(tree.children).toHaveLength(0);

    // Restore
    if (originalBody) {
      Object.defineProperty(globalThis, 'document', originalBody);
    }
  });

  it('extracts nodes from a simple DOM tree', () => {
    // Build a synthetic DOM
    const body = document.createElement('body');
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    div.setAttribute('aria-label', 'Click me');
    div.textContent = 'Hello';
    body.appendChild(div);

    const span = document.createElement('span');
    span.textContent = 'World';
    body.appendChild(span);

    // Replace document.body
    const originalBody = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    );
    const fakeDoc = { body };
    Object.defineProperty(globalThis, 'document', {
      value: fakeDoc,
      writable: true,
      configurable: true,
    });

    const tree = getAxTree();
    expect(tree.tag).toBe('body');
    expect(tree.children).toHaveLength(2);

    const divNode = tree.children[0];
    expect(divNode.tag).toBe('div');
    expect(divNode.role).toBe('button');
    expect(divNode.aria.label).toBe('Click me');
    expect(divNode.text).toBe('Hello');

    const spanNode = tree.children[1];
    expect(spanNode.tag).toBe('span');
    expect(spanNode.text).toBe('World');

    // Restore
    if (originalBody) {
      Object.defineProperty(globalThis, 'document', originalBody);
    }
  });

  it('skips hidden elements', () => {
    const body = document.createElement('body');
    const visible = document.createElement('div');
    visible.textContent = 'visible';
    body.appendChild(visible);

    const hidden = document.createElement('div');
    hidden.textContent = 'hidden';
    hidden.style.display = 'none';
    body.appendChild(hidden);

    const originalBody = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    );
    const fakeDoc = { body };
    Object.defineProperty(globalThis, 'document', {
      value: fakeDoc,
      writable: true,
      configurable: true,
    });

    const tree = getAxTree();
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].text).toBe('visible');

    if (originalBody) {
      Object.defineProperty(globalThis, 'document', originalBody);
    }
  });

  it('skips script and style tags', () => {
    const body = document.createElement('body');
    const p = document.createElement('p');
    p.textContent = 'text';
    body.appendChild(p);

    const script = document.createElement('script');
    body.appendChild(script);

    const style = document.createElement('style');
    body.appendChild(style);

    const originalBody = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    );
    const fakeDoc = { body };
    Object.defineProperty(globalThis, 'document', {
      value: fakeDoc,
      writable: true,
      configurable: true,
    });

    const tree = getAxTree();
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].tag).toBe('p');

    if (originalBody) {
      Object.defineProperty(globalThis, 'document', originalBody);
    }
  });
});