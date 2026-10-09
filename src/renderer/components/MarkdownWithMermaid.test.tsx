/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
function render(node: ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return { host, root };
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const SOURCE = ['```mermaid', 'graph TD; A-->B', '```'].join('\n');

describe('MarkdownWithMermaid', () => {
  it('renders the diagram source as text, without a second escape', () => {
    const { host } = render(<MarkdownWithMermaid source={SOURCE} />);
    const code = host.querySelector('code');
    expect(code?.textContent).toBe('graph TD; A-->B');
    expect(code?.textContent).not.toContain('&gt;');
  });

  it('calls onMermaidReady once per source, not on every parent render', () => {
    const onMermaidReady = vi.fn();
    const { root } = render(
      <MarkdownWithMermaid source={SOURCE} onMermaidReady={onMermaidReady} />,
    );
    expect(onMermaidReady).toHaveBeenCalledTimes(1);
    expect(onMermaidReady.mock.calls[0]?.[1]).toBe('graph TD; A-->B');
    act(() =>
      root.render(
        <MarkdownWithMermaid source={SOURCE} onMermaidReady={onMermaidReady} />,
      ),
    );
    expect(onMermaidReady).toHaveBeenCalledTimes(1);
    const next = ['```mermaid', 'graph LR; X-->Y', '```'].join('\n');
    act(() =>
      root.render(
        <MarkdownWithMermaid source={next} onMermaidReady={onMermaidReady} />,
      ),
    );
    expect(onMermaidReady).toHaveBeenCalledTimes(2);
    expect(onMermaidReady.mock.calls[1]?.[1]).toBe('graph LR; X-->Y');
  });
});
