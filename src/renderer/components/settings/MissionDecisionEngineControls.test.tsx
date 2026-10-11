/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionSettings } from '../../../shared/decision-models';
import type { DecisionCalibrationPlan, DecisionCalibrationResult } from '../../../shared/decision-engine-ui';
import { JEV_SURFACES_CHANGED_EVENT, MissionDecisionEngineControls } from './MissionDecisionEngineControls';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const DAY = 24 * 60 * 60 * 1000;

let host: HTMLDivElement;
let root: Root;
let orch: Record<string, any>;
let onChange: ReturnType<typeof vi.fn<(patch: Partial<DecisionSettings>) => void>>;
let plan: DecisionCalibrationPlan;
let calibration: DecisionCalibrationResult | Error;

const base = (patch: Partial<DecisionSettings> = {}): DecisionSettings =>
  ({ mode: 'auto', clefModel: 'clef', cloudflareAccountId: '', visionEnabled: false, ...patch });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

async function mount(settings = base(), busy = false) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<MissionDecisionEngineControls settings={settings} busy={busy} onChange={onChange} />); });
  await flush();
}
const toggle = () => host.querySelector<HTMLInputElement>('input[aria-label="Motor de decisão em toda missão"]')!;
const budget = () => host.querySelector<HTMLInputElement>('input[aria-label="Orçamento por missão (US$)"]')!;
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
function type(value: string) {
  const input = budget();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const bridge = () => window.nexus as unknown as {
  settings: Record<'orchGet' | 'orchSet', ReturnType<typeof vi.fn>>;
  decisionModels: Record<'calibrationPlan' | 'calibrate', ReturnType<typeof vi.fn>>;
};

beforeEach(() => {
  orch = { jevAutopilot: true, jevSurfaces: { handoffReview: true, missionKickoff: true, reviewTriage: true, recoveryAdvice: true, completionCheck: true } };
  onChange = vi.fn<(patch: Partial<DecisionSettings>) => void>();
  plan = { ok: true, cases: 20, runnable: true, estimatedUsd: 0.0021, models: [
    { model: 'jev', available: true, estimatedTokens: 1500, estimatedUsd: 0.00006, measuredAt: null },
    { model: 'clef', available: true, estimatedTokens: 1500, estimatedUsd: 0.00036, measuredAt: Date.now() - 2 * DAY },
    { model: 'luna', available: false, estimatedTokens: 1500, estimatedUsd: 0.00015, measuredAt: Date.now() - 45 * DAY },
  ] };
  calibration = { ok: true, written: true, models: [
    { model: 'jev', skipped: false, answered: 20, failures: 0, accuracy: 0.85, p95Ms: 1200, usd: 0.00005, measuredAt: Date.now() },
    { model: 'luna', skipped: true, answered: 0, failures: 0, accuracy: null, p95Ms: null, usd: 0, measuredAt: Date.now() - 45 * DAY },
  ] };
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    settings: {
      orchGet: vi.fn(async () => structuredClone(orch)),
      // Espelha a mescla do Main: jevSurfaces parcial entra no objeto atual.
      orchSet: vi.fn(async (patch: Record<string, any>) => {
        orch = { ...orch, ...patch, ...(patch.jevSurfaces ? { jevSurfaces: { ...orch.jevSurfaces, ...patch.jevSurfaces } } : {}) };
        return structuredClone(orch);
      }),
    },
    decisionModels: {
      calibrationPlan: vi.fn(async () => plan),
      calibrate: vi.fn(async () => { if (calibration instanceof Error) throw calibration; return calibration; }),
      cancelCalibration: vi.fn(async () => ({ ok: true, cancelRequested: true })),
    },
  } });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); });

