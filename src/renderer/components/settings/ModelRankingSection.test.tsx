/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicModelRankingSnapshot } from '../../../shared/eval-ranking-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { useProviderStore } from '../../state/provider-store';
import { useQuotaStore } from '../../state/quota-store';
import { ModelRankingSection } from './ModelRankingSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const sampleSnapshot: PublicModelRankingSnapshot = {
  schemaVersion: 1,
  generatedAt: '2026-08-14T10:00:00.000Z',
  suiteId: 'nexus-v1',
  suiteRevision: 'eval-prod',
  description: 'Nexus model evaluation ranking',
  entries: [
    {
      id: 'codex/gpt-5-pro',
      adapterId: 'codex',
      modelId: 'gpt-5-pro',
      overall: 92,
      coding: 95,
      reasoning: 94,
      frontend: 88,
      security: 90,
      costTier: 'high',
      availability: 'paid',
      evaluatedAt: '2026-08-14T10:00:00.000Z',
      source: 'nexus-eval/v1/eval-prod',
      confidence: 0.96,
      rank: 1,
    },
    {
      id: 'claude/claude-3-7-sonnet',
      adapterId: 'claude',
      modelId: 'claude-3-7-sonnet',
      overall: 90,
      coding: 92,
      reasoning: 91,
      frontend: 94,
      security: 89,
      costTier: 'medium',
      availability: 'paid',
      evaluatedAt: '2026-08-14T10:00:00.000Z',
      source: 'nexus-eval/v1/eval-prod',
      confidence: 0.94,
      rank: 2,
    },
    {
      id: 'grok/grok-code-fast',
      adapterId: 'grok',
      modelId: 'grok-code-fast',
      overall: 78,
      coding: 80,
      reasoning: 75,
      frontend: 76,
      security: 77,
      costTier: 'low',
      availability: 'cheap',
      evaluatedAt: '2026-08-14T10:00:00.000Z',
      source: 'nexus-eval/v1/eval-prod',
      confidence: 0.9,
      rank: 3,
    },
  ],
};

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<ModelRankingSection />));
  return { host, root };
}

describe('ModelRankingSection', () => {
  beforeEach(() => {
    useProviderStore.setState({
      providers: [
        {
          adapterId: 'codex',
          label: 'Codex',
          installed: true,
          enabled: true,
        } as unknown as ProviderSettingsInfo,
        {
          adapterId: 'claude',
          label: 'Claude',
          installed: false,
          enabled: true,
        } as unknown as ProviderSettingsInfo,
      ],
    });
    useQuotaStore.getState().reset();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        ranking: {
          public: vi.fn(async () => sampleSnapshot),
        },
      },
    });
  });

  afterEach(() => {
    useProviderStore.setState({ providers: [] });
    useQuotaStore.getState().reset();
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders section title, operational doctrine hint, and fleet counters', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Comparar modelos');
    expect(host.textContent).toContain('Faixas de custo');
    expect(host.textContent).toContain('estimativas, não avaliações reais');
    expect(host.textContent).toContain('nexus-v1');
    expect(host.textContent).toContain('3 modelos');
    expect(host.textContent).toContain('1 com ferramenta instalada');

    act(() => root.unmount());
  });

  it('renders operational bands and mission picks correctly', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Operational bands
    expect(host.textContent).toContain('Faixas de custo');
    expect(host.textContent).toContain('Rápido');
    expect(host.textContent).toContain('Equilibrado');
    expect(host.textContent).toContain('Profundo');

    // Mission picks
    expect(host.textContent).toContain('Destaques por tipo de tarefa');
    expect(host.textContent).toContain('gpt-5-pro');
    expect(host.textContent).toContain('claude-3-7-sonnet');
    expect(host.textContent).toContain('grok-code-fast');

    act(() => root.unmount());
  });

  it('renders sorting chips and allows switching sorting dimension', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const chips = host.querySelectorAll<HTMLButtonElement>('.rank-ops__chip');
    expect(chips.length).toBe(5);

    const codingChip = Array.from(chips).find((c) => c.textContent?.includes('Programação'));
    expect(codingChip).not.toBeUndefined();

    await act(async () => {
      codingChip?.click();
    });

    expect(host.textContent).toContain('Comparação · Programação');
    act(() => root.unmount());
  });

  it('renders radar chart and detail view for the selected model', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('.rank-radar')).not.toBeNull();
    expect(host.querySelector('.rank-ops__detail')).not.toBeNull();
    expect(host.textContent).toContain('conf 96%');

    act(() => root.unmount());
  });

  it('labels tool presence in Portuguese and filters the race to installed tools', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Estado escrito em pt-BR, não "live"/"off-machine".
    expect(host.textContent).toContain('instalada');
    expect(host.textContent).toContain('não detectada');
    expect(host.textContent).not.toContain('off-machine');

    const toggle = host.querySelector<HTMLInputElement>(
      '.rank-ops__only-installed input',
    );
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle!.click();
    });

    const rows = host.querySelectorAll('.rank-race__row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain('gpt-5-pro');
    expect(host.textContent).toContain('Ordenar por');
    act(() => root.unmount());
  });

  it('handles error state when public ranking API fails', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        ranking: {
          public: vi.fn(async () => {
            throw new Error('Falha de rede');
          }),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Falha ao carregar ranking');
    expect(host.textContent).toContain('Falha de rede');
    act(() => root.unmount());
  });
});
