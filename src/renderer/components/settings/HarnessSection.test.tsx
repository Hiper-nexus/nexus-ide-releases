/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { HarnessSection } from './HarnessSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const items = [
  { kind: 'agent', name: 'revisar-api', file: '/example/.claude/agents/revisar.md', size: 100, modifiedAt: 1 },
  { kind: 'skill', name: 'planejar-interface', file: '/example/.codex/skills/interface.md', size: 100, modifiedAt: 1 },
];
const roots: Root[] = [];
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(<HarnessSection />));
  return host;
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  expect(found).toBeTruthy(); return found!;
}
beforeEach(() => {
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    settings: { orchGet: vi.fn(async () => DEFAULT_ORCH_SETTINGS) },
    orch: {
      listInstalledCatalog: vi.fn(async () => items),
      harnessEnriched: vi.fn(async () => ({ version: 1, updatedAt: 1, items: [
        { name: 'revisar-api', kind: 'agent', tier: 'reviewer', blurb: 'Revisa a API.', whenToUse: 'Antes da entrega.' },
      ] })),
      harnessEnrich: vi.fn(async () => ({ ok: false, error: 'Serviço indisponível.' })),
    },
  } });
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); Reflect.deleteProperty(window, 'nexus'); vi.restoreAllMocks();
});
describe('HarnessSection', () => {
  it('shows loading instead of a false empty catalog before the request completes', () => {
    vi.mocked(window.nexus.orch.listInstalledCatalog).mockImplementation(() => new Promise(() => {}));
    const host = mount();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Carregando recursos');
    expect(host.textContent).not.toContain('Nenhuma capacidade encontrada');
  });
  it('groups installed resources by purpose and treats missing descriptions as neutral', async () => {
    const host = mount(); await flush();
    expect(host.textContent).toContain('Revisar');
    expect(host.textContent).toContain('Sem classificação');
    expect(host.textContent).not.toMatch(/sem tier|pendente|Cobertura|CAPABILITY HARNESS/);
    expect(host.querySelector('input[aria-label="Buscar recursos"]')).toBeTruthy();
    expect(host.querySelector('select[aria-label="Tipo de recurso"]')).toBeTruthy();
  });
  it('retries a failed inventory request and then shows the installed resources', async () => {
    vi.mocked(window.nexus.orch.listInstalledCatalog).mockRejectedValueOnce(new Error('offline'));
    const host = mount(); await flush();
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
    await act(async () => { button(host, 'Tentar novamente').click(); });
    await flush();
    expect(host.textContent).toContain('revisar-api');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('moves focus between the real tabs and exposes one associated panel', async () => {
    const host = mount(); await flush();
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0].focus();
    await act(async () => { tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tabs[2].id);
    expect(host.textContent).toContain('Conexão ACP');
  });
  it('keeps a real route to MCP configuration', async () => {
    const host = mount(); await flush();
    act(() => { button(host, 'Configurar conexões MCP').click(); });
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'settings', section: 'mcps' });
  });
  it('retries the failed description operation without losing the installed inventory', async () => {
    const host = mount(); await flush();
    act(() => host.querySelector<HTMLElement>('.harness-settings__advanced summary')!.click());
    await act(async () => { button(host, 'Gerar descrições com IA').click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Serviço indisponível');
    await act(async () => { button(host, 'Tentar novamente').click(); });
    expect(window.nexus.orch.harnessEnrich).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('revisar-api');
  });
});
