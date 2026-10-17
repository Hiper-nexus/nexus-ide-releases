import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../persistence/secrets-store', () => ({ getSecret: () => null, hasSecret: () => false, setSecret: () => ({ ok: true }), isSecureStorageAvailable: () => true }));
vi.mock('../jev/jev-decision-log', () => ({ recordJevNoAnswer: vi.fn(() => 'id'), recordJevDecision: vi.fn(() => 'id') }));
import { recordJevNoAnswer } from '../jev/jev-decision-log';

import type { JevResult, JudgeInput } from '../jev/jev-client';
import { decisionSettingsSchema, missionDecisionBudgetUsd, type DecisionSettings } from '../../shared/decision-models';
import { DecisionBudgetLedger } from './decision-budget';
import { resetDecisionHealthForTesting } from './decision-health';
import { judgeDecision, type DecisionJudgeDeps } from './decision-judge';
import { estimateDecisionCostUsd, estimateDecisionInputTokens } from './decision-pricing';
import type { DecisionQualityTable } from './decision-quality';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const input = { state: 'tiny', questions: { q: { type: 'noul' as const, instructions: 'Is it relevant?' } }, surface: 'judgeTool' as const };
const ESTIMATE = estimateDecisionCostUsd(estimateDecisionInputTokens(input), 'jev', 'jev');
const nativeResult: JevResult = { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 100, output_tokens: 0 } };
const ACTUAL = 100 * 0.042 / 1_000_000;
/** Qualidade medida localmente (o ensemble do v2 nunca liga só com prior). */
const MEASURED: DecisionQualityTable = { version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: {},
  surfaces: { missionPick: { jev: { accuracy: 0.8, cases: 10 }, 'clef-flash': { accuracy: 0.8, cases: 10 } } } };

beforeEach(() => resetDecisionHealthForTesting());

function settings(over: Partial<DecisionSettings> = {}): DecisionSettings {
  return { mode: 'auto', clefModel: 'clef', cloudflareAccountId: ACCOUNT, visionEnabled: false, ...over };
}

