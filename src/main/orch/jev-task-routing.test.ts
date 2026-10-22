import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jev/jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: () => ({}),
  jevAnswerConfidences: () => ({}),
}));
vi.mock('../jev/jev-autopilot', () => ({ isJevSurfaceEnabled: vi.fn(() => true) }));
vi.mock('../jev/jev-secrets', () => ({ hasJevCredential: vi.fn(() => true) }));

import { recordJevDecision } from '../jev/jev-decision-log';
import { bumpDecisionCredentialRevision } from '../decision-models/decision-revision';
import type { JevResult, JudgeInput } from '../jev/jev-client';
import {
  classifyTaskForRouting,
  classifyTaskWithJev,
  classifyTaskWithSkillForRouting,
  clearTaskRoutingCacheForTests,
  routingOverridesFrom,
  type JevTaskClassification,
} from './jev-task-routing';

// O cache curto do Jev da rota é do processo: cada caso começa frio.
beforeEach(() => clearTaskRoutingCacheForTests());

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;

function answer(
  tier: string,
  tierConfidence: number,
  specialty: string,
  specialtyConfidence: number,
  escalate = 0.1,
  effort = 'medium',
  effortConfidence = 0.9,
): JevResult {
  return {
    model: 'jev-test',
    answers: {
      tier: { type: 'choice', choice: tier, probabilities: { [tier]: 0.9 }, confidence: tierConfidence },
      specialty: {
        type: 'choice',
        choice: specialty,
        probabilities: { [specialty]: 0.9 },
        confidence: specialtyConfidence,
      },
      escalate: { type: 'noul', noul: escalate },
      effort: { type: 'choice', choice: effort, probabilities: { [effort]: 0.9 }, confidence: effortConfidence },
    },
    usage: { input_tokens: 80, output_tokens: 12 },
  };
}

describe('deterministic REA in batch routing', () => {
  it.each(['disabled', 'no-key', 'network', 'throws', 'invalid-answer', 'classified'] as const)('retains REA when classification is %s', async (mode) => {
    const judge = vi.fn<JudgeMock>(async () => {
      if (mode === 'throws') throw new Error('offline');
      if (mode === 'network') return null;
      const result = answer(mode === 'invalid-answer' ? 'unknown' : 'hard', 0.9, 'general', 0.9);
      result.answers.skill = { type: 'choice', choice: 'ponytail', confidence: 0.99, probabilities: {} };
      return result;
    });
    const result = await classifyTaskWithSkillForRouting('Reverse engineer this binary.', {
      allowedSkills: null,
      deps: { judge, enabled: () => mode !== 'disabled', hasKey: () => mode !== 'no-key' },
    });
    expect(result).toMatchObject({
      kind: mode === 'classified' ? 'classified' : 'unavailable',
      skillSuggestion: { name: 'rea', pkg: 'rea', confidence: 1 },
    });
    if (mode === 'classified') expect(result).toMatchObject({ classification: { tier: 'hard' } });
  });

  it.each([{ allowedSkills: [] }, { allowedSkills: ['ponytail'] }])('never widens explicit grants $allowedSkills', async ({ allowedSkills }) => {
    const result = await classifyTaskWithSkillForRouting('Decompile this library.', {
      allowedSkills, deps: { enabled: () => false },
    });
    expect(result).toMatchObject({ kind: 'unavailable', skillSuggestion: null });
  });
});

