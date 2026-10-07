/** @vitest-environment jsdom */
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_ANIMATION_DURATION_MS } from '../../lib/panel-presence';
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

describe('AppShell inspector presence', () => {
  const SCOPE_A = '/projects/a\nterminal\ncontextual-panel';
  const SCOPE_B = '/projects/b\nterminal\ncontextual-panel';
  let frames: FrameRequestCallback[] = [];
  let root: Root | null = null;
  let host: HTMLElement;

  function shell(inspector: ReactNode, scopeKey: string) {
    return (
      <AppShell
        rail={<span>Rail</span>}
        content={<p>Terminal</p>}
        inspector={inspector}
        inspectorLabel="Painel contextual"
        inspectorScopeKey={scopeKey}
      />
    );
  }

  function mount(inspector: ReactNode, scopeKey = SCOPE_A): void {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mountedRoots.push(root);
    act(() => root?.render(shell(inspector, scopeKey)));
  }

  function update(inspector: ReactNode, scopeKey = SCOPE_A): void {
    act(() => root?.render(shell(inspector, scopeKey)));
  }

  /** Dois quadros: a supressão de navegação só solta depois da pintura. */
  function paint(): void {
    for (let frame = 0; frame < 2; frame += 1) {
      act(() => {
        for (const callback of frames.splice(0)) callback(0);
      });
    }
  }

  function inspector(): HTMLElement | null {
    return host.querySelector<HTMLElement>('aside.product-inspector');
  }

  function withInspectorColumn(): boolean {
    return (
      host
        .querySelector('.nexus-shell__body')
        ?.classList.contains('nexus-shell__body--with-inspector') ?? false
    );
  }

  beforeEach(() => {
    frames = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a closing inspector inert and hidden until the panel duration ends', () => {
    mount(<section>Git do projeto A</section>);
    paint();

    update(undefined);

    const closing = inspector();
    expect(closing?.textContent).toBe('Git do projeto A');
    expect(closing?.dataset.state).toBe('closing');
    expect(closing?.hasAttribute('inert')).toBe(true);
    expect(closing?.getAttribute('aria-hidden')).toBe('true');
    expect(closing?.style.getPropertyValue('--panel-motion-duration')).toBe(
      `${PANEL_ANIMATION_DURATION_MS}ms`,
    );
    // A coluna não muda no meio da saída: o terminal redimensiona uma vez só.
    expect(withInspectorColumn()).toBe(true);

    act(() => vi.advanceTimersByTime(PANEL_ANIMATION_DURATION_MS - 1));
    expect(inspector()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(inspector()).toBeNull();
    expect(withInspectorColumn()).toBe(false);
  });

  it('reopening mid-exit mounts a fresh, interactive inspector', () => {
    let mounts = 0;
    function MountProbe() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <span>Painel vivo</span>;
    }
    mount(<MountProbe />);
    paint();
    update(undefined);
    act(() => vi.advanceTimersByTime(PANEL_ANIMATION_DURATION_MS / 2));

    update(<MountProbe />);
    act(() => vi.advanceTimersByTime(PANEL_ANIMATION_DURATION_MS * 3));

    const reopened = inspector();
    expect(reopened?.dataset.state).toBe('open');
    expect(reopened?.dataset.enter).toBe('animated');
    expect(reopened?.hasAttribute('inert')).toBe(false);
    expect(reopened?.hasAttribute('aria-hidden')).toBe(false);
    expect(mounts).toBe(2);
  });

  it('never shows the previous workspace inspector after a scope change', () => {
    mount(<section>Git do projeto A</section>);
    paint();

    update(undefined, SCOPE_B);

    expect(inspector()).toBeNull();
    expect(withInspectorColumn()).toBe(false);
  });

  it('shows a navigation-restored inspector without motion and closes it at once before it painted', () => {
    mount(<section>Restaurado</section>);

    expect(inspector()?.hasAttribute('data-enter')).toBe(false);
    update(undefined);
    expect(inspector()).toBeNull();
  });

  it('removes the inspector at once under prefers-reduced-motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    mount(<section>Git do projeto A</section>);
    paint();

    update(undefined);

    expect(inspector()).toBeNull();
  });
});
