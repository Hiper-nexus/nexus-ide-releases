/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DesignSystemsSection } from './DesignSystemsSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const kit = { slug: 'sample/style', name: 'Estilo editorial', description: 'Tipografia e espaço.', author: 'Autor', url: '', tags: [], license: 'MIT', downloadCount: 0, likeCount: 2 };

it('recovers from a rejected search without exposing transport errors', async () => {
  const search = vi.fn().mockRejectedValueOnce(new Error('private transport detail')).mockResolvedValue({ ok: true, kits: [kit] });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: { searchDesignSystems: search } } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<DesignSystemsSection />); });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('private transport detail');
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="alert"] button')?.click(); });
    expect(search).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(kit.name);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'nexus');
  }
});

it('allows retry after an import rejection and describes success as a proposal', async () => {
  const importDesignSystem = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValue({ ok: true, draftId: 'draft-123', targetPath: '.context/docs/design-system.md', servedBy: 'local-catalog' });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: {
    searchDesignSystems: vi.fn(async () => ({ ok: true, kits: [kit] })), importDesignSystem,
  } } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<DesignSystemsSection />); });
    const button = host.querySelector<HTMLButtonElement>('li button')!;
    await act(async () => { button.click(); });
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain('Não foi possível importar');
    await act(async () => { button.click(); });
    expect(importDesignSystem).toHaveBeenLastCalledWith({ identifier: kit.slug });
    expect(host.textContent).toContain('Proposta criada · aguardando revisão');
    expect(host.textContent).not.toContain('Aplicado');
    const details = Array.from(host.querySelectorAll('details')).find(node => node.textContent?.includes('draft-123'));
    expect(details?.open).toBe(false);
  } finally {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'nexus');
  }
});
