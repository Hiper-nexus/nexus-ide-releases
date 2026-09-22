/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RecipesSection } from './CatalogSectionsOps';

it('keeps workflow requirements available while advanced project editing starts collapsed', async () => {
  const save = vi.fn().mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: {
    getRecipeOverlay: vi.fn().mockResolvedValue({ ok: true, stacks: ['react'], issues: [], categories: { architect: 2 }, overlay: { stacks: ['react'] }, suggestions: [
      { id: 'web', title: 'Equipe para interfaces', agents: ['architect', 'frontend', 'reviewer'], tools: ['read'], gaps: [] },
    ] }), saveCatalogOverlay: save,
  } } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<RecipesSection />); });
    expect(host.textContent).toContain('Equipe para interfaces');
    expect(host.querySelector('.settings-recipes__roles')?.textContent).toBe('architect · frontend · reviewer');
    const field = host.querySelector<HTMLInputElement>('#recipe-project-stacks')!;
    expect(field.closest('details')?.open).toBe(false);
    expect(host.querySelector('label[for="recipe-project-stacks"]')).not.toBeNull();
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Salvar')!.click());
    expect(save).toHaveBeenCalledWith({ stacks: ['react'] });
  } finally {
    act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window, 'nexus');
  }
});

it('summarizes recipe lint as neutral pending adjustments with the main reason', async () => {
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: {
    getRecipeOverlay: vi.fn().mockResolvedValue({ ok: false, stacks: ['react'], categories: {}, overlay: { stacks: ['react'] }, suggestions: [], issues: [
      { severity: 'error', squadId: 'web', squadName: 'Web', agentName: 'Dev', field: 'allowedTools', ref: '*', message: 'm1' },
      { severity: 'error', squadId: 'web', squadName: 'Web', agentName: 'Dev', field: 'allowedTools', ref: 'nexus_a', message: 'm2' },
      { severity: 'error', squadId: 'api', squadName: 'API', agentName: 'Dev', field: 'allowedTools', ref: 'nexus_b', message: 'm3' },
    ] }), saveCatalogOverlay: vi.fn(),
  } } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<RecipesSection />); });
    const status = host.querySelector('[data-testid="recipes-status"]')!;
    expect(status.textContent).toBe('2 fluxos com ajustes pendentes');
    expect(status.className).not.toMatch(/--warn|--danger/);
    expect(host.querySelector('[data-testid="recipes-status-reason"]')?.textContent)
      .toContain('2 ferramentas citadas não existem');
    expect(host.textContent).not.toMatch(/pendências/i);
    const kinds = [...host.querySelectorAll('.catalog-item__details--band .settings-chip')].map((chip) => chip.textContent);
    expect(kinds).toEqual(['ferramenta ausente', 'ferramenta ausente', 'sem lista de ferramentas']);
  } finally {
    act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window, 'nexus');
  }
});
