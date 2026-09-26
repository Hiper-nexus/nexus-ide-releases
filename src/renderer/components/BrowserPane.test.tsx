/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../browser/browser-host', () => ({ attachBrowserPane: () => () => {} }));
vi.mock('../state/layout-store', () => ({ useLayoutStore: (select: (state: { focusedPaneId: string }) => unknown) => select({ focusedPaneId: 'browser-test' }) }));
vi.mock('./PaneToolbar', () => ({ PaneToolbar: () => null }));
vi.mock('./BrowserDesignBar', () => ({ BrowserDesignBar: () => null }));
vi.mock('./DesignSidebar', () => ({ DesignSidebar: () => null }));
import { BrowserPane } from './BrowserPane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe('browser address bar', () => {
  it('submits a search through the actual address form and offers profile access', async () => {
    const load = vi.fn(async (_id: string, url: string) => ({ paneId: 'browser-test', url, title: 'Search', loading: false, canGoBack: false, canGoForward: false }));
    Object.defineProperty(window, 'nexus', { configurable: true, value: { browser: { load } } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<BrowserPane pane={{ id: 'browser-test', title: 'Navegador', kind: 'browser', browserUrl: 'coolify' }} />));
      await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      expect(load).toHaveBeenCalledWith('browser-test', 'https://www.google.com/search?q=coolify');
      expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Perfil e logins')).toBe(true);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
