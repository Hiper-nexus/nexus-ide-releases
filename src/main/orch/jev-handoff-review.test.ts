import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevResult } from '../jev/jev-client';

// O módulo importa jev-client/jev-secrets (cadeia electron); os deps injetados
// são o caminho real de produção — aqui mockamos o import para isolar.
vi.mock('../jev/jev-secrets', () => ({
  hasJevCredential: vi.fn(() => true),
}));
vi.mock('../jev/jev-autopilot', () => ({
  isJevAutopilotEnabled: vi.fn(() => true),
  isJevSurfaceEnabled: vi.fn(() => true),
}));

import {
  ADMITS_INCOMPLETE_MAX,
  buildHandoffReviewState,
  evaluateHandoffEvidence,
  resetJevReviewBudgetsForTesting,
  reviewMissionHandoff,
  type HandoffReviewInput,
} from './jev-handoff-review';
import type { JevQuestion } from '../jev/jev-client';

const baseInput: HandoffReviewInput = {
  summary: 'Implemented the login form. Ran npm test (42 passing). Commit a1b2c3d.',
  declaredFiles: ['src/login.ts'],
  artifactKinds: [],
  evidenceIdsCount: 0,
  hasObservedCommit: false,
  declaredStatus: 'success',
};

function result(nouls: Record<string, number>): JevResult {
  const answers: JevResult['answers'] = {};
  for (const [id, noul] of Object.entries(nouls)) {
    answers[id] = { type: 'noul', noul };
  }
  return { model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 1 } };
}

const allPass = () =>
  result({ is_specific: 0.9, has_verification: 0.9, admits_incomplete: 0.1 });

const deps = (j: ReturnType<typeof vi.fn>) => ({
  judge: j as never,
  enabled: () => true,
  hasKey: () => true,
});

describe('evaluateHandoffEvidence', () => {
  const facts = { declaredFiles: [], evidenceIdsCount: 0, hasObservedCommit: false };

  it('is_specific baixo → sinal de resumo genérico', () => {
    const signals = evaluateHandoffEvidence(
      result({ is_specific: 0.2 }).answers,
      facts,
    );
    expect(signals.some((s) => s.includes('resumo genérico'))).toBe(true);
  });

  it('has_verification baixo sem evidenceIds → sinal de verificação', () => {
    const signals = evaluateHandoffEvidence(
      result({ has_verification: 0.1 }).answers,
      facts,
    );
    expect(signals.some((s) => s.includes('sem evidência de verificação'))).toBe(true);
  });

  it('has_verification baixo COM evidenceIds → sem sinal', () => {
    const signals = evaluateHandoffEvidence(
      result({ has_verification: 0.1 }).answers,
      { ...facts, evidenceIdsCount: 2 },
    );
    expect(signals.some((s) => s.includes('verificação'))).toBe(false);
  });

  it('admits_incomplete alto → sinal de pendência', () => {
    const signals = evaluateHandoffEvidence(
      result({ admits_incomplete: ADMITS_INCOMPLETE_MAX + 0.1 }).answers,
      facts,
    );
    expect(signals.some((s) => s.includes('admite pendências'))).toBe(true);
  });

  it('names_changes baixo sem arquivos nem commit → sinal de filesModified', () => {
    const signals = evaluateHandoffEvidence(
      result({ names_changes: 0.1 }).answers,
      facts,
    );
    expect(signals.some((s) => s.includes('filesModified'))).toBe(true);
  });

  it('names_changes baixo mas commit observado → sem sinal', () => {
    const signals = evaluateHandoffEvidence(
      result({ names_changes: 0.1 }).answers,
      { ...facts, hasObservedCommit: true },
    );
    expect(signals.some((s) => s.includes('filesModified'))).toBe(false);
  });

  it('tudo forte → zero sinais', () => {
    expect(evaluateHandoffEvidence(allPass().answers, facts)).toEqual([]);
  });
});

