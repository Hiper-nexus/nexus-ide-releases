import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  handoffReviewFeedback,
  JEV_REVIEW_TIMEOUT_MS,
  jevReviewReceipt,
  mechanicalHandoffReviewOutcome,
  recordHandoffAckFeedback,
  resetJevReviewBudgetsForTesting,
  reviewMissionHandoff,
  type HandoffReviewInput,
  type JevReviewArtifact,
} from './jev-handoff-review';
import type { JevQuestion } from '../jev/jev-client';
import {
  configureJevDecisionLog,
  listJevDecisions,
  recordJevDecision,
} from '../jev/jev-decision-log';

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
    const judge = vi.fn(async () => allPass());
    const verdict = await reviewMissionHandoff(
      { sessionId: 's1', ...baseInput },
      deps(judge),
    );
    expect(verdict.kind).toBe('ok');
    if (verdict.kind === 'ok') {
      expect(verdict.artifact.kind).toBe('nexus.jevReview');
      expect(verdict.artifact.payload.outcome).toBe('ok');
      expect(verdict.artifact.payload.probabilities.is_specific).toBe(0.9);
    }
    // O review segura a escrita durável do handoff: prazo limitado e sem
    // retry de transporte (o default do client dobraria a espera).
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: JEV_REVIEW_TIMEOUT_MS,
      retryOnTimeout: false,
    }));
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

  it('F-823: o weak diz quais sinais o MCP devolveria (vazio para achado de revisão)', async () => {
    const reviewerFindings = await reviewMissionHandoff(
      {
        sessionId: 's-revisor',
        ...baseInput,
        summary: 'Revisão somente leitura: 1 MEDIUM, 2 LOW. Nenhum arquivo alterado.',
        declaredFiles: [],
        maxBounces: 0,
      },
      deps(vi.fn(async () =>
        result({ is_specific: 0.9, has_verification: 0.2, admits_incomplete: 0.9, changed_code: 0.05, names_changes: 0.9 }),
      )),
    );
    expect(reviewerFindings.kind).toBe('weak');
    if (reviewerFindings.kind === 'weak') expect(reviewerFindings.bounceSignals).toEqual([]);

    const codeWithoutProof = await reviewMissionHandoff(
      { sessionId: 's-codigo', ...baseInput, maxBounces: 0 },
      deps(vi.fn(async () => result({ is_specific: 0.9, has_verification: 0.1, admits_incomplete: 0.1 }))),
    );
    expect(codeWithoutProof.kind).toBe('weak');
    if (codeWithoutProof.kind === 'weak') {
      expect(codeWithoutProof.bounceSignals?.join(' ')).toContain('sem evidência de verificação');
    }
  });

  it('F-786: sem canal de retry (maxBounces 0) o primeiro fraco já é weak, nunca retry', async () => {
    // O fechamento mecânico PTY não pode devolver a entrega ao worker (ele já
    // encerrou): orçamento zero de devoluções — nasce weak de cara.
    const weak = result({ is_specific: 0.1, has_verification: 0.1, admits_incomplete: 0.1 });
    const verdict = await reviewMissionHandoff(
      { sessionId: 's-pty', ...baseInput, maxBounces: 0 },
      deps(vi.fn(async () => weak)),
    );
    expect(verdict.kind).toBe('weak');
    if (verdict.kind === 'weak') {
      expect(verdict.signals.length).toBeGreaterThan(0);
      expect(verdict.artifact.payload.outcome).toBe('weak');
    }
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

  describe('F-707: só devolve o que o worker conserta anexando', () => {
    const readOnlyReview: HandoffReviewInput = {
      ...baseInput,
      summary:
        'Revisão somente leitura concluída: 1 MEDIUM (corrida retorna 404 em vez de 409), 2 LOW. ' +
        'Nenhum arquivo foi alterado.',
      declaredFiles: [],
    };

    it('revisor com achados (NÃO PASS) entra marcado, sem devolução', async () => {
      const verdict = await reviewMissionHandoff(
        { sessionId: 'r1', ...readOnlyReview },
        deps(vi.fn(async () =>
          result({ is_specific: 0.9, has_verification: 0.2, admits_incomplete: 0.9, changed_code: 0.05, names_changes: 0.9 }),
        )),
      );
      expect(verdict.kind).toBe('weak');
      if (verdict.kind === 'weak') expect(verdict.signals.length).toBe(2);
    });

    it('plano ou análise sem teste não é devolvido', async () => {
      const verdict = await reviewMissionHandoff(
        { sessionId: 'p1', ...readOnlyReview },
        deps(vi.fn(async () =>
          result({ is_specific: 0.9, has_verification: 0.1, admits_incomplete: 0.1, changed_code: 0.1, names_changes: 0.2 }),
        )),
      );
      expect(verdict.kind).toBe('weak');
    });

    it('mudança de código sem verificação é devolvida, mesmo sem o Jev ver código', async () => {
      const noVerification = result({ is_specific: 0.9, has_verification: 0.1, admits_incomplete: 0.1, changed_code: 0.1 });
      const byFiles = await reviewMissionHandoff({ sessionId: 'w1', ...baseInput }, deps(vi.fn(async () => noVerification)));
      expect(byFiles.kind).toBe('retry');
      const byJev = await reviewMissionHandoff(
        { sessionId: 'w2', ...readOnlyReview },
        deps(vi.fn(async () =>
          result({ is_specific: 0.9, has_verification: 0.1, admits_incomplete: 0.1, changed_code: 0.9, names_changes: 0.9 }),
        )),
      );
      expect(byJev.kind).toBe('retry');
      if (byJev.kind === 'retry') expect(byJev.message).toContain('sem evidência de verificação');
    });

    it('pergunta changed_code em toda revisão', async () => {
      const asked: Record<string, JevQuestion>[] = [];
      const j = vi.fn(async (input: { questions: Record<string, JevQuestion> }) => {
        asked.push(input.questions);
        return allPass();
      });
      await reviewMissionHandoff({ sessionId: 's1', ...baseInput }, deps(j));
      expect(asked[0].changed_code).toBeDefined();
      expect(asked[0].admits_incomplete.instructions).toContain('ITS OWN');
    });
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

describe('mechanicalHandoffReviewOutcome (F-786 — caminho sem canal de devolução)', () => {
  const artifact: JevReviewArtifact = {
    kind: 'nexus.jevReview',
    payload: { outcome: 'weak', model: 'jev-test', probabilities: {}, signals: ['s'] },
  };

  it('ok → success, sem marca, com artifact da revisão', () => {
    const outcome = mechanicalHandoffReviewOutcome({
      kind: 'ok',
      artifact: { ...artifact, payload: { ...artifact.payload, outcome: 'ok' as const } },
    });
    expect(outcome.status).toBe('success');
    expect(outcome.mark).toBe(false);
    expect(outcome.artifacts).toHaveLength(1);
  });

  it('weak com sinal que o MCP devolveria → partial com marca (aqui não há devolução)', () => {
    const outcome = mechanicalHandoffReviewOutcome({
      kind: 'weak',
      signals: ['sem evidência'],
      bounceSignals: ['sem evidência'],
      artifact,
    });
    expect(outcome.status).toBe('partial');
    expect(outcome.mark).toBe(true);
    expect(outcome.artifacts).toHaveLength(1);
  });

  it('F-823: weak só por sinal que nem o MCP devolve → success marcado, como no MCP', () => {
    // Rebaixar a partial tirava a entrega do portão de regressão e do done
    // (só success conta) e fazia CLI sem MCP entrar em loop de redespacho.
    const outcome = mechanicalHandoffReviewOutcome({
      kind: 'weak',
      signals: ['o texto admite pendências, mas o status é success'],
      bounceSignals: [],
      artifact,
    });
    expect(outcome.status).toBe('success');
    expect(outcome.mark).toBe(true);
    expect(outcome.artifacts).toHaveLength(1);
  });

  it('weak sem a informação de devolução → destino conservador (partial)', () => {
    const outcome = mechanicalHandoffReviewOutcome({ kind: 'weak', signals: ['s'], artifact });
    expect(outcome.status).toBe('partial');
  });

  it('retry → partial (defesa: com maxBounces 0 não deve ocorrer)', () => {
    const outcome = mechanicalHandoffReviewOutcome({
      kind: 'retry',
      signals: ['sem evidência'],
      attempt: 1,
      retries: 1,
      message: 'm',
    });
    expect(outcome.status).toBe('partial');
    expect(outcome.mark).toBe(true);
  });

  it('skipped → success sem marca (fail-open, como no MCP)', () => {
    const outcome = mechanicalHandoffReviewOutcome({ kind: 'skipped', reason: 'no-credential' });
    expect(outcome.status).toBe('success');
    expect(outcome.mark).toBe(false);
    expect(outcome.artifacts).toHaveLength(0);
  });
});

// F-782: 0 rótulos Certo/Errado em 760 decisões — o ACK do Maestro passa a
// rotular a revisão que levou àquele handoff.
describe('F-782: o ACK do Maestro rotula a revisão do Jev', () => {
  let logDir = '';

  beforeEach(() => {
    resetJevReviewBudgetsForTesting();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-jev-ack-feedback-'));
    configureJevDecisionLog(logDir);
  });

  afterEach(() => {
    configureJevDecisionLog(undefined);
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  const weakResult = () =>
    result({ is_specific: 0.9, has_verification: 0.2, admits_incomplete: 0.9, changed_code: 0.05, names_changes: 0.9 });
  const readOnlyReport: HandoffReviewInput = {
    ...baseInput,
    summary: 'Revisão somente leitura: 1 MEDIUM, 2 LOW. Nenhum arquivo alterado.',
    declaredFiles: [],
  };

  async function reviewed(kind: 'ok' | 'weak', sessionId: string) {
    const verdict = await reviewMissionHandoff(
      { sessionId, missionId: 'mission-f782', ...(kind === 'ok' ? baseInput : readOnlyReport) },
      deps(vi.fn(async () => (kind === 'ok' ? allPass() : weakResult()))),
    );
    if (verdict.kind !== kind) throw new Error(`esperava ${kind}, veio ${verdict.kind}`);
    return verdict.artifact;
  }

  const feedbackOf = (decisionId: string | undefined) =>
    listJevDecisions({ surface: 'handoffReview', dir: logDir }).find((e) => e.id === decisionId)?.feedback;

  it('o recibo da revisão carrega o id da linha do diário, com sessão e missão', async () => {
    const artifact = await reviewed('ok', 's-recibo');
    const [entry] = listJevDecisions({ surface: 'handoffReview', dir: logDir });
    expect(artifact.payload.decisionId).toBe(entry?.id);
    expect(entry).toMatchObject({ sessionId: 's-recibo', missionId: 'mission-f782', decision: 'ok' });
    expect(jevReviewReceipt([artifact])).toEqual({ decisionId: entry?.id, outcome: 'ok' });
  });

  it('concordar com o Maestro é certo; discordar é errado (as 4 combinações)', () => {
    expect(handoffReviewFeedback('ok', 'accepted')).toBe('right');
    expect(handoffReviewFeedback('ok', 'rework')).toBe('wrong');
    expect(handoffReviewFeedback('weak', 'rework')).toBe('right');
    // Limiar rígido: o Jev marcou fraca e o Maestro aceitou como veio.
    expect(handoffReviewFeedback('weak', 'accepted')).toBe('wrong');
  });

  it('revisar ok e aceitar grava certo; revisar ok e devolver grava errado', async () => {
    const accepted = await reviewed('ok', 's-ok-aceito');
    expect(recordHandoffAckFeedback({ artifacts: [accepted], sessionId: 's-ok-aceito' }, 'accepted')).toBe('right');
    expect(feedbackOf(accepted.payload.decisionId)).toBe('right');

    const reworked = await reviewed('ok', 's-ok-devolvido');
    expect(recordHandoffAckFeedback({ artifacts: [reworked], sessionId: 's-ok-devolvido' }, 'rework')).toBe('wrong');
    expect(feedbackOf(reworked.payload.decisionId)).toBe('wrong');
  });

  it('revisão fraca devolvida grava certo; fraca aceita grava errado', async () => {
    const reworked = await reviewed('weak', 's-fraca-devolvida');
    recordHandoffAckFeedback({ artifacts: [reworked], sessionId: 's-fraca-devolvida' }, 'rework');
    expect(feedbackOf(reworked.payload.decisionId)).toBe('right');

    const accepted = await reviewed('weak', 's-fraca-aceita');
    recordHandoffAckFeedback({ artifacts: [accepted], sessionId: 's-fraca-aceita' }, 'accepted');
    expect(feedbackOf(accepted.payload.decisionId)).toBe('wrong');
  });

  it('id copiado de outra sessão não rotula nada', async () => {
    const other = await reviewed('ok', 's-vitima');
    const forged = { kind: 'nexus.jevReview', payload: { ...other.payload } };
    expect(recordHandoffAckFeedback({ artifacts: [forged], sessionId: 's-atacante' }, 'rework')).toBeNull();
    expect(feedbackOf(other.payload.decisionId)).toBeUndefined();
  });

  it('desfecho trocado no artifact (weak→ok) não rotula a linha', async () => {
    const weak = await reviewed('weak', 's-troca');
    const flipped = { kind: 'nexus.jevReview', payload: { ...weak.payload, outcome: 'ok' } };
    expect(recordHandoffAckFeedback({ artifacts: [flipped], sessionId: 's-troca' }, 'accepted')).toBeNull();
    expect(feedbackOf(weak.payload.decisionId)).toBeUndefined();
  });

  it('o recibo do Main (último) vence um recibo do worker anexado antes', async () => {
    const real = await reviewed('ok', 's-ordem');
    const decoyId = recordJevDecision(
      {
        surface: 'handoffReview', sessionId: 's-ordem', model: 'jev-test', questions: [],
        probabilities: {}, decision: 'weak', inputTokens: 0, usd: 0,
      },
      { dir: logDir },
    );
    const decoy = { kind: 'nexus.jevReview', payload: { outcome: 'weak', decisionId: decoyId } };
    recordHandoffAckFeedback({ artifacts: [decoy, real], sessionId: 's-ordem' }, 'accepted');
    expect(feedbackOf(real.payload.decisionId)).toBe('right');
    expect(feedbackOf(decoyId)).toBeUndefined();
  });

  it('sem recibo (revisão pulada) não há o que rotular', () => {
    expect(recordHandoffAckFeedback({ artifacts: [], sessionId: 's1' }, 'accepted')).toBeNull();
    expect(recordHandoffAckFeedback({ artifacts: [{ kind: 'overclock.fullText', payload: 'x' }], sessionId: 's1' }, 'rework')).toBeNull();
    expect(listJevDecisions({ dir: logDir })).toEqual([]);
  });
});
