import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jev/jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: (answers: Record<string, { type: string; noul?: number }>) =>
    Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.noul ?? 0.5])),
}));
vi.mock('../jev/jev-autopilot', () => ({ isJevSurfaceEnabled: vi.fn(() => true) }));
vi.mock('../decision-models/decision-availability', () => ({ hasDecisionCredential: vi.fn(() => true) }));

import type { JevResult, JudgeInput } from '../jev/jev-client';
import { judgeClef } from '../decision-models/clef-client';
import { judgeLuna } from '../decision-models/luna-client';
import { recordJevDecision } from '../jev/jev-decision-log';
import {
  adviseCompletionCheck, adviseMissionKickoff, adviseRecovery, adviseReviewTriage, missionKickoffFacts,
  missionKickoffQuestions, resetMissionAdvisorForTesting, reviewTriageContextLine, scheduleCompletionCheck,
  scheduleMissionKickoffAdvice, scheduleRecoveryAdvice, scheduleReviewTriageAdvice, withReviewTriageLines, type AdvisoryDeps,
  auditCompletionAtDone, completionContextLine, completionSignature, recoveryTriggerClass, settleCompletionChecksForTesting,
  COMPLETION_MAX_CONSULTS, hasCompletionStateForTesting,
} from './jev-mission-advisor';
import { detectLimit } from './limit-detector';
import {
  configureMissionDecisionHints, flushMissionDecisionHints, forgetMissionDecisionHints, getMissionDecisionHints,
  recordMissionFinalized, sweepMissionDecisionHints, withMissionDecisionHints,
} from './mission-decision-hints';

const ROUTE = { provider: 'jev' as const, model: 'jev-latest', policyVersion: 'decision-engine-v2' as const,
  evidence: 'prior' as const, reason: 'auto v2 · teste' };

function result(answers: JevResult['answers'], extra: Partial<JevResult> = {}): JevResult {
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 400, output_tokens: 0 }, route: ROUTE,
    estimatedUsd: 0.0000168, budgetChargedUsd: 0.00002, ...extra };
}

