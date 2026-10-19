/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelComparisonSnapshot } from '../../../shared/eval-ranking-types';
import { ModelRankingSection } from './ModelRankingSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: ModelComparisonSnapshot = {
  generatedAt: '2026-10-19T12:00:00.000Z',
  olderVersionsHidden: 4,
  entries: [
    {
      id: 'codex/gpt-6.1-sol',
      adapterId: 'codex',
      adapterLabel: 'Codex',
      modelId: 'gpt-6.1-sol',
      cli: 'ready',
      costTier: 'high',
      score: 97.4,
      scoreKind: 'published',
      benchmarks: { deepSWE: 75.2 },
      source: 'https://openai.com/index/introducing-gpt-6-1-sol/',
      origin: 'own',
    },
    {
      id: 'agy/gemini-3.8-flash-low',
      adapterId: 'agy',
      adapterLabel: 'Antigravity',
      modelId: 'gemini-3.8-flash-low',
      cli: 'ready',
      costTier: 'low',
      score: 89.8,
      scoreKind: 'published',
      benchmarks: { deepSWE: 73.7, terminalBench21: 89.4 },
      source: 'https://deepmind.google/models/model-cards/gemini-3-8-flash/',
      origin: 'variant',
      numbersFrom: 'gemini-3.8-flash',
    },
    {
      id: 'codex/gpt-6.2-sol',
      adapterId: 'codex',
      adapterLabel: 'Codex',
      modelId: 'gpt-6.2-sol',
      cli: 'ready',
      costTier: 'high',
      score: 97.4,
      scoreKind: 'published',
      benchmarks: { deepSWE: 75.2 },
      source: 'https://openai.com/index/introducing-gpt-6-1-sol/',
      origin: 'predecessor',
      numbersFrom: 'gpt-6.1-sol',
    },
    {
      id: 'qwen/qwen3.8-max',
      adapterId: 'qwen',
      adapterLabel: 'Qwen Code',
      modelId: 'qwen3.8-max',
      cli: 'ready',
      costTier: 'medium',
      score: null,
      scoreKind: 'none',
      benchmarks: {},
    },
    {
      id: 'devin/swe-2-high',
      adapterId: 'devin',
      adapterLabel: 'Devin',
      modelId: 'swe-2-high',
      cli: 'missing',
      costTier: 'high',
      score: 82.6,
      scoreKind: 'published',
      benchmarks: { deepSWE: 73, terminalBench21: 92.8 },
      source: 'https://cognition.com/blog/swe-2',
      origin: 'variant',
      numbersFrom: 'swe-2',
    },
  ],
};

let openExternal: ReturnType<typeof vi.fn>;
let compare: ReturnType<typeof vi.fn>;

async function mount(): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ModelRankingSection />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { host, root };
}

function rowIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.rank-race__row strong')].map((el) => el.textContent ?? '');
}

function clickByText(host: HTMLElement, selector: string, text: string): void {
  const target = [...host.querySelectorAll<HTMLElement>(selector)].find((el) =>
    el.textContent?.includes(text),
  );
  expect(target, `${selector} com "${text}"`).toBeTruthy();
  act(() => target!.click());
}

