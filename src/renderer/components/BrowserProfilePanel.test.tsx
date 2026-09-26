/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserProfilePanel } from './BrowserProfilePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

describe('Perfil e logins', () => {
  it('imports only explicitly selected Chrome sites and shows a partial result', async () => {
    const imported = vi.fn(async () => ({ importedCookies: 3, importedSites: 1, skipped: { partitioned: 1, encrypted: 0, expired: 0, invalid: 0 } }));
    Object.defineProperty(window, 'nexus', { configurable: true, value: { browser: {
      profileStatus: vi.fn(async () => ({ mode: 'isolated', enabled: false, shareWithAgents: false, storedCookies: 0, importSupported: true })),
      chromeProfiles: vi.fn(async () => [{ id: 'chrome-profile', name: 'Pessoal' }]),
      chromeSites: vi.fn(async () => [{ domain: 'example.com', cookies: 3 }, { domain: 'other.example', cookies: 2 }]),
      chromeImport: imported,
    } } });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<BrowserProfilePanel paneId="browser-test" onClose={() => {}} />));
    const site = container.querySelector<HTMLInputElement>('input[aria-label="Importar example.com"]');
    expect(site?.checked).toBe(false);
    const importButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Importar sites selecionados')!;
    expect(importButton.disabled).toBe(true);
    await act(async () => site!.click());
    await act(async () => importButton.click());
    expect(imported).toHaveBeenCalledWith('browser-test', 'chrome-profile', ['example.com']);
    expect(container.textContent).toContain('1 site');
    expect(container.textContent).toContain('1 item');
  });
});