const kickoffAnswers = (workers = '2') => ({
  complexity: { type: 'score' as const, score: 2.2, legend: {}, probabilities: {}, confidence: 0.8 },
  lane: { type: 'choice' as const, choice: 'standard', probabilities: { standard: 0.8 }, confidence: 0.8 },
  workers: { type: 'choice' as const, choice: workers, probabilities: { [workers]: 0.7 }, confidence: 0.7 },
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-hints-'));
  configureMissionDecisionHints(dir);
  resetMissionAdvisorForTesting();
  vi.mocked(recordJevDecision).mockClear();
});
afterEach(async () => {
  await flushMissionDecisionHints();
  configureMissionDecisionHints(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const mission = (id: string, maxWorkers = 3) => ({
  id, title: `Missão ${id}`, description: 'descrição',
  intentContract: { goal: `objetivo de ${id}`, acceptanceCriteria: ['testes passam'], lane: 'standard', risk: 'normal',
    budgets: { maxWorkers } },
});

describe('missionKickoff (F-1166)', () => {
  it.each(['clef', 'luna'] as const)('%s: missão de um worker recebe dica válida sem escolha impossível', async provider => {
    const probabilities = { standard: 1, consult: 0, plan: 0, ops: 0 };
    const scoreProbabilities = { '0': 0, '1': 0, '2': 1, '3': 0 };
    const usage = { input_tokens: 100, output_tokens: 0 };
    const fetcher = (async () => Response.json(provider === 'clef'
      ? { success: true, result: { model: 'clef', usage, answers: {
        q0: { type: 'score', score: 2, confidence: 1, probabilities: scoreProbabilities,
          legend: { '0': 'trivial', '1': 'small', '2': 'medium', '3': 'large' } },
        q1: { type: 'choice', choice: 'standard', confidence: 1, probabilities },
      } } }
      : { model: 'gpt-6-luna', usage, answers: [
        { type: 'score', name: 'q0', score: 2, confidence: 1,
          probabilities: [0, 1, 2, 3].map(value => ({ value, probability: value === 2 ? 1 : 0 })) },
        { type: 'choice', name: 'q1', choice: 'standard', confidence: 1,
          probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })) },
      ] })) as typeof fetch;
    const judge = (input: JudgeInput) => provider === 'clef'
      ? judgeClef(input, { accountId: '0123456789abcdef0123456789abcdef', token: 'synthetic-token', model: 'clef' }, { fetch: fetcher })
      : judgeLuna(input, 'synthetic-token', { fetch: fetcher });

    const hint = await adviseMissionKickoff(missionKickoffFacts(mission(`m-single-${provider}`, 1), 'pane'), { judge });

    expect(hint).toMatchObject({ workers: 1, maxWorkers: 1, complexityLevel: 'medium', lane: 'standard' });
    expect(getMissionDecisionHints(`m-single-${provider}`)?.kickoff).toEqual(hint);
  });

  it('convencional: grava a dica com rota, custo e workers dentro de maxWorkers; passa o missionId', async () => {
    const judge = vi.fn(async (_input: JudgeInput) => result(kickoffAnswers('2')));
    const hint = await adviseMissionKickoff(missionKickoffFacts(mission('m-conv'), 'conventional'), { judge });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ surface: 'missionKickoff', missionId: 'm-conv', retryOnTimeout: false }));
    expect(hint).toMatchObject({ origin: 'conventional', complexityLevel: 'medium', workers: 2, maxWorkers: 3, lane: 'standard',
      route: ROUTE, budgetChargedUsd: 0.00002 });
    expect(getMissionDecisionHints('m-conv')?.kickoff).toEqual(hint);
    expect(recordJevDecision).toHaveBeenCalledWith(expect.objectContaining({ surface: 'missionKickoff', missionId: 'm-conv' }));
  });

  it('+pane: mesma surface, origem pane; resposta fora do teto é limitada a maxWorkers', async () => {
    const judge = vi.fn(async () => result(kickoffAnswers('9')));
    const hint = await adviseMissionKickoff(missionKickoffFacts(mission('m-pane', 2), 'pane'), { judge });
    expect(hint).toMatchObject({ origin: 'pane', workers: 2, maxWorkers: 2 });
    expect(Object.keys((missionKickoffQuestions(2).workers as { criteria: object }).criteria)).toEqual(['1', '2']);
    expect(missionKickoffQuestions(0).workers).toBeUndefined();
  });

  it('o que vai ao modelo é redigido e limitado', async () => {
    const judge = vi.fn(async (_input: JudgeInput) => result(kickoffAnswers()));
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    await adviseMissionKickoff({ ...missionKickoffFacts(mission('m-red'), 'conventional'),
      goal: `use a chave ${secret} ` + 'x'.repeat(20_000) }, { judge });
    const state = JSON.stringify(judge.mock.calls[0]![0].state);
    expect(state).not.toContain(secret);
    expect(state.length).toBeLessThan(4_000);
  });

  it('F-1346: goal longo chega ao Jev com o pedido do FIM (cabeça + cauda)', async () => {
    const judge = vi.fn(async (_input: JudgeInput) => result(kickoffAnswers()));
    const ask = 'CORREÇÃO REAL: corrija F-9999 no router com três writers.';
    const goal = `Contexto da varredura s240. ${'x'.repeat(10_000)} ${ask}`;
    await adviseMissionKickoff({ ...missionKickoffFacts(mission('m-tail'), 'conventional'), goal }, { judge });
    const sent = (judge.mock.calls[0]![0].state as { goal: string }).goal;
    expect(sent).toContain('Contexto da varredura s240.');
    expect(sent).toContain(ask);
    expect(sent.length).toBeLessThan(1_600);
  });
});