describe('classifyTaskWithJev', () => {
  it('returns the typed classification and records one decision', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('hard', 0.8, 'bug', 0.7, 0.4));
    const out = await classifyTaskWithJev('corrigir race condition no supervisor', { judge });
    expect(out).toEqual({
      tier: 'hard',
      tierConfidence: 0.8,
      specialty: 'bug',
      specialtyConfidence: 0.7,
      effort: 'medium',
      effortConfidence: 0.9,
      escalate: 0.4,
      model: 'jev-test',
    });
    expect(recordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'taskRouting', decision: 'tier:hard/bug' }),
    );
    const state = judge.mock.calls[0]![0].state as { task: string };
    expect(state.task).toContain('race condition');
    // Rota no caminho crítico do spawn: sem retry de transporte no timeout.
    expect(judge.mock.calls[0]![0].retryOnTimeout).toBe(false);
    expect(judge.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(3_000);
    // F-1626: viés da 1ª opção reconferido no limiar de aceite da rota.
    expect(judge.mock.calls[0]![0].orderCheck).toEqual({ minConfidence: 0.6 });
  });

  it('returns null when disabled, without a key, on empty task, or when the judge fails', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('easy', 0.9, 'doc', 0.9));
    expect(await classifyTaskWithJev('x', { judge, enabled: () => false })).toBeNull();
    expect(await classifyTaskWithJev('x', { judge, hasKey: () => false })).toBeNull();
    expect(await classifyTaskWithJev('   ', { judge })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
    expect(await classifyTaskWithJev('x', { judge: vi.fn(async () => null) })).toBeNull();
  });

  it('returns null on an unknown tier or specialty value', async () => {
    expect(
      await classifyTaskWithJev('x', { judge: vi.fn(async () => answer('galactic', 0.9, 'bug', 0.9)) }),
    ).toBeNull();
    expect(
      await classifyTaskWithJev('x', { judge: vi.fn(async () => answer('easy', 0.9, 'cooking', 0.9)) }),
    ).toBeNull();
  });
});

describe('classifyTaskForRouting', () => {
  it('asks for independent effort and keeps other fields if that answer is missing or invalid', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('critical', 0.9, 'security', 0.9, 0.1, 'low'));
    expect(await classifyTaskForRouting('Read an auth setting', { judge })).toMatchObject({
      kind: 'classified', classification: { tier: 'critical', effort: 'low', effortConfidence: 0.9 },
    });
    expect(judge.mock.calls[0]![0].questions.effort).toMatchObject({
      type: 'choice', criteria: { low: expect.any(String), medium: expect.any(String), high: expect.any(String), xhigh: expect.any(String) },
    });
    for (const effort of ['invalid', undefined]) {
      const result = answer('easy', 0.9, 'doc', 0.8);
      if (effort) result.answers.effort = { type: 'choice', choice: effort, confidence: 0.9, probabilities: {} };
      else delete result.answers.effort;
      expect(await classifyTaskForRouting('Fix a typo', { judge: async () => result })).toMatchObject({
        kind: 'classified', classification: { tier: 'easy', specialty: 'doc', effort: undefined },
      });
    }
  });

  it('classified quando o Jev responde', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('hard', 0.8, 'bug', 0.7));
    const out = await classifyTaskForRouting('corrigir race', { judge });
    expect(out).toMatchObject({ kind: 'classified', classification: { tier: 'hard' } });
  });

  it('unavailable com o motivo: desligado, sem chave, resposta inválida e falha do judge', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('easy', 0.9, 'doc', 0.9));
    expect(await classifyTaskForRouting('x', { judge, enabled: () => false })).toEqual({
      kind: 'unavailable',
      reason: 'disabled',
    });
    expect(await classifyTaskForRouting('x', { judge, hasKey: () => false })).toEqual({
      kind: 'unavailable',
      reason: 'no-key',
    });
    expect(
      await classifyTaskForRouting('x', {
        judge: vi.fn<JudgeMock>(async () => answer('galactic', 0.9, 'bug', 0.9)),
      }),
    ).toEqual({ kind: 'unavailable', reason: 'invalid-answer' });
    const timingOut = vi.fn<JudgeMock>(async (input) => {
      input.onNoAnswer?.('timeout');
      return null;
    });
    expect(await classifyTaskForRouting('x', { judge: timingOut })).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    });
  });

  it('judge null sem callback vira network; tarefa em branco é skipped', async () => {
    expect(
      await classifyTaskForRouting('x', { judge: vi.fn<JudgeMock>(async () => null) }),
    ).toEqual({ kind: 'unavailable', reason: 'network' });
    expect(await classifyTaskForRouting('   ', {})).toEqual({ kind: 'skipped' });
  });
});

