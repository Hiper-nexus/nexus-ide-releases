/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

describe('AppShell', () => {
  it('composes rail, header, canvas, inspector and overlays in semantic slots', () => {
    const host = render(
      <AppShell
        rail={<nav aria-label="Workspaces">Rail</nav>}
        header={<span>Cabeçalho</span>}
        content={<section data-testid="destination">Destino atual</section>}
        inspector={<section>Detalhes da missão</section>}
        overlays={<div data-testid="overlay">Confirmação</div>}
      />,
    );

    const frame = host.querySelector('.nexus-shell__frame');
    const rail = host.querySelector('aside.workspace-rail');
    const header = host.querySelector('header.product-header');
    const canvas = host.querySelector('main.product-canvas');
    const inspector = host.querySelector('aside.product-inspector');
    const overlays = host.querySelector('.nexus-shell__overlays');

    expect(frame).not.toBeNull();
    expect(rail?.textContent).toContain('Rail');
    expect(header?.textContent).toContain('Cabeçalho');
    expect(canvas?.textContent).toContain('Destino atual');
    expect(inspector?.textContent).toContain('Detalhes da missão');
    expect(overlays?.textContent).toContain('Confirmação');
    expect(frame?.contains(overlays)).toBe(false);
  });

  it('renders exactly one visible destination inside the main canvas', () => {
    const host = render(
      <AppShell
        rail={<span>Rail</span>}
        content={<article data-testid="destination">Quadro da missão</article>}
      />,
    );

    const destinations = host.querySelectorAll('[data-testid="destination"]');
    expect(destinations).toHaveLength(1);
    expect(destinations[0]?.closest('main.product-canvas')).not.toBeNull();
    expect(host.querySelector('header.product-header')).toBeNull();
    expect(host.querySelector('aside.product-inspector')).toBeNull();
    expect(host.querySelector('.nexus-shell__overlays')).toBeNull();
  });

  it('provides a keyboard skip target and accessible landmark names', () => {
    const host = render(
      <AppShell
        rail={<span>Rail</span>}
        content={<p>Terminal</p>}
        contentLabel="Terminal do workspace"
        inspector={<p>Atividade</p>}
        inspectorLabel="Atividade da missão"
      />,
    );

    const skipLink = host.querySelector<HTMLAnchorElement>(
      '.nexus-shell__skip-link',
    );
    const canvas = host.querySelector<HTMLElement>('main.product-canvas');
    const inspector = host.querySelector<HTMLElement>(
      'aside.product-inspector',
    );

    expect(skipLink?.textContent).toBe('Pular para o conteúdo');
    expect(skipLink?.getAttribute('href')).toBe('#nexus-product-content');
    expect(canvas?.id).toBe('nexus-product-content');
    expect(canvas?.tabIndex).toBe(-1);
    expect(canvas?.getAttribute('aria-label')).toBe('Terminal do workspace');
    expect(inspector?.getAttribute('aria-label')).toBe('Atividade da missão');

    skipLink?.focus();
    expect(document.activeElement).toBe(skipLink);
  });
});