describe('ModelRankingSection (F-1588)', () => {
  beforeEach(() => {
    openExternal = vi.fn(async () => undefined);
    compare = vi.fn(async () => snapshot);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { ranking: { compare }, app: { openExternal } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('conta só o que existe e nunca fala de nota estimada', async () => {
    const { host, root } = await mount();
    const fleet = host.querySelector('.rank-ops__fleet')!.textContent ?? '';
    expect(fleet).toContain('5 modelos');
    expect(fleet).toContain('4 com benchmark publicado');
    expect(fleet).toContain('1 sem número publicado');
    expect(fleet).toContain('4 com a ferramenta instalada');
    expect(fleet).toContain('4 versões antigas ocultas');
    expect(host.textContent).toContain('benchmarks oficiais');
    expect(host.textContent).not.toMatch(/estimativa|fixture|radar|demonstração/i);
    act(() => root.unmount());
  });

  it('mostra só as ferramentas instaladas por padrão e libera as outras no filtro', async () => {
    const { host, root } = await mount();
    expect(rowIds(host)).toEqual(['gpt-6.1-sol', 'gpt-6.2-sol', 'gemini-3.8-flash-low', 'qwen3.8-max']);
    act(() => host.querySelector<HTMLInputElement>('.rank-ops__only-installed input')!.click());
    expect(rowIds(host)).toContain('swe-2-high');
    expect(host.textContent).toContain('não instalada');
    act(() => root.unmount());
  });

  it('ordena por benchmark com "—" para quem não publicou', async () => {
    const { host, root } = await mount();
    clickByText(host, '.rank-ops__chip', 'Terminal-Bench 2.1');
    expect(rowIds(host)[0]).toBe('gemini-3.8-flash-low');
    const last = [...host.querySelectorAll('.rank-race__row')].at(-1)!;
    expect(last.textContent).toContain('qwen3.8-max');
    expect(last.querySelector('.rank-race__place')!.textContent).toBe('—');
    expect(last.querySelector('.rank-race__score')!.textContent).toBe('—');
    act(() => root.unmount());
  });

  it('o detalhe traz os números, de quem são e a fonte, que abre fora do app', async () => {
    const { host, root } = await mount();
    clickByText(host, '.rank-race__row', 'gpt-6.2-sol');
    const detail = host.querySelector('[aria-label="Modelo selecionado"]')!;
    expect(detail.textContent).toContain('gpt-6.2-sol');
    expect(detail.textContent).toContain('75,2%');
    expect(detail.textContent).toContain('herda a nota de gpt-6.1-sol');
    const link = detail.querySelector<HTMLAnchorElement>('a.settings-link')!;
    expect(link.textContent).toBe('openai.com');
    act(() => link.click());
    expect(openExternal).toHaveBeenCalledWith('https://openai.com/index/introducing-gpt-6-1-sol/');
    act(() => root.unmount());
  });

  it('modelo sem número publicado explica a nota neutra, sem barra nem posição', async () => {
    const { host, root } = await mount();
    clickByText(host, '.rank-race__row', 'qwen3.8-max');
    const detail = host.querySelector('[aria-label="Modelo selecionado"]')!;
    expect(detail.textContent).toContain('não publicou');
    expect(detail.textContent).toContain('nota neutra');
    expect(detail.querySelectorAll('.rank-ops__dim-val')).toHaveLength(0);
    expect(detail.querySelector('.rank-ops__detail-rank')!.textContent).toBe('—');
    act(() => root.unmount());
  });

  it('destaques e faixas usam números reais e logos dos provedores', async () => {
    const { host, root } = await mount();
    const highlights = host.querySelector('[aria-label="Destaques pelos benchmarks publicados"]')!;
    expect(highlights.textContent).toContain('Maior nota geral');
    expect(highlights.textContent).toContain('Melhor em Terminal-Bench 2.1');
    expect(highlights.textContent).toContain('89,4%');
    // Ninguém instalado publicou SWE-bench Verified: sem cartão, nunca zero.
    expect(highlights.textContent).not.toContain('SWE-bench Verified');
    expect(highlights.textContent).toContain('Melhor na faixa Rápido');
    expect(host.querySelectorAll('.rank-missions__card .provider-logo').length).toBeGreaterThan(0);
    expect(host.querySelector('.rank-bands')!.textContent).toContain('gemini-3.8-flash-low');
    act(() => root.unmount());
  });

  it('erro diz o motivo e "Tentar novamente" relê', async () => {
    compare.mockRejectedValueOnce(new Error('Falha de rede'));
    const { host, root } = await mount();
    expect(host.textContent).toContain('Não foi possível carregar a comparação: Falha de rede');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(compare).toHaveBeenCalledTimes(2);
    expect(rowIds(host)).toContain('gpt-6.1-sol');
    act(() => root.unmount());
  });

  it('sem ferramenta instalada oferece ver os modelos das outras', async () => {
    compare.mockResolvedValueOnce({
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry, cli: 'missing' as const })),
    });
    const { host, root } = await mount();
    expect(host.textContent).toContain('Nenhuma ferramenta de IA instalada e ligada');
    clickByText(host, 'button', 'Ver modelos das ferramentas não instaladas');
    expect(rowIds(host)).toHaveLength(5);
    act(() => root.unmount());
  });
});