function deps(over: Partial<DecisionJudgeDeps> & { ledger: DecisionBudgetLedger; settings?: DecisionSettings }): DecisionJudgeDeps {
  return {
    nativeJudge: async () => nativeResult,
    getSettings: () => over.settings ?? settings(),
    getAvailability: () => ({ jev: true, clef: false, luna: false }),
    getConfigurationKey: () => 'stable',
    getQualityTable: () => null,
    budgetLedger: over.ledger,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('recibo de falha dos clientes e orçamento da missão', () => {
  beforeEach(() => vi.mocked(recordJevNoAnswer).mockClear());

  function clientDeps(provider: 'clef' | 'luna', ledger: DecisionBudgetLedger, fetchImpl: typeof fetch) {
    return deps({ ledger, settings: settings({ mode: provider }), fetch: fetchImpl,
      getAvailability: () => ({ jev: false, clef: provider === 'clef', luna: provider === 'luna' }),
      getClefConnection: () => ({ accountId: ACCOUNT, token: 'synthetic', model: 'clef' as const }),
      resolveLunaKey: () => 'synthetic-luna',
    });
  }

  for (const provider of ['clef', 'luna'] as const) {
    it.each(['choice singleton', 'corpo excessivo'])('%s no ' + provider + ': zero requisições devolve toda a reserva', async failure => {
      const ledger = new DecisionBudgetLedger();
      const fetcher = vi.fn(async () => new Response('{}', { status: 400 }));
      const request: JudgeInput = { ...input, missionId: 'm-local', ...(failure === 'choice singleton'
        ? { questions: { q: { type: 'choice' as const, instructions: 'Choose.', criteria: { only: 'Only' } } } }
        : { state: 'x'.repeat(14 * 1024 * 1024) }) };

      const result = await judgeDecision(request, clientDeps(provider, ledger, fetcher as typeof fetch));

      expect(result).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
      expect(ledger.snapshot('m-local', 1)).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
      expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'client-error', budgetChargedUsd: 0,
        usage: expect.objectContaining({ requestCount: 0, inputTokens: 0, usd: 0, usageIncomplete: false }) }));
    });

    it(provider + ': falha depois do envio conserva o gasto desconhecido estimado', async () => {
      const ledger = new DecisionBudgetLedger();
      const fetcher = vi.fn(async () => new Response('{}', { status: 400 }));

      await judgeDecision({ ...input, missionId: 'm-sent' }, clientDeps(provider, ledger, fetcher as typeof fetch));

      expect(fetcher).toHaveBeenCalledOnce();
      expect(ledger.snapshot('m-sent', 1).reservedUsd).toBe(0);
      const expectedUsd = provider === 'clef' ? 0.000048 : 0.00002;
      expect(ledger.snapshot('m-sent', 1).spentUsd).toBeCloseTo(expectedUsd, 12);
      expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ budgetChargedUsd: expectedUsd,
        usage: expect.objectContaining({ requestCount: 1, inputTokens: null, usd: null, usageIncomplete: true }) }));
    });

    it(provider + ': resposta inválida depois do envio conserva a medição paga', async () => {
      const ledger = new DecisionBudgetLedger();
      const usage = { input_tokens: 1_000, output_tokens: 0 };
      const fetcher = vi.fn(async () => Response.json(provider === 'clef'
        ? { success: true, result: { model: 'clef', usage, answers: {} } }
        : { model: 'gpt-6-luna', usage, answers: [{ name: 'q0', type: 'refusal' }] }));

      await judgeDecision({ ...input, missionId: 'm-paid' }, clientDeps(provider, ledger, fetcher as typeof fetch));

      expect(fetcher).toHaveBeenCalledOnce();
      const expectedUsd = provider === 'clef' ? 0.00024 : 0.0001;
      expect(ledger.snapshot('m-paid', 1).spentUsd).toBeCloseTo(expectedUsd, 12);
      expect(ledger.snapshot('m-paid', 1).reservedUsd).toBe(0);
      expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ budgetChargedUsd: expectedUsd,
        usage: expect.objectContaining({ requestCount: 1, inputTokens: 1_000, usd: expectedUsd, usageIncomplete: false }) }));
    });
  }
});

describe('DecisionBudgetLedger (F-1164)', () => {
  it('reserva o estimado e acerta pelo recibo real', () => {
    const ledger = new DecisionBudgetLedger();
    const reservation = ledger.reserve('m', 0.1, 0.5)!;
    expect(ledger.snapshot('m', 0.5)).toMatchObject({ spentUsd: 0, reservedUsd: 0.1 });
    ledger.settle(reservation, 0.02);
    ledger.settle(reservation, 0.3); // idempotente
    expect(ledger.snapshot('m', 0.5)).toMatchObject({ spentUsd: 0.02, reservedUsd: 0, level: 'normal' });
  });

  it('custo desconhecido mantém o estimado; recibo incompleto mantém o maior', () => {
    const ledger = new DecisionBudgetLedger();
    ledger.settle(ledger.reserve('m', 0.1, 1)!, null);
    expect(ledger.snapshot('m', 1).spentUsd).toBeCloseTo(0.1);
    ledger.settle(ledger.reserve('m', 0.1, 1)!, 0.01, true);
    expect(ledger.snapshot('m', 1).spentUsd).toBeCloseTo(0.2);
    ledger.settle(ledger.reserve('m', 0.1, 1)!, 0.3, true);
    expect(ledger.snapshot('m', 1).spentUsd).toBeCloseTo(0.5);
  });

  it('recusa a reserva que estouraria o teto; níveis 80% e 100%', async () => {
    const ledger = new DecisionBudgetLedger(() => ({ m: 0.4 }));
    await ledger.warm();
    expect(ledger.snapshot('m', 0.5).level).toBe('soft');
    expect(ledger.reserve('m', 0.2, 0.5)).toBeNull();
    expect(ledger.reserve('m', 0.1, 0.5)).not.toBeNull();
    expect(ledger.snapshot('m', 0.5).level).toBe('exhausted');
    expect(ledger.reserve('m', 0, 0.5)).toBeNull();
    // Contabilidade sem imposição (modo explícito) nunca recusa.
    expect(ledger.reserve('m', 0.2, 0.5, false)).not.toBeNull();
  });

  it('reconstrói do diário uma vez e tolera falha de leitura', async () => {
    const load = vi.fn(() => ({ a: 0.3, b: Number.NaN, c: -1 }));
    const ledger = new DecisionBudgetLedger(load);
    await ledger.warm();
    expect(ledger.snapshot('a', 1).spentUsd).toBeCloseTo(0.3);
    expect(ledger.snapshot('b', 1).spentUsd).toBe(0);
    ledger.snapshot('c', 1);
    await ledger.warm();
    expect(load).toHaveBeenCalledTimes(1);
    const broken = new DecisionBudgetLedger(() => { throw new Error('private fs failure'); });
    await broken.warm();
    expect(broken.snapshot('a', 1)).toMatchObject({ spentUsd: 0, level: 'normal' });
  });
});

