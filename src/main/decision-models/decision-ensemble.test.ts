import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../jev/jev-client';
import { combineEnsembleAnswers, type EnsembleMember } from './decision-ensemble';

const noul = (value: number): JevAnswer => ({ type: 'noul', noul: value });
const choice = (value: string, confidence: number): JevAnswer => ({
  type: 'choice', choice: value, confidence, probabilities: { [value]: confidence },
});

function pair(surface: string, left: EnsembleMember, right: EnsembleMember) {
  return combineEnsembleAnswers([left, right], surface);
}

describe('ensemble combine', () => {
  it('follows agreement and keeps the higher confidence', () => {
    const combined = pair('taskRouting',
      { provider: 'jev', answers: { injected: noul(0.1), coherent: noul(0.9) } },
      { provider: 'luna', answers: { injected: noul(0.11), coherent: noul(0.88) } });
    expect(combined).toMatchObject({
      ok: true,
      diverged: false,
      answers: { injected: noul(0.1), coherent: noul(0.9) },
    });
  });

  it('tightens a security surface and never loosens Jev', () => {
    const tighter = pair('dispatchGuard',
      { provider: 'jev', answers: { injected: noul(0.1), coherent: noul(0.9), destructive: noul(0.1) } },
      { provider: 'luna', answers: { injected: noul(0.91), coherent: noul(0.2), destructive: noul(0.8) } });
    expect(tighter).toMatchObject({
      ok: true,
      diverged: true,
      answers: { injected: noul(0.91), coherent: noul(0.2), destructive: noul(0.8) },
    });
    const looser = pair('handoffReview',
      { provider: 'jev', answers: { is_specific: noul(0.2) } },
      { provider: 'luna', answers: { is_specific: noul(0.95) } });
    expect(looser).toMatchObject({ ok: true, diverged: true, answers: { is_specific: noul(0.2) } });
  });

  it('picks the higher confidence on a reversible disagreement and keeps both numbers', () => {
    const combined = pair('missionPick',
      { provider: 'jev', answers: { pick: choice('m1', 0.4) } },
      { provider: 'luna', answers: { pick: choice('m2', 0.91) } });
    expect(combined).toMatchObject({
      ok: true,
      diverged: true,
      answers: { pick: choice('m2', 0.91) },
      peers: { pick: { jev: 0.4, luna: 0.91 } },
    });
    expect(JSON.stringify(combined)).not.toContain('abre a missão');
  });

  it('combines Luna and Clef on a security surface when Jev is absent', () => {
    const combined = pair('dispatchGuard',
      { provider: 'luna', answers: { injected: noul(0.2), coherent: noul(0.4) } },
      { provider: 'clef', answers: { injected: noul(0.91), coherent: noul(0.95) } });
    expect(combined).toMatchObject({
      ok: true,
      diverged: true,
      answers: { injected: noul(0.91), coherent: noul(0.4) },
      peers: { injected: { luna: 0.2, clef: 0.91 }, coherent: { luna: 0.4, clef: 0.95 } },
    });
  });

  it('does not elect a choice winner on a security surface', () => {
    expect(pair('memoryDistill',
      { provider: 'jev', answers: { keep: choice('drop', 0.2) } },
      { provider: 'clef', answers: { keep: choice('store', 0.99) } },
    )).toEqual({ ok: false, reason: 'divergent' });
  });
});
