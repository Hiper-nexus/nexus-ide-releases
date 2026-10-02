/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevDecisionsSection } from './JevDecisionsSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];

function mount(node: React.ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ host, root });
  act(() => root.render(node));
  return host;
}

const jev = vi.hoisted(() => ({
  decisionsStats: vi.fn(async () => ({
    totals: { calls: 2, usd: 0.00005, inputTokens: 1200, noAnswer: 1 },
    windows: {
      today: {
        consultations: 2,
        answered: 1,
        noAnswer: 1,
        usd: 0.0000252,
        inputTokens: 600,
      },
      last30d: {
        consultations: 3,
        answered: 2,
        noAnswer: 1,
        usd: 0.00005,
        inputTokens: 1200,
      },
      allTime: {
        consultations: 5,
        answered: 4,
        noAnswer: 1,
        usd: 0.0001,
        inputTokens: 2400,
      },
    },
    bySurface: {
      handoffReview: {
        calls: 2,
        usd: 0.00005,
        noAnswer: 1,
        last30d: { jev: 2, rule: 1, usd: 0.00005 },
        decisions: { ok: 1, retry: 1 },
        feedback: { right: 1, wrong: 0 },
      },
    },
    pricing: { usdPerInputToken: 0.042 / 1e6, source: 'typesafe-published' },
  })),
  decisionsList: vi.fn(async () => [
    {
      id: 'd1',
      at: Date.now(),
      surface: 'handoffReview',
      model: 'jev-1.13.0',
      questions: ['is_specific'],
      probabilities: { is_specific: 0.9 },
      decision: 'ok',
      inputTokens: 600,
      usd: 0.0000252,
    },
  ]),
  decisionsFeedback: vi.fn(async () => ({ ok: true })),
}));

describe('JevDecisionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { jev },
    });
  });

  afterEach(() => {
    for (const { host, root } of mountedRoots.splice(0)) {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('renders totals and the per-surface table', async () => {
    const host = mount(<JevDecisionsSection />);
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain('Decisões dos modelos');
    expect(host.textContent).toContain('2 chamadas');
    expect(host.textContent).toContain('Revisão de handoff');
    expect(host.textContent).toContain('ok ×1');
    expect(host.textContent).toContain('retry ×1');
    expect(host.textContent).toContain('Ainda sem medição de otimização');
  });

  it('shows measured optimization separately from billed tokens', async () => {
    const stats = await jev.decisionsStats();
    Object.assign(stats.windows.last30d, { optimization: {
      observations: 3, jevRequestsAvoided: 2, llmRoutingBypassed: 1,
      contextSelections: 1, contextBytesBefore: 4000, contextBytesAfter: 1000,
    } });
    jev.decisionsStats.mockResolvedValueOnce(stats);
    const host = mount(<JevDecisionsSection />);
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain('Consultas aos modelos evitadas por lote ou reutilização: 2');
    expect(host.textContent).toContain('Triagens resolvidas sem recorrer ao LLM: 1');
    expect(host.textContent).toContain('4.000 → 1.000 bytes');
    expect(host.textContent).toContain('não representam tokens faturados');
  });

  it('renders the consumption block with the three windows', async () => {
    const host = mount(<JevDecisionsSection />);
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain('Consumo dos modelos de decisão');
    expect(host.textContent).toContain('Hoje');
    expect(host.textContent).toContain('30 dias');
    expect(host.textContent).toContain('Desde sempre');
    expect(host.textContent).toContain('2 consultas');
    expect(host.textContent).toContain('3 consultas');
    expect(host.textContent).toContain('5 consultas');
    expect(host.textContent).toContain('1 sem resposta');
    expect(host.textContent).toContain('Jev US$ 0,042');
    expect(host.textContent).toContain('Clef US$ 0,24');
    expect(host.textContent).toContain('2 pelo modelo · 1 pela regra');
    // Custo miúdo (0.0000252) não vira "US$ 0.0000": mostra o teto.
    expect(host.textContent).toContain('< US$ 0,0001');
    // 0.0001 exato segue no formato de 4 casas.
    expect(host.textContent).toContain('US$ 0.0001');
  });

  it('never prints a fabricated floor for unmeasured usage, and counts legacy rows apart', async () => {
    const stats: any = await jev.decisionsStats();
    stats.byModel = {
      'jev-1.13.0': { calls: 4, noAnswer: 0, inputTokens: 0, usd: 0.5, requests: null, durationMs: null, measuredRows: 0, legacyRows: 4 },
      clef: { calls: 0, noAnswer: 2, inputTokens: 0, usd: 0, requests: 2, durationMs: 10, measuredRows: 2, legacyRows: 0, incompleteUsageCalls: 2 },
      'clef-flash': { calls: 3, noAnswer: 0, inputTokens: 90, usd: 0.01, requests: 5, durationMs: 30, measuredRows: 3, legacyRows: 2, incompleteUsageCalls: 1 },
    };
    jev.decisionsStats.mockResolvedValueOnce(stats);
    const host = mount(<JevDecisionsSection />);
    await act(async () => Promise.resolve());
    const rows = Object.fromEntries([...host.querySelectorAll('table[aria-label="Consumo por modelo"] tbody tr')]
      .map(row => [row.querySelector('td')!.textContent!, [...row.querySelectorAll('td')].map(cell => cell.textContent!)]));
    expect(rows['jev-1.13.0'][4]).toContain('Sem medição');
    expect(rows['jev-1.13.0'][4]).toContain('4 linhas antigas');
    expect(rows.clef[2]).toBe('Sem medição');
    expect(rows.clef[2]).not.toContain('≥');
    expect(rows['clef-flash'][2]).toContain('≥ US$ 0.0100');
    expect(rows['clef-flash'][4]).toContain('5');
    expect(rows['clef-flash'][4]).toContain('2 linhas antigas');
    expect(host.textContent).not.toContain('≥ US$ 0.0000');
  });

  it('labels an internal failure instead of calling it a rule decision with no reason', async () => {
    jev.decisionsList.mockResolvedValueOnce([{ id: 'n1', at: Date.now(), kind: 'no-answer', reason: 'internal-error', surface: 'intake',
      model: 'jev-1.13.0', questions: [], probabilities: {}, decision: 'rule', inputTokens: null, usd: null }] as never);
    const host = mount(<JevDecisionsSection />);
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain('erro interno');
  });

  it('lists decisions and sends feedback', async () => {
    const host = mount(<JevDecisionsSection />);
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain('is_specific 0.90');
    const right = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Certo',
    );
    expect(right).toBeTruthy();
    await act(async () => {
      right!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(jev.decisionsFeedback).toHaveBeenCalledWith({
      id: 'd1',
      verdict: 'right',
    });
  });

  it('labels the surface columns and keeps the verdict legible as a pill', async () => {
    const host = mount(<JevDecisionsSection />);
    await act(async () => Promise.resolve());

    const head = host.querySelector('.jev-table__head');
    expect(head).toBeTruthy();
    expect(head!.textContent).toContain('Superfície');
    expect(head!.textContent).toContain('Custo');
    expect(head!.textContent).toContain('Feedback');

    const votes = [...host.querySelectorAll('.jev-vote__btn')];
    expect(votes.length).toBeGreaterThan(0);
    expect(votes.every((btn) => btn.querySelector('.pixel-icon'))).toBe(true);
  });
});
