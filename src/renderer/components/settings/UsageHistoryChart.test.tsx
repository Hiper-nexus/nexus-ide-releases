/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageHistory } from '../../../shared/usage-types';
import { UsageHistoryChart, type UsageHistoryChartProps } from './UsageHistoryChart';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 8, 15).getTime();
const HISTORY: UsageHistory = {
  since: new Date(2026, 8, 1).getTime(),
  updatedAt: NOW,
  days: [
    { day: '2026-10-06', tokens: 1_200_000, usdEquivalent: 3.4, turns: 12 },
    { day: '2026-10-08', tokens: 300_000, usdEquivalent: 0.9, turns: 3 },
  ],
};

let mounted: { root: Root; host: HTMLElement } | null = null;

function render(patch: Partial<UsageHistoryChartProps> = {}) {
  const props: UsageHistoryChartProps = {
    status: 'ready',
    history: HISTORY,
    now: NOW,
    onRetry: vi.fn(),
    ...patch,
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<UsageHistoryChart {...props} />));
  mounted = { root, host };
  return { host, props };
}

afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted = null;
  document.body.innerHTML = '';
});

const text = (host: HTMLElement) => (host.textContent ?? '').replace(/\s+/g, ' ');

describe('UsageHistoryChart', () => {
  it('desenha uma barra por dia com uso e descreve o gráfico em texto', () => {
    const { host } = render();
    const svg = host.querySelector('svg.usage-history__chart')!;

    expect(host.querySelectorAll('.usage-history__day')).toHaveLength(30);
    expect(host.querySelectorAll('.usage-history__bar')).toHaveLength(2);
    expect(svg.getAttribute('role')).toBe('img');
    const summary = document.getElementById(svg.getAttribute('aria-describedby')!)!;
    expect(summary.textContent).toContain('Total em 30 dias: 1.5M tokens, $4.30 em API, 15 turnos');
    expect(summary.textContent).toContain('2 dias com uso');
    expect(text(host)).toContain('hoje');
  });

  it('a tabela recolhida traz os mesmos números, do dia mais novo ao mais antigo', () => {
    const { host } = render();
    const rows = [...host.querySelectorAll('.usage-history__table tbody tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.slice(1)).toEqual(['300k', '$0.90', '3']);
    expect(rows[1]!.slice(1)).toEqual(['1.2M', '$3.40', '12']);
  });

  it('troca a medida entre tokens e custo em API', () => {
    const { host } = render();
    const [tokens, usd] = [...host.querySelectorAll<HTMLButtonElement>('.usage-history__metric-btn')];
    expect(tokens!.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.usage-history__grid text')?.textContent).toBe('0');

    act(() => usd!.click());
    expect(usd!.getAttribute('aria-pressed')).toBe('true');
    const labels = [...host.querySelectorAll('.usage-history__grid text')].map((node) => node.textContent);
    expect(labels).toEqual(['$0.00', '$2.50', '$5.00']);
  });

  it('setas leem dia a dia; Escape volta ao total', () => {
    const { host } = render();
    const svg = host.querySelector<SVGSVGElement>('svg.usage-history__chart')!;
    const readout = () => host.querySelector('.usage-history__readout')!.textContent ?? '';
    expect(readout()).toContain('em 30 dias');

    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(readout()).toContain('300k tokens · $0.90 em API · 3 turnos');
    expect(host.querySelectorAll('.usage-history__day.is-active')).toHaveLength(1);

    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(readout()).toContain('sem consumo');

    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(readout()).toContain('em 30 dias');
    expect(host.querySelector('.usage-history__day.is-active')).toBeNull();
  });

  it('passar o ponteiro sobre um dia mostra a leitura dele', () => {
    const { host } = render();
    const days = host.querySelectorAll('.usage-history__day');
    act(() => {
      days[27]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(host.querySelector('.usage-history__readout')?.textContent).toContain('1.2M tokens');
  });

  it('carregando: estado anunciado e esqueleto, sem gráfico', () => {
    const { host } = render({ status: 'loading', history: null });
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Carregando o histórico');
    expect(host.querySelector('svg')).toBeNull();
  });

  it('erro: alerta com ação de tentar de novo', () => {
    const { host, props } = render({ status: 'error', history: null });
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Não foi possível carregar o histórico.');
    act(() => alert.querySelector('button')!.click());
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('vazio: ensina de quando o histórico conta e oferece atualizar', () => {
    const { host, props } = render({ history: { ...HISTORY, days: [] } });
    expect(text(host)).toContain('Sem consumo nos últimos 30 dias');
    expect(text(host)).toContain('O histórico conta desde 1 de setembro');
    expect(host.querySelector('.usage-history__metric')).toBeNull();
    act(() =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Atualizar histórico')!.click(),
    );
    expect(props.onRetry).toHaveBeenCalledOnce();
  });
});