describe('F-1167: chave "Motor de decisão em toda missão"', () => {
  it('padrão ligado; mostra orçamento e a explicação do Automático vs modelo fixo', async () => {
    orch = { jevAutopilot: true, jevSurfaces: {} };
    await mount();
    expect(toggle().checked).toBe(true);
    expect(budget().value).toBe('0,50');
    expect(host.textContent).toContain('No Automático, o motor escolhe o modelo por custo e qualidade');
    expect(host.textContent).toContain('Jev, Clef, Luna ou Juntos fixam o modelo: o motor só contabiliza o gasto');
    expect(host.textContent).toContain('as checagens de segurança ficam no Jev');
    // P2-4: o teto só recusa no Automático; o fixo no Jev continua e só conta.
    expect(host.textContent).toContain('param as consultas que o Automático escolhe');
    expect(host.textContent).toContain('As checagens fixas no Jev continuam e só entram na conta.');
    expect(host.textContent).not.toContain('o motor para de consultar');
  });

  it('desligar manda SÓ as quatro fases (o Main mescla); o que a outra tela gravou fica', async () => {
    await mount();
    orch = { ...orch, jevSurfaces: { ...orch.jevSurfaces, paneState: false } };
    const heard = vi.fn();
    window.addEventListener(JEV_SURFACES_CHANGED_EVENT, heard);
    const reads = bridge().settings.orchGet.mock.calls.length;
    await act(async () => { toggle().click(); });
    await flush();
    window.removeEventListener(JEV_SURFACES_CHANGED_EVENT, heard);
    const patch = bridge().settings.orchSet.mock.calls[0]![0];
    expect(patch).toEqual({ jevSurfaces: { missionKickoff: false, reviewTriage: false, recoveryAdvice: false, completionCheck: false } });
    expect(bridge().settings.orchGet.mock.calls.length).toBe(reads);
    expect(orch.jevSurfaces).toMatchObject({ paneState: false, handoffReview: true, missionKickoff: false });
    expect(toggle().checked).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ paneState: false, missionKickoff: false });
  });

  it('ligado em parte avisa e ligar liga as quatro', async () => {
    orch.jevSurfaces.reviewTriage = false;
    await mount();
    expect(toggle().checked).toBe(false);
    expect(host.textContent).toContain('Ligado só em parte: 3 de 4 fases');
    await act(async () => { toggle().click(); });
    await flush();
    expect(bridge().settings.orchSet.mock.calls[0]![0].jevSurfaces).toMatchObject({ missionKickoff: true, reviewTriage: true,
      recoveryAdvice: true, completionCheck: true });
  });

  it('piloto automático desligado: avisa que o motor não consulta', async () => {
    orch.jevAutopilot = false;
    await mount();
    expect(host.textContent).toContain('O piloto automático está desligado');
  });

  it('falha ao salvar mostra erro e mantém o estado', async () => {
    await mount();
    bridge().settings.orchSet.mockRejectedValueOnce(new Error('disco'));
    await act(async () => { toggle().click(); });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Não consegui salvar');
    expect(toggle().checked).toBe(true);
  });
});

