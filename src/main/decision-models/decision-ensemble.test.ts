import { describe, expect, it, vi } from 'vitest';
import type { DecisionProvider } from '../../shared/decision-models';
import type { JevAnswer } from '../jev/jev-client';
import { combineEnsembleAnswers, type EnsembleMember } from './decision-ensemble';

// The real handoff policy imports Jev's credential/autopilot boundary (Electron).
vi.mock('../jev/jev-secrets', () => ({ hasJevCredential: () => true }));
vi.mock('../jev/jev-autopilot', () => ({
  isJevAutopilotEnabled: () => true, isJevSurfaceEnabled: () => true,
}));
import { handoffBounceSignals } from '../orch/jev-handoff-review';

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

  it.each<{ providers: DecisionProvider[]; changedBy: DecisionProvider }>([
    { providers: ['jev', 'luna'], changedBy: 'jev' },
    { providers: ['jev', 'luna'], changedBy: 'luna' },
    { providers: ['jev', 'clef'], changedBy: 'jev' },
    { providers: ['jev', 'clef'], changedBy: 'clef' },
    { providers: ['luna', 'clef'], changedBy: 'luna' },
    { providers: ['luna', 'clef'], changedBy: 'clef' },
    { providers: ['jev', 'luna', 'clef'], changedBy: 'jev' },
    { providers: ['jev', 'luna', 'clef'], changedBy: 'luna' },
    { providers: ['jev', 'luna', 'clef'], changedBy: 'clef' },
  ])('keeps code verification and changed-file bounces for $providers when $changedBy sees edits', ({ providers, changedBy }) => {
    const facts = { declaredFiles: [], hasObservedCommit: false, evidenceIdsCount: 0 };
    const codeAnswers = {
      changed_code: noul(0.9), has_verification: noul(0.1),
      is_specific: noul(0.9), names_changes: noul(0.1),
    };
    const expectedBounces = [
      'sem evidência de verificação: cole a saída de testes/typecheck/build ou a referência do commit',
      'não lista arquivos/componentes alterados: informe filesModified',
    ];
    expect(handoffBounceSignals(codeAnswers, facts)).toEqual(expectedBounces);
    const combined = combineEnsembleAnswers(providers.map(provider => ({
      provider,
      answers: { ...codeAnswers, changed_code: noul(provider === changedBy ? 0.9 : 0.1) },
    })), 'handoffReview');
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    expect(handoffBounceSignals(combined.answers, facts)).toEqual(expectedBounces);
    expect(combined.answers.changed_code).toEqual(noul(0.9));
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
