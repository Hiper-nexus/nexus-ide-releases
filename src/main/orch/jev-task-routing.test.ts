import { describe, expect, it, vi } from 'vitest';

vi.mock('../jev/jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: () => ({}),
  jevAnswerConfidences: () => ({}),
}));
vi.mock('../jev/jev-autopilot', () => ({ isJevSurfaceEnabled: vi.fn(() => true) }));
vi.mock('../jev/jev-secrets', () => ({ hasJevCredential: vi.fn(() => true) }));

import { recordJevDecision } from '../jev/jev-decision-log';
import type { JevResult, JudgeInput } from '../jev/jev-client';
import {
  classifyTaskForRouting,
  classifyTaskWithJev,
  routingOverridesFrom,
  type JevTaskClassification,
} from './jev-task-routing';

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
