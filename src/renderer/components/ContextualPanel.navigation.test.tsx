/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextualPanel } from './ContextualPanel';
import { useContextualPanelNavStore } from '../state/contextual-panel-nav-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('reveals active tabs on container resize, scrolls with controls, and supports keyboard edges', () => {
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  useContextualPanelNavStore.setState({ requestedTab: null, requestId: 0 });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ContextualPanel storage={null} initial={{ visible: true }} relevantTabs={['mission', 'editor', 'git', 'memory']} />));
  const strip = host.querySelector<HTMLElement>('[role="tablist"]')!;
  const tabs = [...strip.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  let width = 240;
  Object.defineProperties(strip, {
    clientWidth: { get: () => width },
    scrollWidth: { value: 500 },
    getBoundingClientRect: { value: () => ({ left: 0, right: width }) },
  });
  for (const [index, tab] of tabs.entries()) {
    tab.getBoundingClientRect = () => ({ left: index * 120 - strip.scrollLeft, right: index * 120 + 100 - strip.scrollLeft } as DOMRect);
  }
  const previous = host.querySelector<HTMLButtonElement>('[aria-label="Abas anteriores"]')!;
  const next = host.querySelector<HTMLButtonElement>('[aria-label="Próximas abas"]')!;
  // jsdom does not clamp scrollLeft like Chromium.
  let scroll = 0;
  Object.defineProperty(strip, 'scrollLeft', { get: () => scroll, set: (value: number) => { scroll = Math.max(0, Math.min(500 - width, value)); } });
  act(() => resized());
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);
  act(() => next.click());
  expect(scroll).toBe(192);
  expect(previous.disabled).toBe(false);
  act(() => previous.click());
  expect(scroll).toBe(0);

  const press = (tab: HTMLButtonElement, key: string) => act(() => tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  press(tabs[0], 'End');
  expect(document.activeElement).toBe(tabs[3]);
  expect(tabs[3].getAttribute('aria-selected')).toBe('true');
  expect(tabs[3].tabIndex).toBe(0);
  expect(tabs[0].tabIndex).toBe(-1);
  expect(scroll).toBeGreaterThan(0);
  width = 180;
  act(() => resized());
  expect(tabs[3].getBoundingClientRect().right).toBeLessThanOrEqual(width);
  act(() => next.click());
  expect(next.disabled).toBe(true);
  press(tabs[3], 'ArrowRight');
  expect(document.activeElement).toBe(tabs[0]);
  press(tabs[0], 'ArrowLeft');
  expect(document.activeElement).toBe(tabs[3]);
  press(tabs[3], 'Home');
  expect(document.activeElement).toBe(tabs[0]);
  expect(scroll).toBe(0);
  expect(strip.contains(host.querySelector('[aria-label="Ocultar painel"]'))).toBe(false);
  act(() => root.unmount());
  expect(disconnect).toHaveBeenCalled();
});

it('attaches wheel navigation when opening a panel mounted hidden', () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ContextualPanel storage={null} initial={{ visible: false }} />));
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  const strip = host.querySelector<HTMLElement>('[role="tablist"]')!;
  Object.defineProperties(strip, { clientWidth: { value: 180 }, scrollWidth: { value: 700 } });
  strip.scrollLeft = 0;
  const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
  act(() => strip.dispatchEvent(wheel));
  expect(strip.scrollLeft).toBe(100);
  expect(wheel.defaultPrevented).toBe(true);
});
