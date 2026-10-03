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
import { adviseDelegation, advisePrompt, DELEGATE_MIN_PROMPT_CHARS } from './jev-delegation';

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;
const LONG = 'Implemente a tela de login, escreva os testes e revise a segurança do fluxo inteiro.';

function verdict(
  divisible: number,
  parts: string,
  writers: string,
  writesCode = 0.1,
  heavyRead?: number,
): JevResult {
  return {
    model: 'jev-test',
    answers: {
      divisible: { type: 'noul', noul: divisible },
      parts: { type: 'choice', choice: parts, probabilities: {}, confidence: 0.8 },
      writers: { type: 'choice', choice: writers, probabilities: {}, confidence: 0.8 },
      writesCode: { type: 'noul', noul: writesCode },
      ...(heavyRead === undefined ? {} : { heavyRead: { type: 'noul' as const, noul: heavyRead } }),
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

describe('advisePrompt', () => {
  it('pergunta na MESMA chamada se a mensagem pede para escrever código', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.2, '1', '1', 0.9));
    expect(await advisePrompt(LONG, { judge })).toEqual({ delegation: null, writesCode: 0.9 });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(Object.keys(judge.mock.calls[0]![0].questions)).toContain('writesCode');
  });

  it('traz o conselho de delegação junto', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.8, '3', '1', 0.7));
    expect(await advisePrompt(LONG, { judge })).toEqual({
      delegation: { parts: 3, writers: 1, confidence: 0.8, model: 'jev-test' },
      writesCode: 0.7,
    });
  });

  it('a régua divisible cobre apps/superfícies separadas (F-200) e vários problemas numa mensagem só (F-784)', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.8, '2', '1'));
    await advisePrompt(LONG, { judge });
    const questions = judge.mock.calls[0]![0].questions;
    const divisible = questions.divisible;
    expect(divisible?.type).toBe('noul');
    if (divisible?.type !== 'noul') return;
    expect(divisible.criteria?.true).toBe(
      'several independent pieces of work (research, implementation, tests, review…), ' +
        'a message that lists several distinct problems or requests (even in one ' +
        'paragraph or as a follow-up), or the same feature or fix to be built in ' +
        'separate apps or surfaces (for example the native app and the web or PWA)',
    );
    expect(divisible.criteria?.false).toBe(
      'one cohesive task, a small change, a single bug, a question or conversation, ' +
        'or a short follow-up or confirmation of work already under way',
    );
  });

  it('sem resposta de writesCode, a probabilidade vale 0', async () => {
    const judge = vi.fn<JudgeMock>(async () => {
      const result = verdict(0.2, '1', '0');
      delete (result.answers as Record<string, unknown>).writesCode;
      return result;
    });
    expect(await advisePrompt(LONG, { judge })).toEqual({ delegation: null, writesCode: 0 });
  });
});

describe('F-784: decisão de delegação em casos representativos', () => {
  // Pedido real de 03/10 (11:02), reescrito: varrer tudo o que existe — uma
  // leitura grande, sem partes independentes declaradas.
  const SCAN =
    'algo que temos que ter inteligente: saber qual modelo usar, quando e com qual esforço, ' +
    'e varrer todas as LLMs que temos disponíveis, todas mesmo, desde o Qwen';
  const THREE_PARTS =
    'Corrija o login que trava no Safari, adicione exportação CSV no relatório de vendas ' +
    'e atualize a documentação da API pública.';

  it('"oi, tudo bem?" continua solo e nem chama o Jev', async () => {
    const judge = vi.fn<JudgeMock>();
    expect(await advisePrompt('oi, tudo bem?', { judge })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('pedido com 3 partes independentes recebe delegate:3p', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.84, '3', '2', 0.9, 0.2));
    expect((await advisePrompt(THREE_PARTS, { judge }))?.delegation).toEqual({
      parts: 3, writers: 2, confidence: 0.84, model: 'jev-test',
    });
    expect(recordJevDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'delegate:3p/2w' }),
    );
  });

  it('leitura pesada sem partes vai para UM helper readOnly (antes: solo)', async () => {
    // Probabilidades do pedido de 11:02 no decisions.jsonl: divisible 0,49 → solo.
    const judge = vi.fn<JudgeMock>(async () => verdict(0.49, '2', '0', 0.12, 0.86));
    const advice = await advisePrompt(SCAN, { judge });
    expect(advice?.delegation).toEqual({
      parts: 1, writers: 0, confidence: 0.86, model: 'jev-test', heavyRead: true,
    });
    expect(recordJevDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'delegate:heavy-read' }),
    );
    expect(Object.keys(judge.mock.calls[0]![0].questions)).toContain('heavyRead');
  });

  it('leitura pequena, pergunta ou conversa seguem no pane (heavyRead abaixo de 0,7)', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.13, '1', '0', 0.2, 0.65));
    expect((await advisePrompt('atualiza nosso repositório local com o github, por favor', { judge }))?.delegation)
      .toBeNull();
    expect(recordJevDecision).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'solo' }));
  });

  it('partes independentes valem mais que a leitura pesada (o leque não vira um helper só)', async () => {
    const judge = vi.fn<JudgeMock>(async () => verdict(0.86, '5+', '2+', 0.88, 0.9));
    expect((await advisePrompt(SCAN, { judge }))?.delegation).toMatchObject({ parts: 5, writers: 2 });
    expect((await advisePrompt(SCAN, { judge }))?.delegation).not.toHaveProperty('heavyRead');
  });
});
