import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hasJevCredential: vi.fn(() => true),
}));

vi.mock('../jev/jev-secrets', () => ({
  hasJevCredential: h.hasJevCredential,
}));

import type { JevResult } from '../jev/jev-client';
import { triageResearchHits, type ResearchHit } from './jev-research-triage';

function jevResult(answers: JevResult['answers']): JevResult {
  return {
    model: 'jev-test',
    answers,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

const HITS: ResearchHit[] = [
  { id: 'h1', title: 'Como configurar OAuth', snippet: 'passo a passo do login' },
  { id: 'h2', title: 'Receita de bolo', snippet: 'farinha e açúcar' },
];

const deps = (result: JevResult | null) => ({
  judge: vi.fn(async () => result),
  enabled: () => true,
  recordDecision: vi.fn(),
});

describe('triageResearchHits', () => {
  it('fail-open: sem resultado do Jev devolve null e o rank lexical manda', async () => {
    const d = deps(null);
    expect(await triageResearchHits('como faço login?', HITS, 's1', 'm1', d)).toBeNull();
  });

  it('menos de 2 hits não vale uma chamada Jev', async () => {
    const d = deps(jevResult({}));
    expect(
      await triageResearchHits('q', [HITS[0]!], 's1', undefined, d),
    ).toBeNull();
    expect(d.judge).not.toHaveBeenCalled();
  });

  it('aceita o best_hit com confiança ≥ 0.6 e marca answered pelo noul', async () => {
    const d = deps(
      jevResult({
        best_hit: {
          type: 'choice',
          choice: 'h1',
          confidence: 0.9,
          probabilities: { h1: 0.9, h2: 0.05, none: 0.05 },
        },
        answered: { type: 'noul', noul: 0.85 },
      }),
    );
    const out = await triageResearchHits('como faço login?', HITS, 's1', 'm1', d);
    expect(out).toMatchObject({ bestHitId: 'h1', answered: true });
    expect(d.recordDecision).toHaveBeenCalledOnce();
  });

  it('confiança baixa ou none → bestHitId null; noul incerto → precisa mais pesquisa', async () => {
    const d = deps(
      jevResult({
        best_hit: {
          type: 'choice',
          choice: 'none',
          confidence: 0.9,
          probabilities: { none: 0.9 },
        },
        answered: { type: 'noul', noul: 0.5 },
      }),
    );
    const out = await triageResearchHits('q', HITS, 's1', undefined, d);
    expect(out?.bestHitId).toBeNull();
    expect(out?.answered).toBe(false);
  });
});
