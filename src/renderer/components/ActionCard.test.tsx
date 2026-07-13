/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionCard, EmptyState } from './ActionCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('ActionCard + EmptyState', () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders title and fires click on ActionCard', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onClick = vi.fn();
    act(() => {
      root.render(
        <ActionCard
          icon="key"
          title="Abrir Providers"
          subtitle="chaves"
          onClick={onClick}
        />,
      );
    });
    const btn = host.querySelector('button');
    expect(btn?.textContent).toContain('Abrir Providers');
    expect(btn?.textContent).toContain('chaves');
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('EmptyState omits action slot when none provided', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <EmptyState title="Vazio" body={<p>sem ação</p>} />,
      );
    });
    expect(host.querySelector('.empty-state__title')?.textContent).toBe('Vazio');
    expect(host.querySelector('.empty-state__action')).toBeNull();
  });

  it('EmptyState renders action children', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <EmptyState
          title="Vazio"
          action={<ActionCard title="Go" onClick={() => {}} />}
        />,
      );
    });
    expect(host.querySelector('.empty-state__action')?.textContent).toContain(
      'Go',
    );
  });
});
