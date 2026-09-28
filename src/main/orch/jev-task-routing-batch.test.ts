/**
 * Lote do `nexus_route_task`: classificação + sugestão de skill numa ÚNICA
 * chamada judge. Prova: 1 chamada quando as duas operações são elegíveis,
 * nenhuma escolha fora dos allowedSkills, fallback preservado em
 * disabled/no-key/falha/malformado, skill `none` não invalida a classificação
 * e o tier explícito do chamador segue mandando.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jev/jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: () => ({}),
  jevAnswerConfidences: () => ({}),
}));
vi.mock('../jev/jev-autopilot', () => ({ isJevSurfaceEnabled: vi.fn(() => true) }));
vi.mock('../jev/jev-secrets', () => ({ hasJevCredential: vi.fn(() => true) }));

import { recordJevDecision } from '../jev/jev-decision-log';
import {
  USD_PER_INPUT_TOKEN,
  type JevAnswer,
  type JevResult,
  type JudgeInput,
} from '../jev/jev-client';
import {
  classifyTaskWithSkillForRouting,
  routingOverridesFrom,
} from './jev-task-routing';

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;

beforeEach(() => vi.mocked(recordJevDecision).mockClear());

function batchAnswer(skill: JevAnswer, overrides?: Partial<Record<'tier' | 'specialty' | 'effort' | 'escalate', JevAnswer>>): JevResult {
  return {
    model: 'jev-test',
    answers: {
      tier: overrides?.tier ?? { type: 'choice', choice: 'hard', probabilities: { hard: 0.9 }, confidence: 0.9 },
      specialty: overrides?.specialty ?? { type: 'choice', choice: 'bug', probabilities: { bug: 0.9 }, confidence: 0.85 },
      effort: overrides?.effort ?? { type: 'choice', choice: 'high', probabilities: { high: 0.9 }, confidence: 0.9 },
      escalate: overrides?.escalate ?? { type: 'noul', noul: 0.2 },
      skill,
    },
    usage: { input_tokens: 80, output_tokens: 12 },
  };
}

const choice = (name: string, confidence = 0.9): JevAnswer => ({
  type: 'choice',
  choice: name,
  probabilities: { [name]: confidence },
  confidence,
});

const on = { enabled: () => true, hasKey: () => true };

describe('classifyTaskWithSkillForRouting — lote único', () => {
  it('UMA chamada judge quando as duas operações são elegíveis; uso logado uma única vez', async () => {
    const judge = vi.fn<JudgeMock>(async () => batchAnswer(choice('impeccable')));
    const out = await classifyTaskWithSkillForRouting('corrigir race no supervisor', {
      allowedSkills: null,
      sessionId: 'sess-1',
      missionId: 'miss-1',
      deps: { judge, ...on },
    });
    expect(judge).toHaveBeenCalledTimes(1);
    const request = judge.mock.calls[0]![0];
    expect(Object.keys(request.questions).sort()).toEqual([
      'effort', 'escalate', 'skill', 'specialty', 'tier',
    ]);
    expect(request.sessionId).toBe('sess-1');
    expect(request.missionId).toBe('miss-1');
    expect(out).toMatchObject({
      kind: 'classified',
      classification: { tier: 'hard', specialty: 'bug', effort: 'high' },
      skillSuggestion: { name: 'impeccable', pkg: 'impeccable', confidence: 0.9 },
      batch: { requestCount: 1, questionCount: 5 },
    });
    // Uma linha só para o lote inteiro — USD/tokens do resultado único, sem dobrar.
    expect(recordJevDecision).toHaveBeenCalledTimes(1);
    expect(recordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'taskRouting',
        sessionId: 'sess-1',
        missionId: 'miss-1',
        questions: ['tier', 'specialty', 'effort', 'escalate', 'skill'],
        decision: 'tier:hard/bug|skill:impeccable',
        inputTokens: 80,
        usd: 80 * USD_PER_INPUT_TOKEN,
      }),
    );
  });

  it('allowedSkills: critérios só com skills concedidas; escolha fora do catálogo → skill null, classificação intacta', async () => {
    const judge = vi.fn<JudgeMock>(async () => batchAnswer(choice('impeccable')));
    const out = await classifyTaskWithSkillForRouting('task', {
      allowedSkills: ['superpowers'],
      deps: { judge, ...on },
    });
    const skillQuestion = judge.mock.calls[0]![0].questions['skill'] as {
      criteria: Record<string, unknown>;
    };
    const keys = Object.keys(skillQuestion.criteria);
    expect(keys).toContain('none');
    expect(keys).toContain('brainstorming');
    expect(keys).not.toContain('impeccable');
    expect(out).toMatchObject({
      kind: 'classified',
      classification: { tier: 'hard' },
      skillSuggestion: null,
    });
    expect(recordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'tier:hard/bug|skill:none' }),
    );
  });

  it('disabled, no-key, falha e resposta malformada preservam o fallback', async () => {
    const judge = vi.fn<JudgeMock>(async () => batchAnswer(choice('impeccable')));
    const opts = { allowedSkills: null as string[] | null, deps: { judge } };
    expect(await classifyTaskWithSkillForRouting('x', { ...opts, deps: { judge, enabled: () => false, hasKey: () => true } })).toMatchObject({
      kind: 'unavailable', reason: 'disabled', skillSuggestion: null,
    });
    expect(await classifyTaskWithSkillForRouting('x', { ...opts, deps: { judge, enabled: () => true, hasKey: () => false } })).toMatchObject({
      kind: 'unavailable', reason: 'no-key', skillSuggestion: null,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(recordJevDecision).not.toHaveBeenCalled();

    const timingOut = vi.fn<JudgeMock>(async (input) => {
      input.onNoAnswer?.('timeout');
      return null;
    });
    expect(await classifyTaskWithSkillForRouting('x', { allowedSkills: null, deps: { judge: timingOut, ...on } })).toMatchObject({
      kind: 'unavailable', reason: 'timeout', skillSuggestion: null,
      batch: { requestCount: 1, questionCount: 5 },
    });
    expect(recordJevDecision).not.toHaveBeenCalled();

    // Malformado na classificação com skill válida: a skill sobrevive (como
    // no caminho de 2 chamadas), a classificação cai na heurística e o uso do
    // lote ainda é logado uma vez.
    const malformed = batchAnswer(choice('brainstorming'), {
      tier: choice('galactic'),
    });
    expect(
      await classifyTaskWithSkillForRouting('x', {
        allowedSkills: ['superpowers'],
        deps: { judge: vi.fn(async () => malformed), ...on },
      }),
    ).toMatchObject({
      kind: 'unavailable', reason: 'invalid-answer',
      skillSuggestion: { name: 'brainstorming', pkg: 'superpowers' },
    });
    expect(recordJevDecision).toHaveBeenCalledTimes(1);
    expect(recordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'tier:invalid|skill:brainstorming' }),
    );

    // Malformado em tudo: nenhum registro — nada foi usado.
    vi.mocked(recordJevDecision).mockClear();
    const garbage = batchAnswer(choice('none'), { tier: choice('galactic') });
    expect(
      await classifyTaskWithSkillForRouting('x', {
        allowedSkills: null,
        deps: { judge: vi.fn(async () => garbage), ...on },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'invalid-answer', skillSuggestion: null, batch: { requestCount: 1, questionCount: 5 } });
    expect(recordJevDecision).not.toHaveBeenCalled();
  });

  it("skill 'none' não invalida a classificação", async () => {
    const judge = vi.fn<JudgeMock>(async () => batchAnswer(choice('none', 0.95)));
    const out = await classifyTaskWithSkillForRouting('Fix a typo', {
      allowedSkills: null,
      deps: { judge, ...on },
    });
    expect(out).toMatchObject({
      kind: 'classified',
      classification: { tier: 'hard', specialty: 'bug', effort: 'high' },
      skillSuggestion: null,
      batch: { requestCount: 1, questionCount: 5 },
    });
    expect(recordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'tier:hard/bug|skill:none' }),
    );
  });

  it('tier explícito do chamador continua mandando; sem skills elegíveis a pergunta skill nem entra', async () => {
    const judge = vi.fn<JudgeMock>(async () => batchAnswer(choice('impeccable')));
    const out = await classifyTaskWithSkillForRouting('task', {
      allowedSkills: ['zzz-sem-match'],
      deps: { judge, ...on },
    });
    expect(Object.keys(judge.mock.calls[0]![0].questions).sort()).toEqual([
      'effort', 'escalate', 'specialty', 'tier',
    ]);
    expect(out).toMatchObject({
      kind: 'classified',
      skillSuggestion: null,
      batch: { requestCount: 1, questionCount: 4 },
    });
    // O tier do CHAMADOR prevalece sobre o do lote (roster/reserva seguem no
    // caminho do tools-domain, coberto pelos route-tools*.test.ts).
    const classification = out.kind === 'classified' ? out.classification : null;
    expect(routingOverridesFrom(classification, 'easy').tierOverride).toBe('easy');
  });

  it('tarefa em branco é skipped sem chamar o judge', async () => {
    const judge = vi.fn<JudgeMock>(async () => batchAnswer(choice('impeccable')));
    expect(await classifyTaskWithSkillForRouting('   ', { allowedSkills: null, deps: { judge, ...on } })).toEqual({ kind: 'skipped' });
    expect(judge).not.toHaveBeenCalled();
  });
});
