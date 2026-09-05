/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MediaSection } from './MediaSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

it('keeps technical configuration collapsed and identifies the credential input', async () => {
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    media: {
      listProviders: vi.fn(async () => [{
        id: 'openai-image', kind: 'image', label: 'OpenAI', envVar: 'OPENAI_API_KEY',
        defaultModel: 'image-model', models: ['image-model'], hasKey: true, maskedKey: '••••1234',
      }]),
      usageTotals: vi.fn(async () => ({ generations: 0, costUsd: 0 })),
    },
  } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<MediaSection />); });
    const details = host.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('OPENAI_API_KEY');
    expect(details?.textContent).toContain('nexus_image_generate');
    expect(host.querySelector('input')?.getAttribute('aria-label')).toBe('Chave de acesso de OpenAI');
    expect(host.textContent).toContain('Conectado');
    expect(host.textContent).not.toContain('••••1234');
    expect(host.textContent).not.toContain('flagship');
  } finally {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'nexus');
  }
});

it('shows a recoverable error instead of an empty catalog when loading fails', async () => {
  const listProviders = vi.fn().mockRejectedValueOnce(new Error('transport unavailable')).mockResolvedValue([]);
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    media: { listProviders, usageTotals: vi.fn(async () => ({ generations: 0, costUsd: 0 })) },
  } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<MediaSection />); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível carregar');
    expect(host.textContent).not.toContain('Nenhum serviço');
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="alert"] button')?.click(); });
    expect(listProviders).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('Nenhum serviço');
  } finally {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'nexus');
  }
});

it('does not claim removal when saving fails and allows retry after a rejected request', async () => {
  const setKey = vi.fn().mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('private transport detail')).mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    media: {
      listProviders: vi.fn(async () => [{ id: 'openai-image', kind: 'image', label: 'OpenAI', envVar: 'OPENAI_API_KEY', defaultModel: 'image-model', models: [], hasKey: true, maskedKey: null }]),
      usageTotals: vi.fn(async () => ({ generations: 0, costUsd: 0 })), setKey,
    },
  } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<MediaSection />); });
    const remove = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Remover chave'))!;
    await act(async () => { remove.click(); });
    expect(host.textContent).toContain('Não foi possível remover');
    expect(host.textContent).not.toContain('Chave removida');
    await act(async () => { remove.click(); });
    expect(remove.disabled).toBe(false);
    expect(host.textContent).not.toContain('private transport detail');
    await act(async () => { remove.click(); });
    expect(host.textContent).toContain('Chave removida');
    expect(setKey).toHaveBeenLastCalledWith('openai-image', '');
  } finally {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'nexus');
  }
});
