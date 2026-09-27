/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computedCssValue, installStyleContract, styleTracks } from './style-contract.test-utils';
import { AppShell } from './product/AppShell';
import { ContextualPanel } from './ContextualPanel';
import { GitPanelBody } from './GitPanelBody';
import { useGitScmStore } from '../state/git-scm-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const stylesDir = path.resolve(process.cwd(), 'src/renderer/styles');
const styles = ['base.css', 'app-shell.css', 'product-wave.css', 'git-scm.css'].map(
  (file) => fs.readFileSync(path.join(stylesDir, file), 'utf8'),
);

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  document.head
    .querySelectorAll('style[data-v2-style-contract]')
    .forEach((style) => style.remove());
  vi.restoreAllMocks();
});

function renderShell(widthPx: number): HTMLElement {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_440, writable: true });
  installStyleContract(styles, { width: 1_440 });
  useGitScmStore.setState({
    branch: 'main',
    staged: [],
    unstaged: [],
    untracked: [],
    clean: true,
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <AppShell
        rail={<nav>rail</nav>}
        content={<section>canvas</section>}
        inspector={
          <ContextualPanel
            storage={null}
            initial={{ visible: true, activeTab: 'git', widthPx }}
            relevantTabs={['mission', 'editor', 'git', 'search', 'skills', 'marketplace', 'memory']}
            children={{ git: <GitPanelBody /> }}
          />
        }
      />,
    ),
  );
  return host;
}

function el(host: HTMLElement, selector: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`${selector} did not render`);
  return node;
}

describe('ContextualPanel inside the AppShell inspector slot', () => {
  it('sizes the inspector column from the panel instead of a fixed 360–440px band', () => {
    const host = renderShell(560);
    const tracks = styleTracks(el(host, '.nexus-shell__body--with-inspector'), 'grid-template-columns');
    expect(tracks).toEqual(['minmax(0, 1fr)', 'minmax(0, max-content)']);
    expect(el(host, '[data-testid="contextual-panel"]').style.width).toBe('560px');
  });

  it('fills the slot and scrolls only inside its body, never sideways', () => {
    const host = renderShell(320);
    const panel = el(host, '.ctx-panel');
    expect(computedCssValue(panel, 'height')).toBe('100%');
    expect(computedCssValue(panel, 'max-width')).toBe('100%');
    const body = el(host, '.ctx-panel__body');
    expect(computedCssValue(body, 'min-width')).toBe('0px');
    expect(computedCssValue(body, 'overflow-x')).toBe('hidden');
    expect(computedCssValue(body, 'overflow-y')).toBe('auto');
    expect(computedCssValue(el(host, '.ctx-panel__hide'), 'flex')).toBe('0 0 auto');
  });

  it('lets the Git tabs shrink with an ellipsis instead of clipping the last one', () => {
    const host = renderShell(200);
    const tabs = el(host, '.git-scm__tabs');
    expect(computedCssValue(tabs, 'min-width')).toBe('0px');
    for (const tab of Array.from(tabs.querySelectorAll('button'))) {
      expect(computedCssValue(tab, 'min-width')).toBe('0px');
      expect(computedCssValue(tab, 'overflow')).toBe('hidden');
      expect(computedCssValue(tab, 'text-overflow')).toBe('ellipsis');
      expect(computedCssValue(tab, 'white-space')).toBe('nowrap');
    }
  });

  it('reveals the active tab by scrolling only the tab strip, not the layout', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const host = renderShell(320);
    const memoryTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (tab) => tab.textContent === 'Memória',
    );
    act(() => memoryTab?.click());
    expect(memoryTab?.getAttribute('aria-selected')).toBe('true');
    expect(scrollIntoView).not.toHaveBeenCalled();
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });
});
