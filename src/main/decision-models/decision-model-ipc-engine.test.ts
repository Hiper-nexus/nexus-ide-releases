import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../persistence/secrets-store', () => ({
  getSecret: () => null, hasSecret: () => false,
  setSecret: () => ({ ok: true }), isSecureStorageAvailable: () => true,
}));

const journal = vi.hoisted(() => ({ usage: vi.fn(async (_id: string) => undefined as unknown), stats: vi.fn(), spend: vi.fn(async () => ({})) }));
vi.mock('../jev/jev-decision-log', async importOriginal => ({
  ...(await importOriginal<typeof import('../jev/jev-decision-log')>()),
  jevMissionUsage: journal.usage, jevDecisionStats: journal.stats, jevMissionChargedSpend: journal.spend,
}));

import { bindTrustedMainWindow } from '../security/trusted-ipc';
import { registerDecisionModelIpc } from './decision-model-ipc';
import { DECISION_CALIBRATION_CASES } from './decision-calibration-cases';
import type { DecisionEvalReport } from './decision-evaluation';
import type { DecisionSettings } from '../../shared/decision-models';
import type { MissionDecisionHints } from '../../shared/orch-types';

function trustedEvent() {
  const sender = { getURL: () => 'nexus-app://bundle/index.html', isDestroyed: () => false,
    isCrashed: () => false, once: () => {}, mainFrame: {} };
  bindTrustedMainWindow({ webContents: sender, isDestroyed: () => false } as any, 'nexus-app://bundle/index.html');
  return { sender, senderFrame: sender.mainFrame };
}

const settings = (mode: DecisionSettings['mode'] = 'auto', missionBudgetUsd?: number): DecisionSettings =>
  ({ mode, clefModel: 'clef', cloudflareAccountId: '', visionEnabled: false, ...(missionBudgetUsd !== undefined ? { missionBudgetUsd } : {}) });

function report(models: string[]): DecisionEvalReport {
  const observations = models.flatMap(model => DECISION_CALIBRATION_CASES.map((testCase, index) => ({
    caseId: testCase.id, surface: testCase.surface, split: testCase.split, requestedModel: model as never,
    status: 'answered' as const, correct: index % 4 !== 0, consequential: false, durationMs: 100 + index * 10, usd: 0.00001, inputTokens: 200,
  })));
  const score = { answered: 20, failures: 0, unsupported: 0, usd: 0.0002, p50Ms: 190, p95Ms: 290,
    development: { cases: 10, correct: 8, accuracy: 0.8, consequentialErrors: 0 }, heldout: { cases: 10, correct: 7, accuracy: 0.7, consequentialErrors: 0 } };
  const empty = { answered: 0, failures: 0, unsupported: 0, usd: 0, p50Ms: null, p95Ms: null,
    development: { cases: 0, correct: 0, accuracy: null, consequentialErrors: 0 }, heldout: { cases: 0, correct: 0, accuracy: null, consequentialErrors: 0 } };
  return { observations, models: Object.fromEntries(['jev', 'clef', 'clef-flash', 'clef-omni', 'luna']
    .map(model => [model, models.includes(model) ? score : empty])) as DecisionEvalReport['models'] };
}