describe('routingOverridesFrom', () => {
  const full: JevTaskClassification = {
    tier: 'critical',
    tierConfidence: 0.9,
    specialty: 'security',
    specialtyConfidence: 0.8,
    effort: 'high',
    effortConfidence: 0.9,
    escalate: 0.7,
    model: 'jev-test',
  };

  it('uses all three Jev fields when confident (source jev)', () => {
    expect(routingOverridesFrom(full, undefined)).toEqual({
      tierOverride: 'critical',
      specialtyOverride: 'security',
      effortOverride: 'high',
      classifierSource: 'jev',
      escalate: 0.7,
      confidence: { tier: 0.9, specialty: 0.8, effort: 0.9 },
    });
  });

  it('falls back per field below the confidence floor (source mixed / heuristic)', () => {
    expect(routingOverridesFrom({ ...full, tierConfidence: 0.3 }, undefined)).toMatchObject({
      tierOverride: undefined,
      specialtyOverride: 'security',
      classifierSource: 'mixed',
    });
    expect(
      routingOverridesFrom({ ...full, tierConfidence: 0.3, specialtyConfidence: 0.2, effortConfidence: 0.2 }, undefined),
    ).toMatchObject({ tierOverride: undefined, specialtyOverride: undefined, classifierSource: 'heuristic' });
  });

  it('quando todas as confianças do Jev são < 0,6, marca jevUnavailable: low-confidence (F-1265)', () => {
    const lowConf = routingOverridesFrom(
      { ...full, tierConfidence: 0.3, specialtyConfidence: 0.2, effortConfidence: 0.2 },
      undefined,
    );
    expect(lowConf.classifierSource).toBe('heuristic');
    expect(lowConf.jevUnavailable).toBe('low-confidence');
  });

  it('the caller-provided tier always wins over Jev', () => {
    const out = routingOverridesFrom(full, 'easy');
    expect(out.tierOverride).toBe('easy');
    expect(out.specialtyOverride).toBe('security');
    expect(out.classifierSource).toBe('mixed');
  });

  it('null classification → heuristic with the caller tier, no escalate', () => {
    expect(routingOverridesFrom(null, 'medium')).toEqual({
      tierOverride: 'medium',
      specialtyOverride: undefined,
      effortOverride: undefined,
      classifierSource: 'heuristic',
      escalate: undefined,
    });
  });

  it('confidence fallback is independent for effort and preserves a confident low judgment', () => {
    expect(routingOverridesFrom({ ...full, effort: 'low' }, undefined)).toMatchObject({
      tierOverride: 'critical', specialtyOverride: 'security', effortOverride: 'low', classifierSource: 'jev',
    });
    expect(routingOverridesFrom({ ...full, effortConfidence: 0.45 }, undefined)).toMatchObject({
      tierOverride: 'critical', effortOverride: undefined, classifierSource: 'mixed',
    });
    expect(routingOverridesFrom({ ...full, tierConfidence: 0.2, specialtyConfidence: 0.2 }, undefined)).toMatchObject({
      tierOverride: undefined, specialtyOverride: undefined, effortOverride: 'high', classifierSource: 'mixed',
    });
  });
});

