import { beforeEach, describe, expect, it, vi } from 'vitest';

const jev = vi.hoisted(() => ({
  judge: vi.fn(),
  hasJevCredential: vi.fn(() => true),
}));

vi.mock('../jev/jev-client', () => ({
  judge: jev.judge,
  capText: (t: string) => t,
  USD_PER_INPUT_TOKEN: 0.042 / 1e6,
}));
vi.mock('../jev/jev-secrets', () => ({
  hasJevCredential: jev.hasJevCredential,
}));
vi.mock('../jev/jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  jevAnswerProbabilities: vi.fn(() => ({})),
  jevAnswerConfidences: vi.fn(() => ({})),
}));

import { buildJudgeTools, judgeArgsSchema, resetJudgeRateLimitsForTesting } from './tools-judge';
import type { AgentGateContext } from './gate';

const tool = buildJudgeTools()[0];
const ctx = { token: 'tok-1', sessionId: 'sess-1' } as AgentGateContext;

const validArgs = {
  state: 'some report text',
  questions: {
    is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
  },
};

const okResult = {
  model: 'jev-1.13.0',
  answers: { is_urgent: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe('judgeArgsSchema', () => {
  it('rejects 17 questions', () => {
    const questions = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x?' }]),
    );
    expect(judgeArgsSchema.safeParse({ state: 's', questions }).success).toBe(false);
  });

  it('rejects a bad question id', () => {
    expect(
      judgeArgsSchema.safeParse({
        state: 's',
        questions: { '1bad': { type: 'noul', instructions: 'x?' } },
      }).success,
    ).toBe(false);
  });

  it('rejects choice with a single option', () => {
    expect(
      judgeArgsSchema.safeParse({
        state: 's',
        questions: {
          pick: { type: 'choice', instructions: 'x?', criteria: { only: null } },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects oversized state', () => {
    expect(
      judgeArgsSchema.safeParse({
        state: 'x'.repeat(40_000),
        questions: validArgs.questions,
      }).success,
    ).toBe(false);
  });

  it('accepts the three question types', () => {
    const questions = {
      n: { type: 'noul', instructions: 'yes?' },
      c: {
        type: 'choice',
        instructions: 'pick one',
        criteria: { a: null, b: 'the b option' },
      },
      s: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
    };
    expect(judgeArgsSchema.safeParse({ state: 'x', questions }).success).toBe(true);
  });
});

describe('nexus_judge handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJudgeRateLimitsForTesting();
    jev.hasJevCredential.mockReturnValue(true);
    jev.judge.mockResolvedValue(okResult);
  });

  it('passes the parsed args through to judge and returns the result', async () => {
    const out = (await tool.handler(validArgs, ctx)) as typeof okResult;
    expect(out).toEqual(okResult);
    expect(jev.judge).toHaveBeenCalledWith(
      expect.objectContaining({
        state: validArgs.state,
        model: undefined,
        timeoutMs: 15_000,
      }),
    );
  });

  it('fails with the settings hint when there is no key', async () => {
    jev.hasJevCredential.mockReturnValue(false);
    await expect(tool.handler(validArgs, ctx)).rejects.toThrow(
      /Chaves de API/,
    );
    expect(jev.judge).not.toHaveBeenCalled();
  });

  it('throws after 30 calls in the window for the same session', async () => {
    for (let i = 0; i < 30; i++) {
      await tool.handler(validArgs, ctx);
    }
    await expect(tool.handler(validArgs, ctx)).rejects.toThrow(
      /limite de 30 chamadas/,
    );
  });

  it('rate limit is per-session', async () => {
    for (let i = 0; i < 30; i++) {
      await tool.handler(validArgs, ctx);
    }
    const other = { token: 'tok-2', sessionId: 'sess-2' } as AgentGateContext;
    await expect(tool.handler(validArgs, other)).resolves.toBeTruthy();
  });

  it('judge null → service-unavailable error', async () => {
    jev.judge.mockResolvedValue(null);
    await expect(tool.handler(validArgs, ctx)).rejects.toThrow(
      /indisponível agora/,
    );
  });

  it('invalid args → readable zod message', async () => {
    await expect(tool.handler({ state: 'x' }, ctx)).rejects.toThrow(
      /argumentos inválidos/,
    );
    expect(jev.judge).not.toHaveBeenCalled();
  });
});