describe('fail-open e toggle (F-1166)', () => {
  const facts = () => missionKickoffFacts(mission('m-fail'), 'conventional');

  it('toggle desligado ou sem credencial: nenhuma chamada, nenhuma dica', async () => {
    const judge = vi.fn(async () => result(kickoffAnswers()));
    expect(await adviseMissionKickoff(facts(), { judge, enabled: () => false })).toBeNull();
    expect(await adviseMissionKickoff(facts(), { judge, hasKey: () => false })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
    expect(getMissionDecisionHints('m-fail')).toBeUndefined();
  });

  it('null (orçamento esgotado, timeout), erro ou resposta inválida: sem dica', async () => {
    const cases: AdvisoryDeps['judge'][] = [
      async (input) => { input.onNoAnswer?.('budget'); return null; },
      async () => null,
      async () => { throw new Error('private failure'); },
      async () => result({ complexity: { type: 'noul', noul: 0.9 } }),
    ];
    for (const judge of cases) expect(await adviseMissionKickoff(facts(), { judge })).toBeNull();
    expect(getMissionDecisionHints('m-fail')).toBeUndefined();
  });

  it('prazo curto: o judge recebe um sinal que aborta; pendurado não vira dica', async () => {
    const judge = vi.fn((input: JudgeInput) => new Promise<JevResult | null>((resolve) => {
      input.signal?.addEventListener('abort', () => resolve(null));
    }));
    expect(await adviseMissionKickoff(facts(), { judge, timeoutMs: 20 })).toBeNull();
  });

  it('não bloqueia: schedule volta na hora mesmo com o judge pendurado para sempre', async () => {
    const judge = vi.fn(() => new Promise<JevResult | null>(() => {}));
    const started = performance.now();
    expect(scheduleMissionKickoffAdvice(facts(), { judge })).toBeUndefined();
    scheduleReviewTriageAdvice({ missionId: 'm-fail', handoffId: 'h', summary: 's', declaredFiles: ['a.ts'] }, { judge });
    scheduleRecoveryAdvice({ missionId: 'm-fail', triggerClass: 'rate-limit' }, { judge });
    scheduleCompletionCheck('m-fail', () => ({ missionId: 'm-fail', goal: 'g', handoffs: [{ id: 'h', status: 'success', summary: 's' }] }),
      { judge, debounceMs: 0, budgetLevel: () => 'normal' });
    auditCompletionAtDone('m-fail-2', () => ({ missionId: 'm-fail-2', goal: 'g', handoffs: [{ id: 'h', status: 'success', summary: 's' }] }),
      { judge, budgetLevel: () => 'normal' });
    expect(performance.now() - started).toBeLessThan(50);
    expect(judge).not.toHaveBeenCalled();
    await wait(10);
    expect(judge).toHaveBeenCalledTimes(5);
    expect(getMissionDecisionHints('m-fail')).toBeUndefined();
  });

  it('kickoff e conclusão consultam uma vez por missão (retry não repete)', async () => {
    const judge = vi.fn(async () => result(kickoffAnswers()));
    scheduleMissionKickoffAdvice(facts(), { judge });
    scheduleMissionKickoffAdvice(facts(), { judge });
    await tick(); await tick();
    expect(judge).toHaveBeenCalledTimes(1);
  });
});

describe('isolamento entre missões (F-1166)', () => {
  it('a dica de uma missão não aparece em outra; arquivo de outra missão é ignorado', async () => {
    await adviseMissionKickoff(missionKickoffFacts(mission('m-a'), 'conventional'), { judge: async () => result(kickoffAnswers('1')) });
    await adviseMissionKickoff(missionKickoffFacts(mission('m-b'), 'pane'), { judge: async () => result(kickoffAnswers('3')) });
    expect(getMissionDecisionHints('m-a')?.kickoff?.workers).toBe(1);
    expect(getMissionDecisionHints('m-b')?.kickoff?.workers).toBe(3);
    expect(withMissionDecisionHints({ id: 'm-c' })).toEqual({ id: 'm-c' });
    await flushMissionDecisionHints();
    // Arquivo trocado (o JSON de m-a no lugar do de m-b): a leitura confere o missionId.
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(2);
    const aFile = files.find(file => fs.readFileSync(path.join(dir, file), 'utf8').includes('"m-a"'))!;
    const bFile = files.find(file => file !== aFile)!;
    fs.copyFileSync(path.join(dir, aFile), path.join(dir, bFile));
    configureMissionDecisionHints(dir);
    expect(getMissionDecisionHints('m-b')).toBeUndefined();
    expect(getMissionDecisionHints('m-a')?.kickoff?.workers).toBe(1);
  });

  it('a conclusão não grava se o coletor devolver fatos de outra missão', async () => {
    const judge = vi.fn(async () => result({ covers_goal: { type: 'noul', noul: 0.1 } }));
    scheduleCompletionCheck('m-x', () => ({ missionId: 'm-y', goal: 'g', handoffs: [] }), { judge, debounceMs: 0 });
    await wait(5); await settleCompletionChecksForTesting();
    expect(judge).not.toHaveBeenCalled();
    expect(getMissionDecisionHints('m-x')).toBeUndefined();
    expect(getMissionDecisionHints('m-y')).toBeUndefined();
  });

  it('persiste e relê após "reinício"; missão antiga sem arquivo segue sem o campo', async () => {
    await adviseMissionKickoff(missionKickoffFacts(mission('m-p'), 'conventional'), { judge: async () => result(kickoffAnswers()) });
    await flushMissionDecisionHints();
    configureMissionDecisionHints(dir);
    expect(getMissionDecisionHints('m-p')?.kickoff).toMatchObject({ origin: 'conventional', workers: 2 });
    expect(withMissionDecisionHints({ id: 'old', title: 't' })).not.toHaveProperty('decisionHints');
  });
});

describe('reviewTriage (F-1166)', () => {
  it('risco alto recomenda revisão independente e vira linha no handoff_list da própria missão', async () => {
    const judge = vi.fn(async (_input: JudgeInput) => result({ regression_risk: { type: 'noul', noul: 0.82 } }));
    const hint = await adviseReviewTriage({ missionId: 'm-r', handoffId: 'h1', summary: 'mudou o login',
      declaredFiles: Array.from({ length: 100 }, (_, index) => `src/f${index}.ts`) }, { judge });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ surface: 'reviewTriage', missionId: 'm-r' }));
    expect((judge.mock.calls[0]![0].state as { files: string[] }).files).toHaveLength(40);
    expect(hint).toMatchObject({ handoffId: 'h1', regressionRisk: 0.82, recommendIndependentReview: true, route: ROUTE });
    const rows = withReviewTriageLines([{ id: 'h1', missionId: 'm-r' }, { id: 'h2', missionId: 'm-r' }], 'm-r');
    expect(rows[0]).toMatchObject({ decisionHint: reviewTriageContextLine(hint!), independentReviewSuggested: true });
    expect(rows[1]).not.toHaveProperty('decisionHint');
    // Outra missão listada (ou linha de outra missão) não recebe a dica.
    expect(withReviewTriageLines([{ id: 'h1', missionId: 'm-r' }], 'm-other')[0]).not.toHaveProperty('decisionHint');
    expect(withReviewTriageLines([{ id: 'h1', missionId: 'm-other' }], 'm-r')[0]).not.toHaveProperty('decisionHint');
  });

  it('risco baixo não recomenda revisão', async () => {
    const hint = await adviseReviewTriage({ missionId: 'm-r2', handoffId: 'h', summary: 's', declaredFiles: ['a.ts'] },
      { judge: async () => result({ regression_risk: { type: 'noul', noul: 0.2 } }) });
    expect(hint?.recommendIndependentReview).toBe(false);
    expect(reviewTriageContextLine(hint!)).toContain('dispensável');
  });
});

