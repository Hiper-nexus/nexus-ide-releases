/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';

const mermaidPending = vi.hoisted(() => ({
  resolvers: [] as Array<(value: { svg: string }) => void>,
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: () =>
      new Promise<{ svg: string }>((resolve) => {
        mermaidPending.resolvers.push(resolve);
      }),
  },
}));

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
  for (const resolve of mermaidPending.resolvers.splice(0)) {
    resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
  }
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

  async function finishMermaid(): Promise<void> {
    const before = mermaidPending.resolvers.length;
    for (
      let attempt = 0;
      attempt < 8 && mermaidPending.resolvers.length === before;
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    await act(async () => {
      const batch = mermaidPending.resolvers.splice(before);
      for (const resolve of batch) {
        resolve({
          svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        });
      }
      await Promise.resolve();
    });
  }

  it('calls onMermaidReady once per source, not on every parent render', async () => {
    const onMermaidReady = vi.fn();
    const { root } = render(
      <MarkdownWithMermaid source={SOURCE} onMermaidReady={onMermaidReady} />,
    );
    await finishMermaid();
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
    await finishMermaid();
    expect(onMermaidReady).toHaveBeenCalledTimes(2);
    expect(onMermaidReady.mock.calls[1]?.[1]).toBe('graph LR; X-->Y');
  });
});