describe('F-1167: orçamento por missão', () => {
  it('aceita vírgula e salva no blur pela configuração de modelos', async () => {
    await mount();
    await act(async () => { type('1,25'); });
    await act(async () => { budget().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith({ missionBudgetUsd: 1.25 });
  });

  it('rejeita fora de 0–20 e texto inválido, marca o campo e não salva', async () => {
    await mount();
    for (const value of ['21', '-1', 'abc', '0,5,1', '']) {
      await act(async () => { type(value); });
      await act(async () => { budget().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Use um valor de US$ 0 a US$ 20');
      expect(budget().getAttribute('aria-invalid')).toBe('true');
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('mesmo valor não regrava; o valor salvo aparece formatado', async () => {
    await mount(base({ missionBudgetUsd: 2 }));
    expect(budget().value).toBe('2,00');
    await act(async () => { budget().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('F-1167: botão "Calibrar modelos"', () => {
  it('mostra o custo estimado antes; só calibra ao confirmar; mostra resultado por modelo', async () => {
    await mount();
    await act(async () => { button('Calibrar modelos')!.click(); });
    await flush();
    expect(bridge().decisionModels.calibrate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('20 casos em 2 modelos');
    expect(host.textContent).toContain('Custo estimado: US$ 0,0021');
    expect(host.textContent).toContain('Sem credencial, pulados: Luna (beta). A medição anterior deles continua valendo.');
    expect(host.querySelector('.decision-calibration__stale')?.textContent).toBe('Medição antiga (mais de 30 dias): Luna (beta).');
    await act(async () => { button('Calibrar agora')!.click(); });
    await flush();
    expect(bridge().decisionModels.calibrate).toHaveBeenCalledTimes(1);
    const table = host.querySelector('table[aria-label="Resultado da calibração"]')!;
    expect(table.textContent).toContain('85%');
    expect(table.textContent).toContain('1,2 s');
    expect(table.textContent).toContain('Pulado: sem credencial');
    expect(table.querySelector('.decision-calibration__stale')?.textContent).toContain('(antiga)');
    expect(table.querySelectorAll('.decision-calibration__stale')).toHaveLength(1);
    expect(host.textContent).toContain('O Automático já usa estas medições');
  });

  it('cancelar não calibra', async () => {
    await mount();
    await act(async () => { button('Calibrar modelos')!.click(); });
    await flush();
    await act(async () => { button('Cancelar')!.click(); });
    expect(bridge().decisionModels.calibrate).not.toHaveBeenCalled();
    expect(button('Calibrar agora')).toBeUndefined();
  });

  it('fora do Automático o botão fica desligado e explica', async () => {
    await mount(base({ mode: 'jev' }));
    expect(button('Calibrar modelos')!.disabled).toBe(true);
    expect(host.textContent).toContain('A calibração roda no modo Automático.');
  });

  it('erro da calibração (resposta ou exceção) vira mensagem e a tela segue', async () => {
    calibration = { ok: false, error: 'Nenhum modelo com credencial para calibrar.' };
    await mount();
    await act(async () => { button('Calibrar modelos')!.click(); });
    await flush();
    await act(async () => { button('Calibrar agora')!.click(); });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Nenhum modelo com credencial para calibrar.');
    calibration = new Error('ipc');
    await act(async () => { button('Calibrar modelos')!.click(); });
    await flush();
    await act(async () => { button('Calibrar agora')!.click(); });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('A calibração falhou. Nada foi alterado.');
    expect(button('Calibrar modelos')!.disabled).toBe(false);
  });

  it('plano sem credencial não abre a confirmação', async () => {
    plan = { ...plan, runnable: false, reason: 'no-credential' };
    await mount();
    await act(async () => { button('Calibrar modelos')!.click(); });
    await flush();
    expect(button('Calibrar agora')).toBeUndefined();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Nenhum modelo com credencial para calibrar.');
  });

  it('P3: "Cancelar calibração" pede o cancelamento e o aviso não é erro', async () => {
    let release!: (value: DecisionCalibrationResult) => void;
    bridge().decisionModels.calibrate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await mount();
    await act(async () => { button('Calibrar modelos')!.click(); });
    await flush();
    await act(async () => { button('Calibrar agora')!.click(); });
    await act(async () => { button('Cancelar calibração')!.click(); });
    expect((bridge().decisionModels as any).cancelCalibration).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Cancelando…');
    expect(button('Cancelar calibração')!.disabled).toBe(true);
    await act(async () => { release({ ok: false, cancelled: true, error: 'Calibração cancelada. As medições anteriores continuam valendo.' }); });
    await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('Calibração cancelada. As medições anteriores continuam valendo.');
    expect(button('Calibrar modelos')!.disabled).toBe(false);
  });

  it('enquanto calibra: carregando, sem segundo disparo', async () => {
    let release!: (value: DecisionCalibrationResult) => void;
    bridge().decisionModels.calibrate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await mount();
    await act(async () => { button('Calibrar modelos')!.click(); });
    await flush();
    await act(async () => { button('Calibrar agora')!.click(); });
    expect(button('Calibrando…')!.disabled).toBe(true);
    expect(host.querySelector('.decision-calibration')!.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).toContain('Calibrando. Pode levar alguns minutos.');
    await act(async () => { release(calibration as DecisionCalibrationResult); });
    await flush();
    expect(bridge().decisionModels.calibrate).toHaveBeenCalledTimes(1);
  });
});
