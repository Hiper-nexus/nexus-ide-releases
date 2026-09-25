import { describe, expect, it, vi } from 'vitest';

vi.mock('./jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: () => ({}),
  jevAnswerConfidences: () => ({}),
}));
vi.mock('./jev-autopilot', () => ({ isJevSurfaceEnabled: vi.fn(() => true) }));
vi.mock('./jev-secrets', () => ({ hasJevCredential: vi.fn(() => true) }));

import type { JevResult, JudgeInput } from './jev-client';
import { recordJevDecision } from './jev-decision-log';
import { adviseDelegation, DELEGATE_MIN_PROMPT_CHARS } from './jev-delegation';

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;
const LONG = 'Implemente a tela de login, escreva os testes e revise a segurança do fluxo inteiro.';

function verdict(divisible: number, parts: string, writers: string): JevResult {
  return {
    model: 'jev-test',
    answers: {
      divisible: { type: 'noul', noul: divisible },
      parts: { type: 'choice', choice: parts, probabilities: {}, confidence: 0.8 },
      writers: { type: 'choice', choice: writers, probabilities: {}, confidence: 0.8 },
    },
    usage: { input_tokens: 50, output_tokens: 5 },
  };
}

describe('adviseDelegation', () => {
  it('aconselha com 2+ partes e confiança ≥ 0,6, e registra a decisão', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.8, '3', '1'));
    expect(await adviseDelegation(LONG, { judge })).toEqual({
      parts: 3, writers: 1, confidence: 0.8, model: 'jev-test',
    });
    expect(judge.mock.calls[0]![0]).toMatchObject({ surface: 'delegation', timeoutMs: 2_500 });
    expect(recordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'delegation', decision: 'delegate:3p/1w' }),
    );
  });

  it('5+ vira 5 e 2+ vira 2', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.9, '5+', '2+'));
    expect(await adviseDelegation(LONG, { judge })).toMatchObject({ parts: 5, writers: 2 });
  });

  it('silêncio: 1 parte, pouca confiança, Jev fora, desligado, sem chave', async () => {
    expect(await adviseDelegation(LONG, { judge: vi.fn<JudgeMock>(async () => verdict(0.9, '1', '0')) })).toBeNull();
    expect(await adviseDelegation(LONG, { judge: vi.fn<JudgeMock>(async () => verdict(0.4, '3', '0')) })).toBeNull();
    expect(await adviseDelegation(LONG, { judge: vi.fn<JudgeMock>(async () => null) })).toBeNull();
    const judge = vi.fn<JudgeMock>();
    expect(await adviseDelegation(LONG, { judge, enabled: () => false })).toBeNull();
    expect(await adviseDelegation(LONG, { judge, hasKey: () => false })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it(`mensagem com menos de ${DELEGATE_MIN_PROMPT_CHARS} caracteres não chama o Jev`, async () => {
    const judge = vi.fn<JudgeMock>();
    expect(await adviseDelegation('siga', { judge })).toBeNull();
    expect(await adviseDelegation('   ok   ', { judge })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('segredo colado na mensagem sai mascarado no state do judge', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.9, '2', '0'));
    // O judge real aplica redactState; aqui provamos que a mensagem vai crua
    // SÓ até o judge, que é quem redige — o teste do jev-client cobre a redação.
    const secret = `sk-ant-${'x'.repeat(40)}`;
    await adviseDelegation(`${LONG} chave ${secret}`, { judge });
    const { redactState } = await import('./jev-client');
    const sent = redactState(judge.mock.calls[0]![0].state) as { message: string };
    expect(sent.message).not.toContain(secret);
  });
});
