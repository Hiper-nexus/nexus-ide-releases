import { describe, expect, it, vi } from 'vitest';

const { mockRecordJevDecision } = vi.hoisted(() => ({
  mockRecordJevDecision: vi.fn(),
}));

vi.mock('../jev/jev-decision-log', () => ({
  jevAnswerConfidences: vi.fn(() => ({})),
  jevAnswerProbabilities: vi.fn(() => ({})),
  recordJevDecision: mockRecordJevDecision,
}));

import type { JevResult, judge as jevJudge } from '../jev/jev-client';
import { routeWithJev } from './intent-router-jev';

function result(overrides: Partial<JevResult['answers']> = {}): JevResult {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 500, output_tokens: 40 },
    answers: {
      kind: {
        type: 'choice',
        choice: 'mission_work',
        probabilities: {
          direct_answer: 0.05,
          mission_question: 0.05,
          mission_work: 0.9,
        },
        confidence: 0.9,
      },
      complexity: {
        type: 'score',
        score: 1.4,
        legend: { '0': 'trivial', '1': 'small', '2': 'medium', '3': 'large' },
        probabilities: {},
        confidence: 0.8,
      },
      risk_sensitive: { type: 'noul', noul: 0.12 },
      ambiguous: { type: 'noul', noul: 0.2 },
      skill_superpowers: { type: 'noul', noul: 0.8 },
      skill_impeccable: { type: 'noul', noul: 0.1 },
      ...overrides,
    },
  };
}

const enabled = () => true;
const hasKey = () => true;

