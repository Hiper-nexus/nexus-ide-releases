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

import {
  buildRankTools,
  rankArgsSchema,
} from './tools-rank';
import { resetJevRateLimitsForTesting } from '../jev/jev-rate-limit';
import type { AgentGateContext } from './gate';

const tool = buildRankTools()[0];
const ctx = { token: 'tok-1', sessionId: 'sess-1' } as AgentGateContext;

const validArgs = {
  candidates: [
    { id: 'a', text: 'delivery A: tests pass, commit abc' },
    { id: 'b', text: 'delivery B: partial implementation' },
  ],
  criteria: [
    {
      id: 'quality',
      instructions: 'How good is the implementation?',
      levels: ['bad', 'ok', 'great'],
    },
    {
      id: 'verified',
      instructions: 'How well verified is it?',
      levels: ['none', 'some', 'proven'],
    },
  ],
  weights: { quality: 2 },
};

function judgeResult(scoreQ: number, scoreV: number, conf = 0.9) {
  return {
    model: 'jev-1.13.0',
    answers: {
      quality: {
        type: 'score',
        score: scoreQ,
        legend: { '0': 'bad', '1': 'ok', '2': 'great' },
        probabilities: {},
        confidence: conf,
      },
      verified: {
        type: 'score',
        score: scoreV,
        legend: { '0': 'none', '1': 'some', '2': 'proven' },
        probabilities: {},
        confidence: conf,
      },
    },
    usage: { input_tokens: 300, output_tokens: 20 },
  };
}

describe('rankArgsSchema', () => {
  it('rejects a single candidate', () => {
    expect(
      rankArgsSchema.safeParse({
        candidates: [{ id: 'a', text: 'x' }],
        criteria: validArgs.criteria,
      }).success,
    ).toBe(false);
  });

  it('rejects a bad candidate id', () => {
    expect(
      rankArgsSchema.safeParse({
        ...validArgs,
        candidates: [
          { id: 'BAD!', text: 'x' },
          { id: 'b', text: 'y' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects criteria with one level', () => {
    expect(
      rankArgsSchema.safeParse({
        ...validArgs,
        criteria: [{ id: 'q', instructions: 'x?', levels: ['only'] }],
      }).success,
    ).toBe(false);
  });

  it('rejects weights that are all zero', () => {
    expect(
      rankArgsSchema.safeParse({
        ...validArgs,
        weights: { quality: 0 },
      }).success,
    ).toBe(false);
  });

  it('accepts valid args', () => {
    expect(rankArgsSchema.safeParse(validArgs).success).toBe(true);
  });
});

describe('nexus_rank handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJevRateLimitsForTesting();
    jev.hasJevCredential.mockReturnValue(true);
    jev.judge
      .mockResolvedValueOnce(judgeResult(2, 2))
      .mockResolvedValue(judgeResult(1, 0));
  });

  it('ranks candidates by weighted composite, sorted desc', async () => {
    const out = (await tool.handler(validArgs, ctx)) as {
      ranking: Array<{ id: string; composite: number }>;
      lowConfidence: string[];
    };
    // a: (2/2 * 2 + 2/2 * 1) / 3 = 1.0 ; b: (1/2*2 + 0) / 3 ≈ 0.333
    expect(out.ranking[0].id).toBe('a');
    expect(out.ranking[0].composite).toBeCloseTo(1);
    expect(out.ranking[1].id).toBe('b');
    expect(out.ranking[1].composite).toBeCloseTo(1 / 3);
    expect(jev.judge).toHaveBeenCalledTimes(2);
  });

  it('flags low-confidence candidates', async () => {
    jev.judge.mockReset();
    jev.judge
      .mockResolvedValueOnce(judgeResult(2, 2, 0.2))
      .mockResolvedValueOnce(judgeResult(1, 1, 0.9));
    const out = (await tool.handler(validArgs, ctx)) as {
      lowConfidence: string[];
    };
    expect(out.lowConfidence).toEqual(['a']);
  });

  it('fails with the settings hint when there is no key', async () => {
    jev.hasJevCredential.mockReturnValue(false);
    await expect(tool.handler(validArgs, ctx)).rejects.toThrow(
      /Chaves de API/,
    );
    expect(jev.judge).not.toHaveBeenCalled();
  });

  it('throws after 30 judge calls in the window for the same session', async () => {
    // cada handler consome um slot por candidato (2 aqui): 15 chamadas = 30
    for (let i = 0; i < 15; i++) {
      jev.judge.mockReset();
      jev.judge.mockResolvedValue(judgeResult(1, 1));
      await tool.handler(validArgs, ctx);
    }
    await expect(tool.handler(validArgs, ctx)).rejects.toThrow(
      /limite de 30 chamadas/,
    );
  });

  it('any candidate judge null → service-unavailable error', async () => {
    jev.judge.mockReset();
    jev.judge
      .mockResolvedValueOnce(judgeResult(1, 1))
      .mockResolvedValueOnce(null);
    await expect(tool.handler(validArgs, ctx)).rejects.toThrow(
      /indisponível agora/,
    );
  });

  it('rejects weights for unknown criteria', async () => {
    await expect(
      tool.handler({ ...validArgs, weights: { nope: 1 } }, ctx),
    ).rejects.toThrow(/critério desconhecido/);
    expect(jev.judge).not.toHaveBeenCalled();
  });

  it('invalid args → readable zod message', async () => {
    await expect(tool.handler({ candidates: [] }, ctx)).rejects.toThrow(
      /argumentos inválidos/,
    );
    expect(jev.judge).not.toHaveBeenCalled();
  });
});