describe('recoveryAdvice (F-1166)', () => {
  it('grava a escolha (repetir, trocar, escalar) sem mudar a recuperação; dedupe em 60 s', async () => {
    const judge = vi.fn(async (_input: JudgeInput) => result({ next_step: { type: 'choice', choice: 'switch-cli',
      probabilities: { 'switch-cli': 0.7 }, confidence: 0.7 } }));
    const hint = await adviseRecovery({ missionId: 'm-rec', triggerClass: 'quota', paneId: 'p1', adapterId: 'codex' }, { judge });
    expect(hint).toMatchObject({ advice: 'switch-cli', triggerClass: 'quota', paneId: 'p1', adapterId: 'codex', route: ROUTE });
    expect(hint).not.toHaveProperty('trigger');
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ surface: 'recoveryAdvice', missionId: 'm-rec',
      state: { triggerClass: 'quota', adapterId: 'codex', switchingTo: null } }));
    let now = 1_000;
    scheduleRecoveryAdvice({ missionId: 'm-rec', triggerClass: 'rate-limit', paneId: 'p1' }, { judge, now: () => now });
    scheduleRecoveryAdvice({ missionId: 'm-rec', triggerClass: 'rate-limit', paneId: 'p1' }, { judge, now: () => now });
    // Outra classe é outra queda: não é deduplicada.
    scheduleRecoveryAdvice({ missionId: 'm-rec', triggerClass: 'auth', paneId: 'p1' }, { judge, now: () => now });
    now += 61_000;
    scheduleRecoveryAdvice({ missionId: 'm-rec', triggerClass: 'rate-limit', paneId: 'p1' }, { judge, now: () => now });
    await tick(); await tick();
    expect(judge).toHaveBeenCalledTimes(4);
    expect(await adviseRecovery({ missionId: 'm-rec', triggerClass: 'unknown' }, { judge: async () => result({
      next_step: { type: 'choice', choice: 'reboot-mac', probabilities: {}, confidence: 1 } }) })).toBeNull();
  });
});