describe('buildHandoffReviewState', () => {
  it('aplica caps e nunca inclui payloads de artifact', () => {
    const state = buildHandoffReviewState({
      ...baseInput,
      summary: 'x'.repeat(5_000),
      fullText: 'y'.repeat(9_000),
      accomplished: ['a', 'b'],
      declaredFiles: Array.from({ length: 60 }, (_, i) => `f${i}.ts`),
      artifactKinds: ['k1', 'k2'],
    }) as { report: { summary: string; fullText: string; accomplished: string }; delivery: { declaredFiles: string[]; artifactKinds: string[] } };
    expect(state.report.summary).toContain('chars omitted');
    expect(state.report.summary.length).toBeLessThan(4_100);
    expect(state.report.fullText.length).toBeLessThan(8_100);
    expect(state.report.accomplished).toBe('["a","b"]');
    expect(state.delivery.declaredFiles.length).toBe(50);
    expect(state.delivery.artifactKinds).toEqual(['k1', 'k2']);
  });
});

describe('reviewMissionHandoff', () => {
  beforeEach(() => {
    resetJevReviewBudgetsForTesting();
    vi.clearAllMocks();
  });

  it('relatório forte → ok + artifact com probabilidades', async () => {
    const verdict = await reviewMissionHandoff(
      { sessionId: 's1', ...baseInput },
      deps(vi.fn(async () => allPass())),
    );
    expect(verdict.kind).toBe('ok');
    if (verdict.kind === 'ok') {
      expect(verdict.artifact.kind).toBe('nexus.jevReview');
      expect(verdict.artifact.payload.outcome).toBe('ok');
      expect(verdict.artifact.payload.probabilities.is_specific).toBe(0.9);
    }
  });

  it('primeiro fraco → retry com mensagem e tentativa 1/1', async () => {
    const weak = result({ is_specific: 0.1, has_verification: 0.1, admits_incomplete: 0.1 });
    const verdict = await reviewMissionHandoff(
      { sessionId: 's1', ...baseInput },
      deps(vi.fn(async () => weak)),
    );
    expect(verdict.kind).toBe('retry');
    if (verdict.kind === 'retry') {
      expect(verdict.attempt).toBe(1);
      expect(verdict.retries).toBe(1);
      expect(verdict.message).toContain('devolução 1/1');
      expect(verdict.message).toContain('nexus_handoff_submit');
    }
  });

  it('segundo fraco na mesma sessão → weak + artifact; orçamento limpo', async () => {
    const weak = result({ is_specific: 0.1, has_verification: 0.1, admits_incomplete: 0.1 });
    const d = deps(vi.fn(async () => weak));
    const first = await reviewMissionHandoff({ sessionId: 's1', ...baseInput }, d);
    expect(first.kind).toBe('retry');
    const second = await reviewMissionHandoff({ sessionId: 's1', ...baseInput }, d);
    expect(second.kind).toBe('weak');
    if (second.kind === 'weak') {
      expect(second.artifact.payload.outcome).toBe('weak');
      expect(second.signals.length).toBeGreaterThan(0);
    }
    // orçamento limpo: terceiro fraco volta a ser retry 1/1
    const third = await reviewMissionHandoff({ sessionId: 's1', ...baseInput }, d);
    expect(third.kind).toBe('retry');
  });

  it('judge null → skipped', async () => {
    const verdict = await reviewMissionHandoff(
      { sessionId: 's1', ...baseInput },
      deps(vi.fn(async () => null)),
    );
    expect(verdict).toEqual({ kind: 'skipped', reason: 'judge-unavailable' });
  });

  it('status partial → skipped sem chamar o judge', async () => {
    const j = vi.fn(async () => allPass());
    const verdict = await reviewMissionHandoff(
      { sessionId: 's1', ...baseInput, declaredStatus: 'partial' },
      deps(j),
    );
    expect(verdict.kind).toBe('skipped');
    expect(j).not.toHaveBeenCalled();
  });

  it('sem sessionId → skipped', async () => {
    const verdict = await reviewMissionHandoff(
      { sessionId: undefined, ...baseInput },
      deps(vi.fn(async () => allPass())),
    );
    expect(verdict).toEqual({ kind: 'skipped', reason: 'no-session' });
  });

  it('names_changes só é perguntado quando declaredFiles está vazio', async () => {
    const asked: Record<string, JevQuestion>[] = [];
    const j = vi.fn(async (input: { questions: Record<string, JevQuestion> }) => {
      asked.push(input.questions);
      return allPass();
    });
    await reviewMissionHandoff({ sessionId: 's1', ...baseInput }, deps(j));
    await reviewMissionHandoff(
      { sessionId: 's1', ...baseInput, declaredFiles: [] },
      deps(j),
    );
    expect(asked[0].names_changes).toBeUndefined();
    expect(asked[1].names_changes).toBeDefined();
  });
});