describe('orçamento por missão no judge (F-1164)', () => {
  beforeEach(() => vi.mocked(recordJevNoAnswer).mockClear());

  it('N chamadas paralelas não estouram o orçamento', async () => {
    const ledger = new DecisionBudgetLedger();
    const gate = deferred<void>();
    let calls = 0;
    const budget = ESTIMATE * 3 + ESTIMATE / 2;
    const d = deps({ ledger, settings: settings({ missionBudgetUsd: budget }),
      nativeJudge: async () => { calls++; await gate.promise; return nativeResult; } });
    const reasons: string[] = [];
    const pending = Array.from({ length: 5 }, () =>
      judgeDecision({ ...input, missionId: 'm-par', onNoAnswer: reason => reasons.push(reason) }, d));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ledger.snapshot('m-par', budget).reservedUsd).toBeCloseTo(ESTIMATE * 3, 12);
    gate.resolve();
    const results = await Promise.all(pending);
    expect(calls).toBe(3);
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(reasons).toEqual(['budget', 'budget']);
    // Acerto pelo recibo real (100 tokens), não pelo estimado.
    expect(ledger.snapshot('m-par', budget)).toMatchObject({ reservedUsd: 0 });
    expect(ledger.snapshot('m-par', budget).spentUsd).toBeCloseTo(ACTUAL * 3, 12);
    expect(ledger.snapshot('m-par', budget).spentUsd).toBeLessThanOrEqual(budget);
  });

  it('orçamento esgotado: noAnswer("budget"), null e nenhuma requisição', async () => {
    const ledger = new DecisionBudgetLedger(() => ({ 'm-out': 0.5 }));
    await ledger.warm();
    const nativeJudge = vi.fn(async () => nativeResult);
    const onNoAnswer = vi.fn();
    const result = await judgeDecision({ ...input, missionId: 'm-out', onNoAnswer }, deps({ ledger, nativeJudge }));
    expect(result).toBeNull();
    expect(nativeJudge).not.toHaveBeenCalled();
    expect(onNoAnswer).toHaveBeenCalledWith('budget');
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: 'budget', missionId: 'm-out', usage: expect.objectContaining({ requestCount: 0, usd: 0 }),
    }));
  });

  it('chamada sem missionId não consome nem é barrada pelo orçamento de missão', async () => {
    const ledger = new DecisionBudgetLedger(() => ({ 'm-out': 0.5 }));
    await ledger.warm();
    // Com Flash disponível: um nível suave/esgotado vazado trocaria a rota para o mais barato.
    const result = await judgeDecision({ ...input }, deps({ ledger, getAvailability: () => ({ jev: true, clef: true, luna: false }) }));
    expect(result?.model).toBe('jev-1.13.0');
    expect(result?.route?.reason).toContain('orçamento normal');
    expect(ledger.snapshot('m-out', 0.5).spentUsd).toBe(0.5);
  });

  it('custo desconhecido do provedor mantém a reserva estimada', async () => {
    const ledger = new DecisionBudgetLedger();
    await judgeDecision({ ...input, missionId: 'm-unk' }, deps({ ledger,
      nativeJudge: async () => ({ ...nativeResult, usageMissing: true as const }) }));
    expect(ledger.snapshot('m-unk', 0.5).spentUsd).toBeCloseTo(ESTIMATE, 12);
  });

  it('falha antes de qualquer requisição devolve a reserva', async () => {
    const ledger = new DecisionBudgetLedger();
    const controller = new AbortController(); controller.abort();
    await judgeDecision({ ...input, missionId: 'm-abort', signal: controller.signal }, deps({ ledger }));
    expect(ledger.snapshot('m-abort', 0.5)).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
  });

  it('limiar suave: só o mais barato, sem ensemble', async () => {
    const endpoints: string[] = [];
    const fetchMock = (async (url: string, options?: RequestInit) => {
      endpoints.push(String(url));
      const body = JSON.parse(String(options?.body));
      return Response.json({ success: true, result: { model: body.model, usage: { input_tokens: 50, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) } });
    }) as typeof fetch;
    const nativeJudge = vi.fn(async () => nativeResult);
    const common = { nativeJudge, fetch: fetchMock, getAvailability: () => ({ jev: true, clef: true, luna: false }),
      getClefConnection: () => ({ accountId: ACCOUNT, token: 'synthetic', model: 'clef' as const }) };
    // Normal: missionPick é reversível e não tem limiar calibrado — qualidade MEDIDA liga "usar várias".
    const normal = await judgeDecision({ ...input, surface: 'missionPick', missionId: 'm-normal' },
      deps({ ledger: new DecisionBudgetLedger(), ...common, getQualityTable: () => MEASURED }));
    expect(normal?.model).toBe('ensemble');
    expect(nativeJudge).toHaveBeenCalledTimes(1);
    // Acima de 80%: uma chamada, ao mais barato (Flash).
    nativeJudge.mockClear(); endpoints.length = 0;
    const softLedger = new DecisionBudgetLedger(() => ({ 'm-soft': 0.45 }));
    await softLedger.warm();
    const soft = await judgeDecision({ ...input, surface: 'taskRouting', missionId: 'm-soft' },
      deps({ ledger: softLedger, ...common, getQualityTable: () => MEASURED }));
    expect(soft?.route).toMatchObject({ provider: 'clef', model: 'clef-flash', policyVersion: 'decision-engine-v2' });
    expect(nativeJudge).not.toHaveBeenCalled();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatch(/clef-flash$/);
  });

  it('modos explícitos não são recusados pelo orçamento e mantêm a rota v1', async () => {
    for (const mode of ['jev', 'clef'] as const) {
      const ledger = new DecisionBudgetLedger(() => ({ 'm-x': 5 }));
      await ledger.warm();
      const result = await judgeDecision({ ...input, surface: 'toolPick', missionId: 'm-x' }, deps({ ledger,
        settings: settings({ mode }),
        getAvailability: () => ({ jev: mode === 'jev', clef: mode === 'clef', luna: false }),
        getClefConnection: () => ({ accountId: ACCOUNT, token: 'synthetic', model: 'clef' as const }),
        fetch: (async (_url: string, options?: RequestInit) => {
          const body = JSON.parse(String(options?.body));
          return Response.json({ success: true, result: { model: body.model, usage: { input_tokens: 50, output_tokens: 0 },
            answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) } });
        }) as typeof fetch }));
      expect(result?.route).toMatchObject({ policyVersion: 'jev-clef-luna-v1', reason: 'manual',
        provider: mode, model: mode === 'clef' ? 'clef' : 'jev-1.13.0' });
      // Contabiliza o gasto (para quando o operador voltar ao Automático), sem recusar.
      expect(ledger.snapshot('m-x', 0.5).spentUsd).toBeGreaterThan(5);
    }
  });
});