describe('completionCheck (F-1166)', () => {
  it('cobertura baixa grava aviso; alta não avisa; handoffs limitados e redigidos', async () => {
    const judge = vi.fn(async (_input: JudgeInput) => result({ covers_goal: { type: 'noul', noul: 0.2 } }));
    const handoffs = Array.from({ length: 30 }, (_, index) => ({ status: 'success', summary: `h${index} ` + 'y'.repeat(3_000) }));
    const hint = await adviseCompletionCheck({ missionId: 'm-done', goal: 'objetivo', handoffs }, { judge });
    expect(hint).toMatchObject({ warning: true, coverage: 0.2, handoffCount: 30, route: ROUTE });
    const state = judge.mock.calls[0]![0].state as { handoffs: { summary: string }[] };
    expect(state.handoffs).toHaveLength(20);
    expect(state.handoffs.every(item => item.summary.length < 700)).toBe(true);
    expect((await adviseCompletionCheck({ missionId: 'm-done2', goal: 'g', handoffs: [] },
      { judge: async () => result({ covers_goal: { type: 'noul', noul: 0.9 } }) }))?.warning).toBe(false);
  });
});


describe('P1: a dica de recuperação nunca carrega o texto do detector', () => {
  it('classe vem do limitKind (nunca do texto)', () => {
    expect(recoveryTriggerClass({ limitKind: 'rate-limit' })).toBe('rate-limit');
    expect(recoveryTriggerClass({ limitKind: 'model' })).toBe('model-rejected');
    expect(recoveryTriggerClass({ toModel: 'x' })).toBe('model-rejected');
    expect(recoveryTriggerClass({})).toBe('unknown');
    expect(recoveryTriggerClass({ limitKind: "Claude usage limit reached. Your limit will reset at 3pm." })).toBe('unknown');
  });
});

