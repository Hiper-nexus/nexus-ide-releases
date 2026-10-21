import { describe, expect, it, vi } from 'vitest';
import type { JevQuestion, JevResult, JudgeInput } from '../jev/jev-client';
import { confirmChoiceOrder, orderCheckCandidates, reversedChoiceQuestions } from './decision-order-check';

const questions: Record<string, JevQuestion> = {
  pick: { type: 'choice', instructions: 'Qual?', criteria: { a: 'opção A', b: 'opção B', none: 'nenhuma' } },
  safe: { type: 'noul', instructions: 'Seguro?' },
};
const choice = (value: string, confidence: number) => ({ type: 'choice' as const, choice: value, confidence, probabilities: { [value]: confidence } });
const result = (answers: JevResult['answers'], extra: Partial<JevResult> = {}): JevResult => ({
  model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 }, requestCount: 1, estimatedUsd: 0.000004, ...extra,
});
const input = (minConfidence = 0.7): JudgeInput & { orderCheck: { minConfidence: number } } => ({
  state: { task: 'x' }, questions, surface: 'helperReuse', sessionId: 's', orderCheck: { minConfidence },
});

describe('F-1626: viés da primeira opção', () => {
  it('só a 1ª opção vencedora com confiança limítrofe é candidata', () => {
    expect(orderCheckCandidates(questions, { pick: choice('a', 0.72) }, { minConfidence: 0.7 })).toEqual(['pick']);
    expect(orderCheckCandidates(questions, { pick: choice('b', 0.72) }, { minConfidence: 0.7 })).toEqual([]);
    expect(orderCheckCandidates(questions, { pick: choice('a', 0.95) }, { minConfidence: 0.7 })).toEqual([]);
    expect(orderCheckCandidates(questions, { pick: choice('a', 0.5) }, { minConfidence: 0.7 })).toEqual([]);
    expect(orderCheckCandidates(questions, { safe: { type: 'noul', noul: 0.8 } }, { minConfidence: 0.7 })).toEqual([]);
  });

  it('a segunda consulta leva só a pergunta suspeita, com as opções invertidas', () => {
    const reversed = reversedChoiceQuestions(questions, ['pick']);
    expect(Object.keys(reversed)).toEqual(['pick']);
    expect(Object.keys((reversed.pick as { criteria: Record<string, string> }).criteria)).toEqual(['none', 'b', 'a']);
  });

  it('escolha que se mantém fica, e o custo soma as duas consultas', async () => {
    const run = vi.fn<(input: JudgeInput) => Promise<JevResult>>(async () => result({ pick: choice('a', 0.8) }));
    const out = await confirmChoiceOrder(input(), result({ pick: choice('a', 0.72), safe: { type: 'noul', noul: 0.1 } }), run);
    expect(out.answers.pick).toMatchObject({ choice: 'a' });
    expect(out.orderCheck).toEqual({ checked: ['pick'], unstable: [] });
    expect(out.requestCount).toBe(2);
    expect(out.estimatedUsd).toBeCloseTo(0.000008, 10);
    const second = run.mock.calls[0]![0];
    expect(Object.keys(second.questions)).toEqual(['pick']);
    expect('orderCheck' in second).toBe(false);
    expect(second).toMatchObject({ surface: 'helperReuse', sessionId: 's' });
  });

  it('escolha que muda com a ordem sai do resultado; o resto fica', async () => {
    const run = vi.fn(async () => result({ pick: choice('none', 0.6) }));
    const out = await confirmChoiceOrder(input(), result({ pick: choice('a', 0.72), safe: { type: 'noul', noul: 0.1 } }), run);
    expect(out.answers.pick).toBeUndefined();
    expect(out.answers.safe).toEqual({ type: 'noul', noul: 0.1 });
    expect(out.orderCheck).toEqual({ checked: ['pick'], unstable: ['pick'] });
  });

  it('segunda consulta sem resposta não confirma: a escolha suspeita sai', async () => {
    const out = await confirmChoiceOrder(input(), result({ pick: choice('a', 0.72) }), async () => null);
    expect(out.answers.pick).toBeUndefined();
    expect(out.orderCheck?.unstable).toEqual(['pick']);
  });

  it('sem candidata não há segunda consulta', async () => {
    const run = vi.fn();
    const first = result({ pick: choice('b', 0.72) });
    expect(await confirmChoiceOrder(input(), first, run)).toBe(first);
    expect(run).not.toHaveBeenCalled();
  });
});
