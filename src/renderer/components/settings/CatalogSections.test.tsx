/** @vitest-environment jsdom */
import type { Squad } from '../../../shared/orch-types';
import { useOrchStore } from '../../state/orch-store';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsSection, SkillsSection, ToolsSection, PluginsSection, HooksSection, RulesSection, MediaCatalogSection } from './CatalogSections';

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


it('filters declared permissions by team without changing the declarations', () => {
  const previous = useOrchStore.getState().squads;
  const makeTeam = (id: string, name: string): Squad => ({
    id, name, createdAt: '1', builtin: false, orchestratorInstructions: '',
    agents: [{ id: `${id}-agent`, agentName: `${name} agente`, category: 'executor', cli: 'codex', model: 'gpt-5.6-sol', allowedTools: null, allowedSkills: [] }],
  });
  const teams = [makeTeam('alpha', 'Equipe Alfa'), makeTeam('beta', 'Equipe Beta')];
  useOrchStore.setState({ squads: teams });
  try {
    const host = mount(<RulesSection />);
    expect(host.querySelectorAll('.settings-list__item')).toHaveLength(2);
    const select = host.querySelector('select')!;
    act(() => { select.value = 'beta'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.querySelectorAll('.settings-list__item')).toHaveLength(1);
    expect(host.querySelector('.settings-list')?.textContent).toContain('Equipe Beta agente');
    expect(host.querySelector('.settings-list')?.textContent).toContain('Sem lista específica');
    expect(useOrchStore.getState().squads).toEqual(teams);
  } finally {
    act(() => useOrchStore.setState({ squads: previous }));
  }
});


it('keeps a direct route to media connections', async () => {
  const { useProductNavigationStore } = await import('../../state/product-navigation-store');
  const navigate = vi.spyOn(useProductNavigationStore.getState(), 'openSettings');
  const listProviders = vi.fn(async () => [{ id: 'openai-image', kind: 'image', label: 'OpenAI', envVar: 'OPENAI_API_KEY', defaultModel: 'gpt-image-2', models: ['gpt-image-2'], hasKey: false, maskedKey: null }]);
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: api, media: { listProviders } } });
  const host = mount(<MediaCatalogSection />);
  await settle();
  act(() => button(host, 'Configurar conexões de mídia').click());
  expect(navigate).toHaveBeenCalledWith('media');
  navigate.mockRestore();
});

describe('F-1615: a chave se cola em Modelos de mídia', () => {
  function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('o serviço sem chave mostra o campo aberto, salva no cofre e relê a lista', async () => {
    let connected = false;
    const listProviders = vi.fn(async () => [
      { id: 'higgsfield-video', kind: 'video', label: 'Higgsfield — vídeo', envVar: 'HIGGSFIELD_API_KEY', defaultModel: 'higgsfield/seedance-2.5', models: ['higgsfield/seedance-2.5'], hasKey: connected, maskedKey: null },
    ]);
    const setKey = vi.fn(async () => {
      connected = true;
      return { ok: true };
    });
    Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: api, media: { listProviders, setKey } } });
    const host = mount(<MediaCatalogSection />);
    await settle();

    const group = host.querySelector('[role="group"][aria-label="Conectar Higgsfield — vídeo"]');
    expect(group).not.toBeNull();
    const input = group!.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.getAttribute('aria-label')).toBe('Chave de acesso de Higgsfield — vídeo');
    expect(input.placeholder).toContain('ID:SEGREDO');
    typeInto(input, 'abc:def');
    await act(async () => { button(host, 'Conectar').click(); });
    await settle();

    expect(setKey).toHaveBeenCalledWith('higgsfield-video', 'abc:def');
    expect(listProviders).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('conectado');
    expect(host.querySelector('[aria-label="Conectar Higgsfield — vídeo"]')).toBeNull();
  });

  it('o serviço conectado guarda o campo em "Gerenciar conexão"', async () => {
    const listProviders = vi.fn(async () => [
      { id: 'elevenlabs', kind: 'audio', label: 'ElevenLabs — voz/TTS', envVar: 'ELEVENLABS_API_KEY', defaultModel: 'eleven_v4', models: ['eleven_v4'], hasKey: true, maskedKey: null },
    ]);
    Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: api, media: { listProviders, setKey: vi.fn() } } });
    const host = mount(<MediaCatalogSection />);
    await settle();
    const details = [...host.querySelectorAll('details')].find((node) => node.querySelector('summary')?.textContent === 'Gerenciar conexão');
    expect(details).toBeDefined();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('input[type="password"]')).not.toBeNull();
    expect(details!.textContent).toContain('Remover chave');
  });
});

it('F-1585: cada modelo de mídia diz o que aceita e quanto custa', async () => {
  const listProviders = vi.fn(async () => [
    { id: 'replicate-video', kind: 'video', label: 'Replicate', envVar: 'REPLICATE_API_TOKEN', defaultModel: 'google/veo-3.1', models: ['google/veo-3.1', 'wan-video/wan-2.5-i2v'], hasKey: true, maskedKey: null },
    { id: 'openai-image', kind: 'image', label: 'OpenAI', envVar: 'OPENAI_API_KEY', defaultModel: 'gpt-image-2', models: ['gpt-image-2'], hasKey: true, maskedKey: null, imageCostUsd: { 'gpt-image-2': 0.07 } },
  ]);
  Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: api, media: { listProviders } } });
  const host = mount(<MediaCatalogSection />);
  await settle();
  const text = host.textContent ?? '';
  expect(text).toContain('google/veo-3.1 — 4, 6, 8 s · 720p, 1080p · $0.40/s');
  expect(text).toContain('wan-video/wan-2.5-i2v —');
  expect(text).toContain('precisa de imagem inicial');
  expect(text).toContain('gpt-image-2 — $0.07 por imagem');
});