describe('F-1167: calibração por IPC', () => {
  beforeEach(() => { handlers.clear(); });

  it('o plano mostra o custo estimado só de quem tem credencial e nunca chama provedor', () => {
    const calibrate = vi.fn();
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: false, luna: true }), calibrate });
    const plan = handlers.get('decisionModels:calibrationPlan')!(trustedEvent());
    expect(plan).toMatchObject({ ok: true, cases: DECISION_CALIBRATION_CASES.length, runnable: true });
    expect(plan.models.filter((row: { available: boolean }) => row.available).map((row: { model: string }) => row.model)).toEqual(['jev', 'luna']);
    const runnable = plan.models.filter((row: { available: boolean }) => row.available);
    expect(plan.estimatedUsd).toBeCloseTo(runnable.reduce((sum: number, row: { estimatedUsd: number }) => sum + row.estimatedUsd, 0), 12);
    expect(plan.estimatedUsd).toBeGreaterThan(0);
    expect(calibrate).not.toHaveBeenCalled();
  });

  it('fora do Automático ou sem credencial o plano não é executável', () => {
    registerDecisionModelIpc({ decisionSettings: () => settings('jev'), availability: () => ({ jev: true, clef: true, luna: true }) });
    expect(handlers.get('decisionModels:calibrationPlan')!(trustedEvent())).toMatchObject({ runnable: false, reason: 'mode' });
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: false, clef: false, luna: false }) });
    expect(handlers.get('decisionModels:calibrationPlan')!(trustedEvent())).toMatchObject({ runnable: false, reason: 'no-credential' });
  });

  it('allowlist: calibrar exige { confirm: true } exato; payload estranho não roda', async () => {
    const calibrate = vi.fn(async () => ({ ok: true, written: true, report: report(['jev']) }));
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: false, luna: false }), calibrate });
    for (const raw of [undefined, {}, { confirm: 'true' }, { confirm: true, cases: [] }, { confirm: true, models: ['luna'] },
      { cancel: false }, { cancel: true, confirm: true }]) {
      expect(await handlers.get('decisionModels:calibrate')!(trustedEvent(), raw)).toEqual({ ok: false, error: 'Pedido de calibração inválido.' });
    }
    expect(calibrate).not.toHaveBeenCalled();
    expect(handlers.get('decisionModels:calibrationPlan')!(trustedEvent(), { anything: 1 })).toMatchObject({ ok: false, runnable: false });
  });

  it('pula modelos sem credencial e devolve acerto, p95 e custo por modelo', async () => {
    const calibrate = vi.fn(async (_cases: unknown, _deps?: { models?: readonly string[]; signal?: AbortSignal }) => ({ ok: true, written: true, report: report(['jev', 'luna']),
      table: { version: 1 as const, generatedAt: 50, source: 'evaluateDecisionCases' as const, models: { jev: { accuracy: 0.75, cases: 20, generatedAt: 50 }, clef: { accuracy: 0.8, cases: 20, generatedAt: 7 } }, surfaces: {} } }));
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: false, luna: true }), calibrate });
    const result = await handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true });
    expect(calibrate).toHaveBeenCalledTimes(1);
    expect(calibrate.mock.calls[0]![0]).toBe(DECISION_CALIBRATION_CASES);
    expect(calibrate.mock.calls[0]![1]).toMatchObject({ models: ['jev', 'luna'] });
    expect((calibrate.mock.calls[0]![1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    const byModel = Object.fromEntries(result.models.map((row: { model: string }) => [row.model, row]));
    const expected = DECISION_CALIBRATION_CASES.filter((_, index) => index % 4 !== 0).length / DECISION_CALIBRATION_CASES.length;
    expect(byModel.jev).toMatchObject({ skipped: false, p95Ms: 290, usd: 0.0002, measuredAt: 50 });
    expect(byModel.jev.accuracy).toBeCloseTo(expected, 10);
    // Pulado mantém a medição antiga (mescla), com a data dela.
    expect(byModel.clef).toMatchObject({ skipped: true, accuracy: null, measuredAt: 7 });
    expect(byModel.luna).toMatchObject({ measuredAt: null });
    expect(byModel['clef-omni']).toMatchObject({ skipped: true });
  });

  it('erro da calibração não lança: vira mensagem; fora do Automático nem chama', async () => {
    const calibrate = vi.fn(async () => { throw new Error('rede caiu'); });
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: true, luna: true }), calibrate });
    await expect(handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true }))
      .resolves.toEqual({ ok: false, error: 'A calibração falhou. Nada foi alterado.' });
    const never = vi.fn();
    registerDecisionModelIpc({ decisionSettings: () => settings('clef'), availability: () => ({ jev: true, clef: true, luna: true }), calibrate: never });
    expect(await handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true })).toEqual({ ok: false, error: 'A calibração só roda no modo Automático.' });
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: false, clef: false, luna: false }), calibrate: never });
    expect(await handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true })).toEqual({ ok: false, error: 'Nenhum modelo com credencial para calibrar.' });
    expect(never).not.toHaveBeenCalled();
  });

  it('uma calibração por vez', async () => {
    let release!: () => void;
    const calibrate = vi.fn(() => new Promise<any>(resolve => { release = () => resolve({ ok: true, written: true, report: report(['jev']) }); }));
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: false, luna: false }), calibrate });
    const first = handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true });
    await Promise.resolve();
    expect(await handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true })).toEqual({ ok: false, error: 'A calibração já está rodando.' });
    release();
    expect((await first).ok).toBe(true);
    expect(calibrate).toHaveBeenCalledTimes(1);
  });

  it('cancelar aborta a calibração em curso, não grava e devolve aviso (não erro)', async () => {
    let seen: AbortSignal | undefined;
    const calibrate = vi.fn((_cases: unknown, deps?: { signal?: AbortSignal }) => new Promise<any>(resolve => {
      seen = deps?.signal;
      deps?.signal?.addEventListener('abort', () => resolve({ ok: true, written: false, report: report(['jev']), table: null, aborted: true }));
    }));
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: false, luna: false }), calibrate });
    expect(await handlers.get('decisionModels:calibrate')!(trustedEvent(), { cancel: true })).toEqual({ ok: true, cancelRequested: false });
    const running = handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true });
    await Promise.resolve(); await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    const cancelled = handlers.get('decisionModels:calibrate')!(trustedEvent(), { cancel: true });
    // Enquanto a cancelada termina (mesmo tique), um novo pedido vê "Cancelando…", não "já está rodando".
    const again = handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true });
    expect(await cancelled).toEqual({ ok: true, cancelRequested: true });
    expect(seen?.aborted).toBe(true);
    expect(await again).toEqual({ ok: false, cancelling: true, error: 'Cancelando a calibração anterior…' });
    expect(await running).toEqual({ ok: false, cancelled: true, error: 'Calibração cancelada. As medições anteriores continuam valendo.' });
    // Depois do cancelamento a trava é solta.
    calibrate.mockImplementationOnce(async () => ({ ok: true, written: true, report: report(['jev']), table: null }) as any);
    expect((await handlers.get('decisionModels:calibrate')!(trustedEvent(), { confirm: true })).ok).toBe(true);
  });

  it('o plano traz a data da medição em vigor de cada modelo', () => {
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: false, luna: false }),
      qualityTable: () => ({ version: 1, generatedAt: 10, source: 'evaluateDecisionCases', models: { jev: { accuracy: 0.9, cases: 9 },
        luna: { accuracy: 0.8, cases: 9, generatedAt: 4 } }, surfaces: {} }) });
    const plan = handlers.get('decisionModels:calibrationPlan')!(trustedEvent());
    const byModel = Object.fromEntries(plan.models.map((row: { model: string }) => [row.model, row]));
    expect(byModel.jev.measuredAt).toBe(10);
    expect(byModel.luna.measuredAt).toBe(4);
    expect(byModel.clef.measuredAt).toBeNull();
  });

  it('página não registrada não calibra', () => {
    const calibrate = vi.fn();
    registerDecisionModelIpc({ decisionSettings: () => settings('auto'), availability: () => ({ jev: true, clef: true, luna: true }), calibrate });
    const event = trustedEvent();
    expect(() => handlers.get('decisionModels:calibrate')!({ ...event, senderFrame: {} }, { confirm: true })).toThrow('não autorizado');
    expect(calibrate).not.toHaveBeenCalled();
  });
});