describe('completionCheck no ciclo (revisão da Fase 2)', () => {
  const handoffs = (...ids: string[]) => ids.map(id => ({ id, status: 'success', summary: `entrega ${id}` }));
  const facts = (missionId: string, ids: string[]) => () => ({ missionId, goal: 'objetivo',
    acceptanceCriteria: ['login funciona', 'testes passam'], handoffs: handoffs(...ids) });
  const covered = (coverage = 0.35) => vi.fn(async (_input: JudgeInput) => result({ covers_goal: { type: 'noul', noul: coverage },
    missing: { type: 'choice', choice: 'c2', probabilities: { c2: 0.8 }, confidence: 0.8 } }));

  it('debounce: handoffs em sequência viram UMA consulta; a linha diz a cobertura e o que falta', async () => {
    const judge = covered();
    scheduleCompletionCheck('m-c1', facts('m-c1', ['a']), { judge, debounceMs: 20, budgetLevel: () => 'normal' });
    scheduleCompletionCheck('m-c1', facts('m-c1', ['a', 'b']), { judge, debounceMs: 20, budgetLevel: () => 'normal' });
    await wait(5);
    expect(judge).not.toHaveBeenCalled();
    await wait(40); await settleCompletionChecksForTesting();
    expect(judge).toHaveBeenCalledTimes(1);
    const hint = getMissionDecisionHints('m-c1')?.completion;
    expect(hint).toMatchObject({ coverage: 0.35, warning: true, missing: 'testes passam', consultations: 1,
      signature: completionSignature(handoffs('a', 'b')) });
    expect(completionContextLine(hint!)).toBe('[motor de decisão] cobertura do objetivo 35%: parece faltar: testes passam');
  });

  it('mesma assinatura não consulta de novo; teto de 3 consultas por missão', async () => {
    const judge = covered();
    const opts = { judge, debounceMs: 0, budgetLevel: () => 'normal' as const };
    scheduleCompletionCheck('m-c2', facts('m-c2', ['a']), opts); await wait(5); await settleCompletionChecksForTesting();
    scheduleCompletionCheck('m-c2', facts('m-c2', ['a']), opts); await wait(5); await settleCompletionChecksForTesting();
    expect(judge).toHaveBeenCalledTimes(1);
    for (const ids of [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e']]) {
      scheduleCompletionCheck('m-c2', facts('m-c2', ids), opts); await wait(5); await settleCompletionChecksForTesting();
    }
    expect(judge).toHaveBeenCalledTimes(COMPLETION_MAX_CONSULTS);
    // Handoff blocked não muda a assinatura (só sucesso conta).
    expect(completionSignature([...handoffs('a'), { id: 'x', status: 'blocked', summary: 'b' }])).toBe(completionSignature(handoffs('a')));
  });

  it('acima de 80% do orçamento não consulta', async () => {
    const judge = covered();
    scheduleCompletionCheck('m-c3', facts('m-c3', ['a']), { judge, debounceMs: 0, budgetLevel: () => 'soft' });
    await wait(5); await settleCompletionChecksForTesting();
    expect(judge).not.toHaveBeenCalled();
  });

  it('conclusão reaproveita a dica com a mesma assinatura (sem nova consulta) e marca a auditoria', async () => {
    const judge = covered(0.9);
    const opts = { judge, debounceMs: 0, budgetLevel: () => 'normal' as const, now: () => 7_000 };
    scheduleCompletionCheck('m-c4', facts('m-c4', ['a']), opts); await wait(5); await settleCompletionChecksForTesting();
    auditCompletionAtDone('m-c4', facts('m-c4', ['a']), opts); await tick(); await settleCompletionChecksForTesting();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(getMissionDecisionHints('m-c4')).toMatchObject({ finalizedAt: 7_000, completion: { finalAudit: { at: 7_000, reused: true } } });
  });

  it('P3: a auditoria final limpa o estado da cobertura depois que a fila termina', async () => {
    const judge = covered(0.9);
    const opts = { judge, debounceMs: 0, budgetLevel: () => 'normal' as const };
    scheduleCompletionCheck('m-clean', facts('m-clean', ['a']), opts); await wait(5); await settleCompletionChecksForTesting();
    expect(hasCompletionStateForTesting('m-clean')).toBe(true);
    auditCompletionAtDone('m-clean', facts('m-clean', ['a', 'b']), opts);
    await tick(); await settleCompletionChecksForTesting(); await tick();
    expect(hasCompletionStateForTesting('m-clean')).toBe(false);
    expect(getMissionDecisionHints('m-clean')?.completion).toMatchObject({ consultations: 2, finalAudit: { reused: false } });
    // Um worker atrasado depois da limpeza continua sob o teto (contagem vem da dica).
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('conclusão com assinatura nova consulta uma vez, sem debounce; coletor que lança não derruba nada', async () => {
    const judge = covered(0.9);
    const opts = { judge, budgetLevel: () => 'normal' as const, now: () => 9_000 };
    auditCompletionAtDone('m-c5', facts('m-c5', ['a']), opts); await tick(); await settleCompletionChecksForTesting();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(getMissionDecisionHints('m-c5')?.completion?.finalAudit).toEqual({ at: 9_000, reused: false });
    expect(() => auditCompletionAtDone('m-c6', () => { throw new Error('store fechado'); }, opts)).not.toThrow();
    await tick(); await settleCompletionChecksForTesting();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(getMissionDecisionHints('m-c6')).toMatchObject({ finalizedAt: 9_000 });
    expect(getMissionDecisionHints('m-c6')?.completion).toBeUndefined();
  });

  it('chamadas simultâneas: kickoff uma vez; cobertura nunca em paralelo para a mesma missão', async () => {
    let inFlight = 0; let peak = 0;
    const judge = vi.fn(async (_input: JudgeInput) => {
      inFlight += 1; peak = Math.max(peak, inFlight); await wait(10); inFlight -= 1;
      return _input.surface === 'missionKickoff' ? result(kickoffAnswers()) : result({ covers_goal: { type: 'noul', noul: 0.4 } });
    });
    await Promise.all(Array.from({ length: 5 }, async () =>
      scheduleMissionKickoffAdvice(missionKickoffFacts(mission('m-sim'), 'conventional'), { judge })));
    await wait(20);
    expect(judge.mock.calls.filter(([input]) => input.surface === 'missionKickoff')).toHaveLength(1);
    judge.mockClear(); peak = 0;
    const opts = { judge, debounceMs: 0, budgetLevel: () => 'normal' as const };
    scheduleCompletionCheck('m-sim', facts('m-sim', ['a']), opts);
    auditCompletionAtDone('m-sim', facts('m-sim', ['a', 'b']), opts);
    await wait(5);
    scheduleCompletionCheck('m-sim', facts('m-sim', ['a', 'b', 'c']), opts);
    await wait(60); await settleCompletionChecksForTesting();
    expect(peak).toBe(1);
    expect(judge.mock.calls.length).toBeLessThanOrEqual(COMPLETION_MAX_CONSULTS);
  });
});

describe('P1: whoami/mission_get com dica de recuperação e de cobertura não casam no limit-detector', () => {
  it('nenhum casamento no JSON exposto, mesmo com o texto de limite no critério do operador', async () => {
    const LIMIT_TEXT = 'Error: 429 Too Many Requests';
    expect(detectLimit(LIMIT_TEXT)).not.toBeNull();
    await adviseRecovery({ missionId: 'm-limit', paneId: 'p', adapterId: 'claude',
      triggerClass: recoveryTriggerClass({ limitKind: detectLimit(LIMIT_TEXT)!.kind }) },
    { judge: async () => result({ next_step: { type: 'choice', choice: 'retry-same-cli', probabilities: {}, confidence: 0.9 } }) });
    await adviseCompletionCheck({ missionId: 'm-limit', goal: 'g', acceptanceCriteria: [LIMIT_TEXT], handoffs: [] },
      { judge: async () => result({ covers_goal: { type: 'noul', noul: 0.2 },
        missing: { type: 'choice', choice: 'c1', probabilities: {}, confidence: 0.9 } }) });
    const exposed = JSON.stringify(withMissionDecisionHints({ id: 'm-limit' }));
    expect(exposed).toContain('rate-limit');
    expect(detectLimit(exposed)).toBeNull();
    for (const line of JSON.stringify(withMissionDecisionHints({ id: 'm-limit' }), null, 2).split('\n')) {
      expect(detectLimit(line)).toBeNull();
    }
    expect(detectLimit(completionContextLine(getMissionDecisionHints('m-limit')!.completion!))).toBeNull();
  });
});

describe('P3: memória de ausência e limpeza das dicas', () => {
  it('missão sem dica não relê o disco a cada mission_get/whoami', () => {
    const read = vi.spyOn(fs, 'readFileSync');
    const stat = vi.spyOn(fs, 'statSync');
    try {
      expect(getMissionDecisionHints('m-none')).toBeUndefined();
      const reads = read.mock.calls.length + stat.mock.calls.length;
      for (let index = 0; index < 5; index++) expect(withMissionDecisionHints({ id: 'm-none' })).toEqual({ id: 'm-none' });
      expect(read.mock.calls.length + stat.mock.calls.length).toBe(reads);
    } finally { read.mockRestore(); stat.mockRestore(); }
  });

  it('a dica gravada depois da ausência aparece (a ausência não fica velha)', async () => {
    expect(getMissionDecisionHints('m-late')).toBeUndefined();
    await adviseMissionKickoff(missionKickoffFacts(mission('m-late'), 'pane'), { judge: async () => result(kickoffAnswers()) });
    expect(getMissionDecisionHints('m-late')?.kickoff?.origin).toBe('pane');
  });

  it('boot apaga missão concluída há > 7 dias e órfã há > 30 dias; mantém a recente', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const id of ['m-old-done', 'm-fresh-done', 'm-live', 'm-orphan']) {
      await adviseMissionKickoff(missionKickoffFacts(mission(id), 'conventional'), { judge: async () => result(kickoffAnswers()) });
    }
    recordMissionFinalized('m-old-done', now - 8 * DAY, null);
    recordMissionFinalized('m-fresh-done', now - 2 * DAY, null);
    await flushMissionDecisionHints();
    const orphan = fs.readdirSync(dir).find(file => fs.readFileSync(path.join(dir, file), 'utf8').includes('"m-orphan"'))!;
    fs.utimesSync(path.join(dir, orphan), (now - 31 * DAY) / 1000, (now - 31 * DAY) / 1000);
    expect(await sweepMissionDecisionHints(now)).toBe(2);
    configureMissionDecisionHints(dir);
    expect(getMissionDecisionHints('m-old-done')).toBeUndefined();
    expect(getMissionDecisionHints('m-orphan')).toBeUndefined();
    expect(getMissionDecisionHints('m-fresh-done')?.finalizedAt).toBe(now - 2 * DAY);
    expect(getMissionDecisionHints('m-live')?.kickoff).toBeDefined();
  });

  it('forget apaga memória e arquivo', async () => {
    await adviseMissionKickoff(missionKickoffFacts(mission('m-forget'), 'pane'), { judge: async () => result(kickoffAnswers()) });
    await flushMissionDecisionHints();
    await forgetMissionDecisionHints('m-forget');
    expect(fs.readdirSync(dir)).toHaveLength(0);
    configureMissionDecisionHints(dir);
    expect(getMissionDecisionHints('m-forget')).toBeUndefined();
  });
});
