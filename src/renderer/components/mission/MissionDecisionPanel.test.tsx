/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionMissionPanel, DecisionMissionPanelResult } from '../../../shared/decision-engine-ui';
import { MISSION_DECISION_REFRESH_MS, MissionDecisionPanel } from './MissionDecisionPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let response: DecisionMissionPanelResult | Error;
const ROUTE = { provider: 'luna' as const, model: 'gpt-6-luna', policyVersion: 'decision-engine-v2' as const, evidence: 'prior' as const,
  reason: 'auto v2 · prior de julgamento' };
const AT = new Date(2026, 9, 11, 14, 5).getTime();

function panel(patch: Partial<DecisionMissionPanel> = {}): DecisionMissionPanel {
  return { ok: true, missionId: 'mission-a', mode: 'auto', budgetUsd: 0.5, chargedUsd: 0.12, reservedUsd: 0, usd: 0.0004, calls: 4, noAnswer: 1,
    budgetRefusals: 0, ratio: 0.24, byProvider: { jev: { calls: 3, noAnswer: 1, usd: 0.0003 }, luna: { calls: 1, noAnswer: 0, usd: 0.0001 } },
    hints: {
      kickoff: { at: AT, model: 'jev-1', usd: 0.00001, probabilities: {}, origin: 'conventional', complexity: 2.1,
        complexityLevel: 'medium', workers: 2, maxWorkers: 4, lane: 'standard', laneConfidence: 0.8 },
      reviewTriage: [{ at: AT, model: 'gpt-6-luna', route: ROUTE, usd: 0.0001, probabilities: {}, handoffId: 'hoff-1234567890abcdef',
        regressionRisk: 0.72, recommendIndependentReview: true }],
      recovery: [{ at: AT, model: 'jev-1', usd: null, probabilities: {}, triggerClass: 'rate-limit', advice: 'switch-cli', confidence: 0.7 }],
      completion: { at: AT, model: 'jev-1', usd: null, probabilities: {}, coverage: 0.35, warning: true, handoffCount: 2, signature: 's',
        consultations: 1, missing: 'testes passam', finalAudit: { at: AT, reused: true } },
    }, ...patch };
}

const bridge = () => (window.nexus as any).decisionModels.missionPanel as ReturnType<typeof vi.fn>;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

async function mount(version = 1, missionId = 'mission-a') {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<MissionDecisionPanel missionId={missionId} version={version} />); });
  await flush();
}
async function rerender(version: number, missionId = 'mission-a') {
  await act(async () => { root.render(<MissionDecisionPanel missionId={missionId} version={version} />); });
}

beforeEach(() => {
  response = panel();
  Object.defineProperty(window, 'nexus', { configurable: true, value: { decisionModels: {
    missionPanel: vi.fn(async () => { if (response instanceof Error) throw response; return response; }),
  } } });
});
afterEach(() => { vi.useRealTimers(); if (root) act(() => root.unmount()); host?.remove(); });

