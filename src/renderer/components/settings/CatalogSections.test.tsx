/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsSection, SkillsSection, ToolsSection, PluginsSection, HooksSection } from './CatalogSections';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items = [
  { kind: 'skill', name: 'interface-guide', file: '/workspace/.agents/skills/interface-guide/SKILL.md', size: 20, modifiedAt: 1 },
  { kind: 'agent', name: 'review-agent', file: '/workspace/.claude/agents/review-agent.md', size: 20, modifiedAt: 1 },
];
const catalog = { updatedAt: 1, items: [{ kind: 'skill', name: 'interface-guide', tier: 'builder', blurb: 'Instruções para interfaces.', whenToUse: '' }] };
const api = {
  listInstalledCatalog: vi.fn(), harnessEnriched: vi.fn(), harnessEnrich: vi.fn(),
  listNativeTools: vi.fn(), listPluginFiles: vi.fn(), listHookHomes: vi.fn(),
};
const roots: Root[] = [];

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}

beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset());
  api.listInstalledCatalog.mockResolvedValue(items);
  api.harnessEnriched.mockResolvedValue(catalog);
  api.harnessEnrich.mockResolvedValue({ ok: true, catalog });
  api.listNativeTools.mockResolvedValue([{ name: 'nexus_file_read', description: 'Lê arquivos autorizados.' }]);
  api.listPluginFiles.mockResolvedValue([{ ...items[0], name: 'custom-adapter', kind: 'adapter' }]);
  api.listHookHomes.mockResolvedValue([{ ...items[0], name: 'generated-home', kind: 'hook-home' }]);
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: api } });
});

afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
});

describe('catalog loading and recovery', () => {
  it('announces a pending installed catalog without claiming it is empty', async () => {
    let resolve!: (value: typeof items) => void;
    api.listInstalledCatalog.mockReturnValue(new Promise(done => { resolve = done; }));
    const host = mount(<AgentsSection />);
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/carregando/i);
    expect(host.textContent).not.toContain('Nada para mostrar');
    expect(host.textContent).not.toContain('Abrir Marketplace');
    resolve(items);
    await settle();
    expect(host.textContent).toContain('review-agent');
  });

  it.each(['installed', 'tools', 'plugins', 'hooks'] as const)('exposes a recoverable %s read failure instead of an empty or endless loading state', async kind => {
    const request = kind === 'installed' ? api.listInstalledCatalog : kind === 'tools' ? api.listNativeTools : kind === 'plugins' ? api.listPluginFiles : api.listHookHomes;
    request.mockRejectedValueOnce(new Error('private stack details'));
    const host = mount(kind === 'installed' ? <AgentsSection /> : kind === 'tools' ? <ToolsSection /> : kind === 'plugins' ? <PluginsSection adapters={[]} /> : <HooksSection />);
    await settle();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('private stack details');
    expect(host.textContent).not.toContain('Nada para mostrar');
    if (kind === 'tools') expect(host.textContent).not.toContain('0 ferramentas');
    act(() => button(host, 'Tentar novamente').click());
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(kind === 'installed' ? 'review-agent' : kind === 'tools' ? 'nexus_file_read' : kind === 'plugins' ? 'custom-adapter' : 'generated-home');
  });

  it('preserves installed resources when only descriptions fail and retries their own endpoint', async () => {
    api.harnessEnriched.mockRejectedValueOnce(new Error('metadata unavailable'));
    const host = mount(<SkillsSection />);
    await settle();
    expect(host.textContent).toContain('interface-guide');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    act(() => button(host, 'Tentar novamente').click());
    await settle();
    expect(api.listInstalledCatalog).toHaveBeenCalledOnce();
    expect(api.harnessEnriched).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Instruções para interfaces.');
  });

  it('offers Marketplace for a successfully loaded empty catalog and keeps enrichment unavailable', async () => {
    api.listInstalledCatalog.mockResolvedValue([]);
    const host = mount(<AgentsSection />);
    await settle();
    expect(host.textContent).toContain('Abrir Marketplace');
    expect(button(host, 'Gerar descrições com IA').disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('unlocks enrichment after a rejected request and retains the installed list', async () => {
    api.harnessEnrich.mockRejectedValueOnce(new Error('classifier unavailable'));
    const host = mount(<SkillsSection />);
    await settle();
    const details = host.querySelector<HTMLDetailsElement>('.settings-enrich');
    if (details?.tagName === 'DETAILS') details.open = true;
    const generate = host.querySelector<HTMLButtonElement>('.settings-enrich button')!;
    act(() => generate.click());
    await settle();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(generate.disabled).toBe(false);
    expect(host.textContent).toContain('interface-guide');
    act(() => button(host, 'Tentar novamente').click());
    await settle();
    expect(api.harnessEnrich).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('uses readable function filters and can reset a filtered-empty list', async () => {
    const host = mount(<SkillsSection />);
    await settle();
    const filter = host.querySelector<HTMLSelectElement>('[aria-label="Função do recurso"]');
    expect(filter).not.toBeNull();
    act(() => { filter!.value = 'scout'; filter!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).not.toContain('Abrir Marketplace');
    act(() => button(host, 'Limpar filtros').click());
    expect(filter!.value).toBe('todos');
    expect(host.textContent).toContain('interface-guide');
  });
});