describe('F-1167: painel da missão por IPC (só leitura, escopo do renderer)', () => {
  beforeEach(() => { handlers.clear(); });
  const hints: MissionDecisionHints = { kickoff: { at: 1, model: 'jev-1', usd: 0.00001, probabilities: {}, origin: 'pane',
    complexity: 2, complexityLevel: 'medium', workers: 2, maxWorkers: 4, lane: 'standard', laneConfidence: 0.8 } };
  const stats = { calls: 3, noAnswer: 1, budgetRefusals: 1, usd: 0.0003, chargedUsd: 0.4, inputTokens: 900, incompleteUsage: 0,
    byProvider: { jev: { calls: 2, noAnswer: 1, usd: 0.0002 }, luna: { calls: 1, noAnswer: 0, usd: 0.0001 } } };

  const book = (spentUsd = 0.4, reservedUsd = 0) => vi.fn(async () => ({ spentUsd, reservedUsd }));

  it('valida o missionId antes de qualquer leitura', async () => {
    const missionInScope = vi.fn(async () => true);
    const missionStats = vi.fn(async () => stats);
    registerDecisionModelIpc({ missionInScope, missionUsage: missionStats, budgetBook: book(), missionHints: () => hints, decisionSettings: () => settings('auto') });
    for (const raw of [undefined, 'mission-a', { missionId: '' }, { missionId: 42 }, { missionId: '   ' }, { missionId: 'm', extra: 1 },
      { missionId: 'x'.repeat(300) }]) {
      expect(await handlers.get('decisionModels:missionPanel')!(trustedEvent(), raw)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(missionInScope).not.toHaveBeenCalled();
    expect(missionStats).not.toHaveBeenCalled();
  });

  it('missão de outro workspace (ou sem escopo) responde not-found sem ler gasto nem dicas', async () => {
    const missionStats = vi.fn(async () => stats);
    const missionHints = vi.fn(() => hints);
    const budgetBook = book();
    registerDecisionModelIpc({ missionInScope: async () => false, missionUsage: missionStats, budgetBook, missionHints, decisionSettings: () => settings('auto') });
    expect(await handlers.get('decisionModels:missionPanel')!(trustedEvent(), { missionId: 'mission-b' })).toEqual({ ok: false, reason: 'not-found' });
    registerDecisionModelIpc({ missionInScope: async () => { throw new Error('renderer is unavailable'); }, missionUsage: missionStats, budgetBook, missionHints });
    expect(await handlers.get('decisionModels:missionPanel')!(trustedEvent(), { missionId: 'mission-b' })).toEqual({ ok: false, reason: 'not-found' });
    expect(missionStats).not.toHaveBeenCalled();
    expect(budgetBook).not.toHaveBeenCalled();
    expect(missionHints).not.toHaveBeenCalled();
  });

  it('missão do escopo: gasto cobrado, orçamento, % e chamadas por provedor, com as dicas', async () => {
    const missionInScope = vi.fn(async (_event: unknown, _id: string) => true);
    const budgetBook = book(0.4, 0.1);
    registerDecisionModelIpc({ missionInScope, missionUsage: async () => stats, budgetBook, missionHints: () => hints, decisionSettings: () => settings('auto', 2) });
    const event = trustedEvent();
    const panel = await handlers.get('decisionModels:missionPanel')!(event, { missionId: 'mission-a' });
    expect(missionInScope).toHaveBeenCalledWith(event, 'mission-a');
    expect(panel).toMatchObject({ ok: true, missionId: 'mission-a', mode: 'auto', budgetUsd: 2, chargedUsd: 0.4, reservedUsd: 0.1, calls: 3,
      noAnswer: 1, budgetRefusals: 1, byProvider: { jev: { calls: 2 }, luna: { calls: 1 } }, hints: { kickoff: { lane: 'standard' } } });
    // Mesma conta do livro: cobrado + reservado em voo.
    expect(panel.ratio).toBeCloseTo(0.25);
    expect(budgetBook).toHaveBeenCalledWith('mission-a', 2);
  });

  it('cobrado vem do livro em memória; missão esquecida pelo livro (concluída) usa o diário', async () => {
    registerDecisionModelIpc({ missionInScope: async () => true, missionUsage: async () => ({ ...stats, chargedUsd: 0.3 }),
      budgetBook: book(0.45), missionHints: () => undefined, decisionSettings: () => settings('auto') });
    expect((await handlers.get('decisionModels:missionPanel')!(trustedEvent(), { missionId: 'mission-a' })).chargedUsd).toBe(0.45);
    registerDecisionModelIpc({ missionInScope: async () => true, missionUsage: async () => ({ ...stats, chargedUsd: 0.3 }),
      budgetBook: book(0), missionHints: () => undefined, decisionSettings: () => settings('auto') });
    expect((await handlers.get('decisionModels:missionPanel')!(trustedEvent(), { missionId: 'mission-a' })).chargedUsd).toBe(0.3);
  });

  it('missão sem gasto nem dica: zeros, orçamento padrão, sem erro', async () => {
    registerDecisionModelIpc({ missionInScope: async () => true, missionUsage: async () => undefined, budgetBook: book(0),
      missionHints: () => undefined, decisionSettings: () => settings('jev') });
    expect(await handlers.get('decisionModels:missionPanel')!(trustedEvent(), { missionId: 'mission-a' })).toEqual({
      ok: true, missionId: 'mission-a', mode: 'jev', budgetUsd: 0.5, chargedUsd: 0, reservedUsd: 0, usd: 0, calls: 0, noAnswer: 0, budgetRefusals: 0,
      ratio: 0, byProvider: {}, hints: null });
  });

  it('P2-3: o caminho padrão usa o agregado assíncrono e o livro em memória, nunca o jevDecisionStats síncrono', async () => {
    journal.usage.mockResolvedValueOnce({ ...stats, chargedUsd: 0.2 });
    registerDecisionModelIpc({ missionInScope: async () => true, missionHints: () => undefined, decisionSettings: () => settings('auto') });
    const panel = await handlers.get('decisionModels:missionPanel')!(trustedEvent(), { missionId: 'mission-default' });
    expect(journal.usage).toHaveBeenCalledWith('mission-default');
    expect(journal.stats).not.toHaveBeenCalled();
    expect(panel).toMatchObject({ ok: true, chargedUsd: 0.2, calls: 3 });
  });

  it('leitura que lança vira { ok: false, reason: "error" }, nunca exceção', async () => {
    registerDecisionModelIpc({ missionInScope: async () => true, missionUsage: async () => { throw new Error('diário ilegível'); },
      budgetBook: book(), missionHints: () => hints, decisionSettings: () => settings('auto') });
    await expect(handlers.get('decisionModels:missionPanel')!(trustedEvent(), { missionId: 'mission-a' }))
      .resolves.toEqual({ ok: false, reason: 'error' });
  });
});