describe('orçamento por missão nas configurações (F-1164)', () => {
  it('padrão US$ 0,50 para ausente ou 0; fora da faixa vira padrão sem derrubar o resto', () => {
    expect(missionDecisionBudgetUsd(decisionSettingsSchema.parse({}))).toBe(0.5);
    expect(missionDecisionBudgetUsd(decisionSettingsSchema.parse({ missionBudgetUsd: 0 }))).toBe(0.5);
    expect(missionDecisionBudgetUsd(decisionSettingsSchema.parse({ missionBudgetUsd: 2 }))).toBe(2);
    for (const invalid of [25, -1, Number.NaN, '1']) {
      const parsed = decisionSettingsSchema.safeParse({ mode: 'auto', clefModel: 'clef-flash', missionBudgetUsd: invalid });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({ mode: 'auto', clefModel: 'clef-flash' });
      expect(parsed.data?.missionBudgetUsd).toBeUndefined();
      expect(missionDecisionBudgetUsd(parsed.data!)).toBe(0.5);
    }
    expect(decisionSettingsSchema.parse({})).not.toHaveProperty('missionBudgetUsd');
  });
});

describe('revisão da Fase 1 (F-1164/F-1165)', () => {
  beforeEach(() => vi.mocked(recordJevNoAnswer).mockClear());
  const clefAnswer = (status = 200) => (async (_url: string, options?: RequestInit) => {
    if (status !== 200) return new Response('{}', { status });
    const body = JSON.parse(String(options?.body));
    return Response.json({ success: true, result: { model: body.model, usage: { input_tokens: 50, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) } });
  }) as typeof fetch;
  const withClef = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, getAvailability: () => ({ jev: true, clef: true, luna: false }),
    getClefConnection: () => ({ accountId: ACCOUNT, token: 'synthetic', model: 'clef' as const }), getQualityTable: () => MEASURED });

  it('P1: ensemble reversível com falha parcial devolve o membro que respondeu', async () => {
    const ledger = new DecisionBudgetLedger();
    const result = await judgeDecision({ ...input, surface: 'missionPick', missionId: 'm-partial' },
      deps({ ledger, ...withClef(clefAnswer(400)) }));
    expect(result?.model).toBe('jev-1.13.0');
    expect(result?.answers.q).toMatchObject({ noul: 0.8 });
    expect(result?.route?.provider).toBe('jev');
    expect(result?.route?.reason).toContain('parcial: clef-flash');
    // O gasto do membro que caiu entra no acerto (requisição feita, custo desconhecido = estimado mantido).
    expect(result?.requestCount).toBe(2);
    expect(result?.budgetChargedUsd).toBeGreaterThan(ACTUAL);
    expect(ledger.snapshot('m-partial', 0.5).spentUsd).toBeCloseTo(result!.budgetChargedUsd!, 12);
  });

  it('P1: Junto (v1) mantém a regra: falha parcial não devolve resposta', async () => {
    const result = await judgeDecision({ ...input, surface: 'taskRouting' }, deps({ ledger: new DecisionBudgetLedger(),
      settings: settings({ mode: 'together' }), ...withClef(clefAnswer(400)), getAvailability: () => ({ jev: true, clef: true, luna: true }),
      resolveLunaKey: () => 'sk-synthetic', fetch: (async (url: string, options?: RequestInit) => String(url).includes('openai')
        ? new Response('{}', { status: 400 }) : clefAnswer(400)(url, options)) as typeof fetch }));
    expect(result).toBeNull();
  });

  // O recibo de cada membro do conjunto é escrito depois da chamada dele: cliente que
  // responde `null` sem relatar uso não fez requisição nenhuma (o Jev sem chave), e um
  // ensemble com esse membro não pode virar gasto desconhecido — que segura o estimado
  // inteiro no orçamento da missão sem nenhuma requisição ter saído.
  const fatInput = { ...input, state: 'contexto da decisão '.repeat(400) };
  const CLEF_MEASURED = 50 * 0.038 / 1_000_000;

  it('P1: membro que devolve null sem relatar uso é "nenhuma requisição" — só se cobra quem pediu', async () => {
    const ledger = new DecisionBudgetLedger();
    const result = await judgeDecision({ ...fatInput, surface: 'missionPick', missionId: 'm-no-request' },
      deps({ ledger, ...withClef(clefAnswer()), nativeJudge: async () => null }));
    const estimated = estimateDecisionCostUsd(estimateDecisionInputTokens(fatInput), 'jev', 'jev');
    // Só o Clef pediu: a requisição dele e o custo medido dele, com o recibo completo.
    expect(result?.usageReceipt).toMatchObject({ requestCount: 1, usageIncomplete: false });
    expect(result?.usageMissing).toBeUndefined();
    expect(estimated).toBeGreaterThan(CLEF_MEASURED);
    expect(result?.budgetChargedUsd).toBeCloseTo(CLEF_MEASURED, 12);
    expect(ledger.snapshot('m-no-request', 0.5)).toMatchObject({ reservedUsd: 0 });
    expect(ledger.snapshot('m-no-request', 0.5).spentUsd).toBeCloseTo(CLEF_MEASURED, 12);
  });

  it('P1: membro que lança sem relatar uso é gasto desconhecido — o estimado fica', async () => {
    const ledger = new DecisionBudgetLedger();
    const result = await judgeDecision({ ...fatInput, surface: 'missionPick', missionId: 'm-ensemble-unknown' },
      deps({ ledger, ...withClef(clefAnswer()), nativeJudge: async () => { throw new Error('transport boom'); } }));
    const estimated = estimateDecisionCostUsd(estimateDecisionInputTokens(fatInput), 'jev', 'jev');
    expect(result?.usageReceipt).toMatchObject({ requestCount: 1, usageIncomplete: true });
    expect(result?.usageMissing).toBe(true);
    // Custo desconhecido nunca vira zero: o livro segura um estimado acima do medido.
    expect(result?.budgetChargedUsd).toBeGreaterThan(CLEF_MEASURED);
    expect(result?.budgetChargedUsd).toBeGreaterThanOrEqual(estimated);
    expect(ledger.snapshot('m-ensemble-unknown', 0.5)).toMatchObject({ reservedUsd: 0 });
    expect(ledger.snapshot('m-ensemble-unknown', 0.5).spentUsd).toBeCloseTo(result!.budgetChargedUsd!, 12);
  });

  it('P2-5: surface fixa no Jev nunca é recusada pelo orçamento; só contabiliza', async () => {
    const ledger = new DecisionBudgetLedger(() => ({ 'm-pin': 0.5 }));
    await ledger.warm();
    const nativeJudge = vi.fn(async () => nativeResult);
    const onNoAnswer = vi.fn();
    const result = await judgeDecision({ ...input, surface: 'dispatchGuard', missionId: 'm-pin', onNoAnswer },
      deps({ ledger, nativeJudge, getAvailability: () => ({ jev: true, clef: true, luna: false }) }));
    expect(nativeJudge).toHaveBeenCalledTimes(1);
    expect(result?.route).toMatchObject({ provider: 'jev', reason: 'jev-pinned' });
    expect(onNoAnswer).not.toHaveBeenCalled();
    expect(ledger.snapshot('m-pin', 0.5).spentUsd).toBeCloseTo(0.5 + ACTUAL, 12);
  });

  it('P3: recusa por orçamento de plano ensemble grava o modelo "ensemble"', async () => {
    const ledger = new DecisionBudgetLedger();
    const tiny = settings({ missionBudgetUsd: ESTIMATE / 4 });
    await judgeDecision({ ...input, surface: 'missionPick', missionId: 'm-ens' }, deps({ ledger, settings: tiny, ...withClef(clefAnswer()) }));
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'budget', model: 'ensemble' }));
  });

  it('P3: abort no meio da chamada cobra o estimado quando o custo é desconhecido', async () => {
    const ledger = new DecisionBudgetLedger();
    await judgeDecision({ ...input, missionId: 'm-mid' }, deps({ ledger, nativeJudge: async (call) => {
      call.onUsage?.({ inputTokens: null, usd: null, requestCount: 1, durationMs: 5, usageIncomplete: true });
      call.onNoAnswer?.('aborted');
      return null;
    } }));
    expect(ledger.snapshot('m-mid', 0.5)).toMatchObject({ reservedUsd: 0 });
    expect(ledger.snapshot('m-mid', 0.5).spentUsd).toBeCloseTo(ESTIMATE, 12);
  });

  it('P3: mudança de configuração no meio descarta a resposta mas cobra o medido', async () => {
    const ledger = new DecisionBudgetLedger();
    let key = 'before';
    const result = await judgeDecision({ ...input, missionId: 'm-cfg' }, deps({ ledger, getConfigurationKey: () => key,
      nativeJudge: async () => { key = 'after'; return nativeResult; } }));
    expect(result).toBeNull();
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'aborted', budgetChargedUsd: ACTUAL }));
    expect(ledger.snapshot('m-cfg', 0.5).spentUsd).toBeCloseTo(ACTUAL, 12);
  });

  it('P2-6: sem rota nem no v2 nem no v1, a consulta deixa uma linha no diário', async () => {
    const result = await judgeDecision({ ...input, missionId: 'm-none' }, deps({ ledger: new DecisionBudgetLedger(),
      getAvailability: () => ({ jev: false, clef: false, luna: false }) }));
    expect(result).toBeNull();
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'unrouted', reason: 'client-error', missionId: 'm-none' }));
  });

  it('P2-7: a primeira decisão não espera o diário; o aquecimento reconcilia ao terminar', async () => {
    const gate = deferred<Record<string, number>>();
    const loader = vi.fn((_before: number) => gate.promise);
    const ledger = new DecisionBudgetLedger(loader);
    const result = await judgeDecision({ ...input, missionId: 'm-warm' }, deps({ ledger }));
    expect(result).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(ledger.isWarm).toBe(false);
    expect(ledger.snapshot('m-warm', 0.5).spentUsd).toBeCloseTo(ACTUAL, 12);
    gate.resolve({ 'm-warm': 0.1 });
    await ledger.warm();
    expect(ledger.isWarm).toBe(true);
    expect(ledger.snapshot('m-warm', 0.5).spentUsd).toBeCloseTo(0.1 + ACTUAL, 12);
  });

  it('P3: missão encerrada sai da memória; inativa há mais de 7 dias também', async () => {
    let clock = 1_000;
    const ledger = new DecisionBudgetLedger(() => ({}), () => clock);
    const DAY = 24 * 60 * 60 * 1000;
    ledger.settle(ledger.reserve('old', 0.01, 1)!, 0.01);
    ledger.settle(ledger.reserve('live', 0.01, 1)!, 0.01);
    clock += 4 * DAY;
    ledger.settle(ledger.reserve('live', 0.01, 1)!, 0.01);
    clock += 4 * DAY;
    ledger.prune();
    expect(ledger.size).toBe(1);
    expect(ledger.snapshot('live', 1).spentUsd).toBeCloseTo(0.02);
    ledger.forget('live');
    expect(ledger.size).toBe(0);
  });
});