describe('routingOverridesFrom — confiança do recibo (só dimensão que o Jev decidiu)', () => {
  const full: JevTaskClassification = {
    tier: 'medium',
    tierConfidence: 0.82,
    specialty: 'feature',
    specialtyConfidence: 0.71,
    effort: 'medium',
    effortConfidence: 0.66,
    escalate: 0.1,
    model: 'jev-test',
  };

  it('expõe a confiança das três dimensões aceitas', () => {
    expect(routingOverridesFrom(full, undefined).confidence).toEqual({
      tier: 0.82,
      specialty: 0.71,
      effort: 0.66,
    });
  });

  it('0,59 não vira número: a dimensão caiu para a heurística, então não ganha confiança', () => {
    const out = routingOverridesFrom({ ...full, tierConfidence: 0.59 }, undefined);
    expect(out.confidence).toEqual({ specialty: 0.71, effort: 0.66 });
    expect(out.confidence).not.toHaveProperty('tier');
    // O piso é inclusivo: 0,6 exato foi aceito pelo roteador e aparece.
    expect(routingOverridesFrom({ ...full, tierConfidence: 0.6 }, undefined).confidence).toMatchObject({ tier: 0.6 });
  });

  it('arredonda a 2 casas', () => {
    expect(
      routingOverridesFrom(
        { ...full, tierConfidence: 0.8349, specialtyConfidence: 0.7551, effortConfidence: 0.6 },
        undefined,
      ).confidence,
    ).toEqual({ tier: 0.83, specialty: 0.76, effort: 0.6 });
  });

  it('tier do chamador manda: sem confiança de tier, o resto segue', () => {
    expect(routingOverridesFrom(full, 'easy').confidence).toEqual({ specialty: 0.71, effort: 0.66 });
  });

  it('esforço ausente ou inválido não ganha número mesmo com confiança alta', () => {
    const out = routingOverridesFrom({ ...full, effort: undefined, effortConfidence: 0.95 }, undefined);
    expect(out.confidence).toEqual({ tier: 0.82, specialty: 0.71 });
  });

  it('sem classificação ou sem nenhuma dimensão aceita: nada de objeto vazio', () => {
    expect(routingOverridesFrom(null, 'medium').confidence).toBeUndefined();
    expect(
      routingOverridesFrom(
        { ...full, tierConfidence: 0.2, specialtyConfidence: 0.2, effortConfidence: 0.2 },
        undefined,
      ).confidence,
    ).toBeUndefined();
  });

  it('piso de revisão de código: o tier final não é o do Jev, então não carrega o número dele', () => {
    const review = 'Revisão de código SÊNIOR (staff), SOMENTE LEITURA, da rodada final antes de publicar.';
    const jevTrivial: JevTaskClassification = { ...full, tier: 'trivial', tierConfidence: 0.9 };
    const out = routingOverridesFrom(jevTrivial, undefined, review);
    expect(out.tierOverride).toBe('hard');
    expect(out.confidence).not.toHaveProperty('tier');
    // Quando o Jev já está no piso ou acima dele, o número é dele e fica.
    expect(
      routingOverridesFrom({ ...full, tier: 'critical', tierConfidence: 0.9 }, undefined, review).confidence,
    ).toMatchObject({ tier: 0.9 });
  });
});

describe('routingOverridesFrom — piso de revisão de código sobre o tier do Jev (27/09)', () => {
  const review =
    'Revisão de código SÊNIOR (staff), SOMENTE LEITURA, com o modelo GPT-6 Astra ' +
    '(Codex, esforço xhigh), da rodada final G antes de publicar.';
  const jevTrivial: JevTaskClassification = {
    tier: 'trivial',
    tierConfidence: 0.9,
    specialty: 'general',
    specialtyConfidence: 0.8,
    escalate: 0.7,
    model: 'jev-test',
  };

  it('Jev confiante em trivial não rebaixa uma revisão de código', () => {
    expect(routingOverridesFrom(jevTrivial, undefined, review).tierOverride).toBe('hard');
    expect(routingOverridesFrom({ ...jevTrivial, tier: 'critical' }, undefined, review).tierOverride).toBe('critical');
  });

  it('revisão de texto e tier do chamador seguem como antes', () => {
    expect(routingOverridesFrom(jevTrivial, undefined, 'revisar o texto do README').tierOverride).toBe('trivial');
    expect(routingOverridesFrom(jevTrivial, 'easy', review).tierOverride).toBe('easy');
  });
});