describe('F-1167: painel "Motor de decisão" da missão', () => {
  it('pede só a missão aberta; mostra gasto, orçamento, % e chamadas por provedor', async () => {
    await mount();
    expect(bridge()).toHaveBeenCalledWith('mission-a');
    const text = host.textContent ?? '';
    expect(text).toContain('US$ 0,1200 de US$ 0,5000');
    expect(text).toContain('(24%)');
    expect(text).toContain('4 respondidas · 1 sem resposta');
    expect(text).toContain('Jev: 3 chamadas · US$ 0,0003');
    expect(text).toContain('Luna: 1 chamada · US$ 0,0001');
    expect(text).toContain('Automático: custo × qualidade');
    expect(host.querySelector('.mission-decision__budget--ok')).not.toBeNull();
  });

  it('dicas com rota (modelo) e horário: kickoff, triagem, recuperação e cobertura/auditoria', async () => {
    await mount();
    const hints = [...host.querySelectorAll('[aria-label="Dicas do motor de decisão"] li')].map(node => node.textContent);
    expect(hints).toHaveLength(4);
    expect(hints[0]).toContain('Complexidade média · 2 workers · trilha padrão');
    expect(hints[0]).toContain('jev-1 · 14:05');
    expect(hints[1]).toContain('Risco de regressão 72%: revisão independente sugerida');
    expect(hints[1]).toContain('Luna · gpt-6-luna · 14:05 · entrega hoff-1234567');
    expect(hints[2]).toContain('Queda por limite de taxa: trocar de CLI');
    expect(hints[3]).toContain('35%: parece faltar: testes passam');
    expect(hints[3]).toContain('auditoria final às 14:05 (sem nova consulta)');
    // Cor só para estado: atenção na triagem alta e na cobertura baixa.
    expect(host.querySelectorAll('.mission-decision__hint--attention')).toHaveLength(2);
    expect(host.querySelector('[title="auto v2 · prior de julgamento"]')).not.toBeNull();
  });

  it('orçamento: âmbar acima de 80%, vermelho em 100%', async () => {
    response = panel({ chargedUsd: 0.42, ratio: 0.84 });
    await mount();
    expect(host.querySelector('.mission-decision__budget--attention')?.textContent).toBe('(84%)');
    expect(host.textContent).toContain('No Automático, só o modelo mais barato responde.');
    act(() => root.unmount()); host.remove();
    response = panel({ chargedUsd: 0.5, ratio: 1, budgetRefusals: 2 });
    await mount();
    expect(host.querySelector('.mission-decision__budget--alert')?.textContent).toBe('(100%)');
    expect(host.textContent).toContain('2 recusadas pelo orçamento');
    expect(host.textContent).toContain('Orçamento esgotado: o Automático parou de consultar nesta missão; as checagens fixas no Jev continuam e só entram na conta.');
    expect(host.textContent).not.toContain('o motor parou de consultar');
    // Modelo fixo: o orçamento não recusa nada.
    act(() => root.unmount()); host.remove();
    response = panel({ mode: 'jev', chargedUsd: 0.6, ratio: 1.2 });
    await mount();
    expect(host.textContent).toContain('Modelo fixo: o orçamento só contabiliza, não bloqueia.');
    expect(host.textContent).not.toContain('Orçamento esgotado');
  });

  it('consultas em andamento aparecem à parte do cobrado', async () => {
    response = panel({ chargedUsd: 0.1, reservedUsd: 0.02, ratio: 0.24 });
    await mount();
    expect(host.textContent).toContain('US$ 0,1000 de US$ 0,5000');
    expect(host.textContent).toContain('+ US$ 0,0200 em consultas em andamento.');
  });

  it('vazio: sem chamadas e sem dicas; modelo fixo explica que o motor só contabiliza', async () => {
    response = panel({ mode: 'jev', chargedUsd: 0, usd: 0, calls: 0, noAnswer: 0, ratio: 0, byProvider: {}, hints: null });
    await mount();
    expect(host.textContent).toContain('Nenhuma chamada ainda.');
    expect(host.textContent).toContain('Nenhuma dica ainda.');
    expect(host.textContent).toContain('Somente Jev: modelo fixo, o motor só contabiliza');
  });

  it('carregando e depois erro, com "Tentar de novo"', async () => {
    let release!: (value: DecisionMissionPanelResult) => void;
    bridge().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await mount();
    expect(host.querySelector('[aria-label="Motor de decisão"]')!.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).toContain('Carregando…');
    await act(async () => { release({ ok: false, reason: 'not-found' }); });
    await flush();
    expect(host.textContent).toContain('Não consegui ler o motor de decisão desta missão.');
    response = panel();
    await act(async () => { [...host.querySelectorAll('button')].find(node => node.textContent?.includes('Tentar de novo'))!.click(); });
    await flush();
    expect(host.textContent).toContain('Gasto de decisão');
  });

  it('exceção do IPC vira estado de erro, sem quebrar o inspetor', async () => {
    response = new Error('ipc');
    await mount();
    expect(host.textContent).toContain('Não consegui ler o motor de decisão desta missão.');
  });

  it('refresh leve: missão muda → puxa de novo, no máximo a cada 15 s; sem polling parado', async () => {
    vi.useFakeTimers();
    await mount(1);
    expect(bridge()).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(MISSION_DECISION_REFRESH_MS * 3); });
    expect(bridge()).toHaveBeenCalledTimes(1);
    await rerender(2);
    await rerender(3);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(bridge()).toHaveBeenCalledTimes(2);
    await rerender(4);
    await act(async () => { vi.advanceTimersByTime(MISSION_DECISION_REFRESH_MS - 2_000); });
    expect(bridge()).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(bridge()).toHaveBeenCalledTimes(3);
  });

  it('trocar de missão pede a nova e nunca mostra dados da anterior', async () => {
    await mount(1, 'mission-a');
    let release!: (value: DecisionMissionPanelResult) => void;
    bridge().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await rerender(1, 'mission-b');
    expect(bridge()).toHaveBeenLastCalledWith('mission-b');
    expect(host.textContent).toContain('Carregando…');
    expect(host.textContent).not.toContain('Gasto de decisão');
    await act(async () => { release(panel({ missionId: 'mission-b', hints: null })); });
    await flush();
    expect(host.textContent).toContain('Nenhuma dica ainda.');
  });

  it('sem a ponte (versão antiga do Main) não renderiza nada', async () => {
    Object.defineProperty(window, 'nexus', { configurable: true, value: {} });
    await mount();
    expect(host.innerHTML).toBe('');
  });
});
