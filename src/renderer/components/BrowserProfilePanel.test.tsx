/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserProfilePanel, siteSignInUrl } from './BrowserProfilePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

describe('Perfil e logins', () => {
  it('imports only explicitly selected sites of the chosen browser profile and shows a partial result', async () => {
    const imported = vi.fn(async () => ({ importedCookies: 3, importedSites: 1, skipped: { partitioned: 1, encrypted: 0, expired: 0, invalid: 0 } }));
    const importSites = vi.fn(async () => [{ domain: 'example.com', cookies: 3 }, { domain: 'other.example', cookies: 2 }]);
    Object.defineProperty(window, 'nexus', { configurable: true, value: { browser: {
      profileStatus: vi.fn(async () => ({ mode: 'isolated', enabled: false, shareWithAgents: false, storedCookies: 0 })),
      importProfiles: vi.fn(async () => [{ id: 'chrome-profile', name: 'Pessoal', browser: 'Chrome' }, { id: 'firefox-profile', name: 'default-release', browser: 'Firefox' }]),
      importSites,
      importCookies: imported,
    } } });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<BrowserProfilePanel paneId="browser-test" onClose={() => {}} />));
    expect(container.textContent).toContain('Importar de outro navegador');
    expect([...container.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Chrome — Pessoal', 'Firefox — default-release']);
    expect(importSites).toHaveBeenCalledWith('browser-test', 'chrome-profile');
    // Signing in stays available for sites no browser has.
    expect(container.querySelector('input[aria-label="Site para entrar"]')).not.toBeNull();
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

  describe('sem navegador importável', () => {
    function mountWithoutImport(mode: 'isolated' | 'personal') {
      const profileChange = vi.fn(async () => ({ mode: 'personal', enabled: true, shareWithAgents: true, storedCookies: 0 }));
      const load = vi.fn(async () => undefined);
      const onClose = vi.fn();
      Object.defineProperty(window, 'nexus', { configurable: true, value: { browser: {
        profileStatus: vi.fn(async () => ({ mode, enabled: true, shareWithAgents: true, storedCookies: 0 })),
        importProfiles: vi.fn(async () => []),
        importSites: vi.fn(async () => []),
        importCookies: vi.fn(),
        profileChange,
        load,
      } } });
      container = document.createElement('div'); document.body.append(container); root = createRoot(container);
      return { profileChange, load, onClose };
    }

    function typeAddress(value: string) {
      const input = container!.querySelector<HTMLInputElement>('input[aria-label="Site para entrar"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    it('não promete importação: passa a aba ao Perfil Nexus e abre o site para entrar', async () => {
      const { profileChange, load, onClose } = mountWithoutImport('isolated');
      await act(async () => root!.render(<BrowserProfilePanel paneId="browser-win" onClose={onClose} />));
      expect(container!.textContent).toContain('Entrar nos seus sites');
      expect(container!.textContent).not.toContain('Importar de outro navegador');
      typeAddress('github.com');
      const submit = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Usar o Perfil Nexus e abrir')!;
      await act(async () => submit.click());
      expect(profileChange).toHaveBeenCalledWith('browser-win', { mode: 'personal' });
      expect(load).toHaveBeenCalledWith('browser-win', 'https://github.com/');
      expect(onClose).toHaveBeenCalled();
    });

    it('já no Perfil Nexus só abre o site', async () => {
      const { profileChange, load, onClose } = mountWithoutImport('personal');
      await act(async () => root!.render(<BrowserProfilePanel paneId="browser-win" onClose={onClose} />));
      typeAddress('https://mail.example.com/inbox');
      const submit = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Abrir para entrar')!;
      await act(async () => submit.click());
      expect(profileChange).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith('browser-win', 'https://mail.example.com/inbox');
    });
  });

  it('só abre endereço http(s)', () => {
    expect(siteSignInUrl('github.com')).toBe('https://github.com/');
    expect(siteSignInUrl(' http://intranet.local:8080/login ')).toBe('http://intranet.local:8080/login');
    expect(siteSignInUrl('file:///C:/Users/x/secret.txt')).toBeNull();
    expect(siteSignInUrl('javascript:alert(1)')).toBeNull();
    expect(siteSignInUrl('   ')).toBeNull();
  });
});
