/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerRichTextEditor } from './ComposerRichTextEditor';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(node: ReactNode): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('ComposerRichTextEditor', () => {
  it('keeps the initial bold mark after a keystroke', () => {
    const published: string[] = [];
    render(
      <ComposerRichTextEditor
        value="**bold** x"
        onChange={(markdown) => published.push(markdown)}
      />,
    );
    const surface = document.querySelector<HTMLElement>('[role="textbox"]');
    const strong = surface?.querySelector('strong');
    expect(strong?.textContent).toBe('bold');
    strong!.firstChild!.textContent = 'bold!';
    act(() => {
      surface!.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    expect(published.at(-1)).toBe('**bold!** x');
  });

  it('wraps the selection in a mark element instead of literal markdown', () => {
    const published: string[] = [];
    render(
      <ComposerRichTextEditor
        value="plain"
        onChange={(markdown) => published.push(markdown)}
      />,
    );
    const surface = document.querySelector<HTMLElement>('[role="textbox"]')!;
    const text = surface.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const bold = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Negrito (**texto**)"]',
    )!;
    act(() => {
      bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(surface.querySelector('strong')?.textContent).toBe('plain');
    expect(surface.textContent).not.toContain('*');
    expect(published.at(-1)).toBe('**plain**');
  });
});