describe('routeWithJev', () => {
  it('returns null when the surface is disabled', async () => {
    const judge = vi.fn<typeof jevJudge>();
    expect(
      await routeWithJev('crie um site', {
        judge,
        enabled: () => false,
        hasKey,
      }),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns null without a credential', async () => {
    const judge = vi.fn<typeof jevJudge>();
    expect(
      await routeWithJev('crie um site', {
        judge,
        enabled,
        hasKey: () => false,
      }),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns null when judge is unavailable', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => null);
    expect(
      await routeWithJev('crie um site', { judge, enabled, hasKey }),
    ).toBeNull();
  });

  it('mission_work maps skills with noul >= 0.6 and carries triage', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => result());
    const route = await routeWithJev('refatore o roteador de panes', {
      judge,
      enabled,
      hasKey,
    });
    expect(route?.kind).toBe('mission-work');
    if (route?.kind !== 'mission-work') throw new Error('unreachable');
    expect(route.skills).toEqual(['superpowers']);
    expect(route.triage?.source).toBe('jev');
    expect(route.triage?.complexityLevel).toBe('small');
    expect(route.triage?.complexity).toBeCloseTo(1.4);
    expect(route.triage?.riskSensitive).toBeCloseTo(0.12);
    expect(route.triage?.ambiguous).toBeCloseTo(0.2);
    // O intake roda antes do spawn do orquestrador: sem retry no timeout.
    expect(judge.mock.calls[0]![0].retryOnTimeout).toBe(false);
    expect(judge.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(6_000);
    expect(mockRecordJevDecision).toHaveBeenCalledTimes(1);
  });

  it('falls through (null) when kind confidence < 0.6', async () => {
    mockRecordJevDecision.mockClear();
    const judge = vi.fn<typeof jevJudge>(async () =>
      result({
        kind: {
          type: 'choice',
          choice: 'mission_work',
          probabilities: { mission_work: 0.5 },
          confidence: 0.5,
        },
      }),
    );
    expect(
      await routeWithJev('faz algo', { judge, enabled, hasKey }),
    ).toBeNull();
    // Deve gravar exatamente UM registro intake para baixa confiança.
    expect(mockRecordJevDecision).toHaveBeenCalledTimes(1);
    expect(mockRecordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'intake',
        decision: 'fallback:low-confidence',
      }),
    );
  });

  it('falls through (null) and records when kind type is not choice', async () => {
    mockRecordJevDecision.mockClear();
    const judge = vi.fn<typeof jevJudge>(async () =>
      result({
        kind: { type: 'noul', noul: 0.5, confidence: 0.9 } as never,
      }),
    );
    expect(
      await routeWithJev('faz algo', { judge, enabled, hasKey }),
    ).toBeNull();
    expect(mockRecordJevDecision).toHaveBeenCalledTimes(1);
    expect(mockRecordJevDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'intake',
        decision: 'fallback:bad-kind',
      }),
    );
  });

  it('direct_answer returns a direct-answer route with the question', async () => {
    const judge = vi.fn<typeof jevJudge>(async () =>
      result({
        kind: {
          type: 'choice',
          choice: 'direct_answer',
          probabilities: { direct_answer: 0.9 },
          confidence: 0.95,
        },
      }),
    );
    const route = await routeWithJev('quanto é 1+1?', {
      judge,
      enabled,
      hasKey,
    });
    expect(route).toMatchObject({ kind: 'direct-answer' });
  });

  it('mission_question returns readOnlyWorkers route', async () => {
    const judge = vi.fn<typeof jevJudge>(async () =>
      result({
        kind: {
          type: 'choice',
          choice: 'mission_question',
          probabilities: { mission_question: 0.9 },
          confidence: 0.95,
        },
      }),
    );
    const route = await routeWithJev('o que o pane X respondeu?', {
      judge,
      enabled,
      hasKey,
    });
    expect(route).toMatchObject({
      kind: 'mission-question',
      readOnlyWorkers: true,
    });
  });

  it('includes design_reference only when designReferences exist and p >= 0.6', async () => {
    const judge = vi.fn<typeof jevJudge>(async () =>
      result({
        design_reference: {
          type: 'choice',
          choice: 'linear',
          probabilities: { linear: 0.8, none: 0.2 },
          confidence: 0.9,
        },
      }),
    );
    const route = await routeWithJev('landing page estilo Linear', {
      judge,
      enabled,
      hasKey,
      designReferences: () => ['linear', 'stripe'],
    });
    expect(route?.triage?.designReference).toEqual({
      name: 'linear',
      probability: 0.8,
    });

    const judgeNone = vi.fn<typeof jevJudge>(async () =>
      result({
        design_reference: {
          type: 'choice',
          choice: 'none',
          probabilities: { linear: 0.3, none: 0.7 },
          confidence: 0.9,
        },
      }),
    );
    const noRef = await routeWithJev('landing page', {
      judge: judgeNone,
      enabled,
      hasKey,
      designReferences: () => ['linear'],
    });
    expect(noRef?.triage?.designReference).toBeUndefined();
  });

  it('does not ask design_reference without a catalog', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => result());
    await routeWithJev('landing page', {
      judge,
      enabled,
      hasKey,
      designReferences: () => [],
    });
    const questions = judge.mock.calls[0][0].questions;
    expect(questions).not.toHaveProperty('design_reference');
    expect(questions).toHaveProperty('kind');
    expect(questions).toHaveProperty('skill_typesafe_ai');
  });
});

describe('F-1164: missionId chega ao judge no intake', () => {
  it('propaga a missão conhecida do chamador', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => result());
    await routeWithJev('crie um site de portfólio com página de contato', {
      judge, enabled, hasKey, designReferences: () => [], missionId: 'm-intake',
    });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ surface: 'intake', missionId: 'm-intake' }));
  });

  it('sem missão (preparação antes de a missão existir) não inventa uma', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => result());
    await routeWithJev('crie um site de portfólio com página de contato', { judge, enabled, hasKey, designReferences: () => [] });
    expect(judge.mock.calls[0]![0].missionId).toBeUndefined();
  });
});

describe('F-1346 (parte 2): pedido longo chega ao intake com o pedido do FIM', () => {
  it('routeWithJev manda cabeça + cauda', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => null);
    const ask = 'PEDIDO DECISIVO: abra três writers, um por achado.';
    await routeWithJev(`Contexto do pedido. ${'contexto '.repeat(1_000)} ${ask}`, { judge, enabled, hasKey });
    const request = (judge.mock.calls[0]![0].state as { request: string }).request;
    expect(request).toContain('Contexto do pedido.');
    expect(request).toContain(ask);
    expect(request.length).toBeLessThan(6_100);
  });
});