describe('lote do route_task: skills do projeto numa pergunta própria (F-753)', () => {
  it('uma chamada só leva tier, skill bundled e skill do projeto; a mais confiante sai com o caminho', async () => {
    const base = answer('medium', 0.9, 'doc', 0.9);
    const judge = vi.fn<JudgeMock>(async () => ({
      ...base,
      answers: {
        ...base.answers,
        skill: { type: 'choice', choice: 'writing-plans', probabilities: {}, confidence: 0.74 },
        projectSkill: { type: 'choice', choice: 'bmad-index-docs', probabilities: {}, confidence: 0.82 },
      },
    }));
    const out = await classifyTaskWithSkillForRouting('preparar mapa das peças documentais de fechamento', {
      allowedSkills: null,
      projectRoot: '/w/hipergo',
      deps: {
        judge,
        enabled: () => true,
        hasKey: () => true,
        scanProjectSkills: (dir) =>
          dir.replaceAll('\\', '/').endsWith('/hipergo/.claude/skills')
            ? [{ name: 'bmad-index-docs', description: 'Index the docs of the project.' }]
            : [],
      },
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(Object.keys(judge.mock.calls[0]![0].questions)).toEqual(
      expect.arrayContaining(['tier', 'specialty', 'skill', 'projectSkill']),
    );
    expect(out).toMatchObject({
      kind: 'classified',
      skillSuggestion: {
        name: 'bmad-index-docs',
        pkg: 'project',
        confidence: 0.82,
        path: '.claude/skills/bmad-index-docs/SKILL.md',
      },
      batch: { requestCount: 1 },
    });
  });

  it('F-1309: sem chave devolve reason no-key — sinal explícito, não silêncio', async () => {
    const judge = vi.fn<JudgeMock>(async () => null);
    const out = await classifyTaskWithSkillForRouting('corrigir o bug do login', {
      allowedSkills: null,
      deps: { judge, enabled: () => true, hasKey: () => false },
    });
    expect(out).toEqual({
      kind: 'unavailable',
      reason: 'no-key',
      skillSuggestion: null,
      batch: { requestCount: 0, questionCount: 0 },
    });
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('F-1346 (parte 2): tarefa longa chega ao Jev com o pedido do FIM', () => {
  const ask = 'PEDIDO DECISIVO: corrija o deadlock do scheduler em produção.';
  const long = `Contexto da tarefa. ${'contexto '.repeat(1_200)} ${ask}`;

  it('classifyTaskForRouting e classifyTaskWithSkillForRouting mandam cabeça + cauda', async () => {
    const judge = vi.fn<JudgeMock>(async () => null);
    const on = { enabled: () => true, hasKey: () => true };
    await classifyTaskForRouting(long, { judge, ...on });
    await classifyTaskWithSkillForRouting(long, { allowedSkills: null, deps: { judge, ...on } });
    expect(judge).toHaveBeenCalledTimes(2);
    for (const call of judge.mock.calls) {
      const task = (call[0].state as { task: string }).task;
      expect(task).toContain('Contexto da tarefa.');
      expect(task).toContain(ask);
      expect(task.length).toBeLessThan(3_100);
    }
  });
});

// route-resolve p50 1,7 s (16/10): pedidos iguais em voo dividem a mesma chamada
// judge e a classificação aceita fica 60 s; falha não fica no cache.
describe('single-flight + cache curto do Jev da rota', () => {
  const on = { enabled: () => true, hasKey: () => true };

  it('pedidos iguais em voo dividem uma chamada; o repetido em 60 s não chama de novo', async () => {
    let release!: () => void;
    const judge = vi.fn<JudgeMock>(async () => answer('easy', 0.9, 'doc', 0.9));
    judge.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve(answer('hard', 0.8, 'bug', 0.7));
      }),
    );
    const opts = { allowedSkills: null, deps: { judge, ...on } };
    const first = classifyTaskWithSkillForRouting('corrigir race no supervisor', opts);
    const second = classifyTaskWithSkillForRouting('corrigir race no supervisor', opts);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'classified' });
    await classifyTaskWithSkillForRouting('corrigir race no supervisor', opts);
    expect(judge).toHaveBeenCalledTimes(1);
    // Outra tarefa, outra chave.
    await classifyTaskWithSkillForRouting('corrigir typo no README', opts);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('timeout não fica no cache e o próximo pedido tenta de novo', async () => {
    const judge = vi.fn<JudgeMock>(async (input) => {
      input.onNoAnswer?.('timeout');
      return null;
    });
    expect(await classifyTaskForRouting('mapear o módulo', { judge, ...on })).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    });
    judge.mockImplementation(async () => answer('medium', 0.8, 'general', 0.8));
    expect(await classifyTaskForRouting('mapear o módulo', { judge, ...on })).toMatchObject({
      kind: 'classified',
    });
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('cache vencido (60 s) chama o Jev de novo; desligar vale na hora', async () => {
    vi.useFakeTimers();
    try {
      const judge = vi.fn<JudgeMock>(async () => answer('easy', 0.9, 'doc', 0.9));
      await classifyTaskWithJev('atualizar doc', { judge, ...on });
      expect(await classifyTaskWithJev('atualizar doc', { judge, ...on, enabled: () => false })).toBeNull();
      vi.advanceTimersByTime(59_000);
      await classifyTaskWithJev('atualizar doc', { judge, ...on });
      expect(judge).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      await classifyTaskWithJev('atualizar doc', { judge, ...on });
      expect(judge).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Revisão independente (16/10): a chave do cache ignorava a configuração de decisão, então uma
// rotação de credencial ou troca de modelo devolvia a classificação de quem já não está configurado.
describe('o cache do Jev da rota obedece à configuração de decisão', () => {
  const on = { enabled: () => true, hasKey: () => true };
  const savedModel = process.env.NEXUS_JEV_MODEL;
  afterEach(() => {
    if (savedModel === undefined) delete process.env.NEXUS_JEV_MODEL;
    else process.env.NEXUS_JEV_MODEL = savedModel;
  });

  it('rotação de credencial não reaproveita a classificação em cache', async () => {
    const judge = vi.fn<JudgeMock>(async () => answer('easy', 0.9, 'doc', 0.9));
    await classifyTaskForRouting('revisar a rotação', { judge, ...on });
    await classifyTaskForRouting('revisar a rotação', { judge, ...on });
    expect(judge).toHaveBeenCalledTimes(1);
    bumpDecisionCredentialRevision();
    judge.mockImplementation(async () => answer('hard', 0.9, 'bug', 0.9));
    expect(await classifyTaskForRouting('revisar a rotação', { judge, ...on })).toMatchObject({
      kind: 'classified',
      classification: { tier: 'hard' },
    });
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('troca de modelo do Jev não reaproveita a classificação, nem no lote com skills', async () => {
    process.env.NEXUS_JEV_MODEL = 'jev-a';
    const judge = vi.fn<JudgeMock>(async () => answer('easy', 0.9, 'doc', 0.9));
    const opts = { allowedSkills: null, deps: { judge, ...on } };
    await classifyTaskWithSkillForRouting('trocar o modelo', opts);
    await classifyTaskWithSkillForRouting('trocar o modelo', opts);
    expect(judge).toHaveBeenCalledTimes(1);
    process.env.NEXUS_JEV_MODEL = 'jev-b';
    await classifyTaskWithSkillForRouting('trocar o modelo', opts);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('classificação que termina depois de a configuração mudar não entra no cache', async () => {
    process.env.NEXUS_JEV_MODEL = 'jev-a';
    const judge = vi.fn<JudgeMock>(async () => {
      process.env.NEXUS_JEV_MODEL = 'jev-b';
      return answer('easy', 0.9, 'doc', 0.9);
    });
    await classifyTaskForRouting('mudar no meio da chamada', { judge, ...on });
    // De volta à configuração da chave original: a resposta dada sob a outra não pode ser servida.
    process.env.NEXUS_JEV_MODEL = 'jev-a';
    await classifyTaskForRouting('mudar no meio da chamada', { judge, ...on });
    expect(judge).toHaveBeenCalledTimes(2);
  });
});
