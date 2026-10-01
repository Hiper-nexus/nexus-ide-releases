/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionModelsSection } from './DecisionModelsSection';
import type { DecisionModelStatus } from '../../../shared/decision-models';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let status: DecisionModelStatus;
let host: HTMLDivElement;
let root: Root;
let storedToken = '';
let rejectedSave = false;

async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<DecisionModelsSection />); });
}
function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function button(label: string) { return [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!; }

describe('complementary decision model settings', () => {
  beforeEach(() => {
    storedToken = ''; rejectedSave = false;
    status = { settings: { mode: 'jev', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false },
      accountId: '0123456789abcdef0123456789abcdef', accountIdSource: 'settings', hasStoredKey: false,
      hasEnv: false, keyMasked: null, secureStorageAvailable: true, isReady: false };
    Object.defineProperty(window, 'nexus', { configurable: true, value: {
      settings: { orchSet: vi.fn(async (patch) => { status = { ...status, settings: patch.decisionModels, accountId: patch.decisionModels.cloudflareAccountId }; return { decisionModels: status.settings }; }) },
      decisionModels: {
        status: vi.fn(async () => status),
        setKey: vi.fn(async ({ token }) => {
          if (rejectedSave) return { ok: false, error: 'Cofre indisponível.' };
          storedToken = token; status = { ...status, hasStoredKey: Boolean(token), keyMasked: token ? 'syn…oken' : null, isReady: Boolean(token) };
          return { ok: true };
        }),
        test: vi.fn(async () => ({ ok: false, detail: 'Token recusado.' })),
      },
    } });
  });
  afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); });

  it('shows manual and automatic options and starts without visual egress', async () => {
    await mount();
    expect(host.textContent).toContain('Automático');
    expect(host.textContent).toContain('Somente Jev');
    expect(host.textContent).toContain('Somente Clef');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Analisar imagens com Clef"]')?.checked).toBe(false);
  });

  it('saves only the Cloudflare token, clears its transient input and never persists plaintext in web storage', async () => {
    await mount();
    await act(async () => { fill('API Token Cloudflare', 'synthetic-private-token'); });
    await act(async () => { button('Salvar token').click(); });
    expect(storedToken).toBe('synthetic-private-token');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="API Token Cloudflare"]')?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="API Token Cloudflare"]')?.type).toBe('password');
    expect(JSON.stringify(localStorage)).not.toContain('synthetic-private-token');
    expect(host.textContent).not.toContain('synthetic-private-token');
  });

  it('reports rejected vault writes instead of claiming that the token was saved', async () => {
    rejectedSave = true; await mount();
    await act(async () => { fill('API Token Cloudflare', 'synthetic-private-token'); });
    await act(async () => { button('Salvar token').click(); });
    expect(storedToken).toBe('');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Cofre indisponível');
  });

  it('rejects an invalid account id before saving a token', async () => {
    await mount();
    await act(async () => { fill('Account ID Cloudflare', 'invalid'); fill('API Token Cloudflare', 'synthetic-private-token'); });
    await act(async () => { button('Salvar token').click(); });
    expect(storedToken).toBe('');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Account ID');
  });

  it('persists explicit automatic mode through validated settings', async () => {
    await mount();
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Modo de decisão"]')!;
    await act(async () => { select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(status.settings.mode).toBe('auto');
    expect(status.settings.visionEnabled).toBe(false);
  });

  it('shows failed connection tests inline', async () => {
    status = { ...status, hasStoredKey: true, keyMasked: 'syn…oken', isReady: true };
    await mount(); await act(async () => { button('Testar conexão').click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Token recusado');
  });

  it('keeps older bridges usable without the Clef namespace', async () => {
    delete (window.nexus as any).decisionModels;
    await mount();
    expect(host.textContent).toContain('atualize');
  });
});
