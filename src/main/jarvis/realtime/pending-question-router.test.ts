import { describe, expect, it } from 'vitest';
import {
  ANSWER_POLL_MAX_MS,
  ANSWER_POLL_MS,
  NARRATED_QUESTION_TTL_MS,
  PendingQuestionRouter,
  QUESTION_POLL_MS,
  ROUTED_ANSWER_DEDUP_MS,
  isLikelyNewQuestion,
  isStatusQuestion,
  isUiUtterance,
  looksLikePendingAnswer,
} from './pending-question-router';

describe('routing constants match the release-gate reference', () => {
  it('carries the exact timing constants', () => {
    expect(QUESTION_POLL_MS).toBe(8_000);
    expect(NARRATED_QUESTION_TTL_MS).toBe(3 * 60 * 1000);
    expect(ROUTED_ANSWER_DEDUP_MS).toBe(15_000);
    expect(ANSWER_POLL_MS).toBe(1_500);
    expect(ANSWER_POLL_MAX_MS).toBe(120_000);
  });
});

describe('utterance classification', () => {
  it('isStatusQuestion detects situação/como-tá phrasing', () => {
    expect(isStatusQuestion('qual a situação?')).toBe(true);
    expect(isStatusQuestion('como tá o build?')).toBe(true);
    expect(isStatusQuestion('o que tá acontecendo?')).toBe(true);
    expect(isStatusQuestion('sim, a opção dois')).toBe(false);
  });

  it('isUiUtterance flags navigation/list/farewell but not a plain answer', () => {
    expect(isUiUtterance('abre o workspace nexus')).toBe(true);
    expect(isUiUtterance('foca o pane do codex')).toBe(true);
    expect(isUiUtterance('quais missões existem?')).toBe(true);
    expect(isUiUtterance('tchau')).toBe(true);
    expect(isUiUtterance('a segunda opção')).toBe(false);
    expect(isUiUtterance('pode ser o Postgres')).toBe(false);
  });
});

describe('isLikelyNewQuestion', () => {
  it('flags a leading wh-question but not a declarative answer', () => {
    expect(isLikelyNewQuestion('que horas são?')).toBe(true);
    expect(isLikelyNewQuestion('qual o clima hoje?')).toBe(true);
    expect(isLikelyNewQuestion('quantos dias faltam?')).toBe(true);
    expect(isLikelyNewQuestion('cadê o café')).toBe(true);
    // Declarative short answers must NOT look like a new question.
    expect(isLikelyNewQuestion('a opção dois')).toBe(false);
    expect(isLikelyNewQuestion('pode ser o Postgres')).toBe(false);
    expect(isLikelyNewQuestion('sim')).toBe(false);
  });
});

describe('looksLikePendingAnswer', () => {
  it('treats short utterances as plausible answers', () => {
    expect(looksLikePendingAnswer('sim', 'Qual banco?')).toBe(true);
    expect(looksLikePendingAnswer('a opção 2', 'Qual banco?')).toBe(true);
  });

  it('rejects a short but fresh wh-question (bounds the ≤80-char blanket)', () => {
    // "que horas são?" is short + non-UI, but it is a NEW query, not an answer.
    expect(looksLikePendingAnswer('que horas são?', 'Qual banco: Postgres ou SQLite?')).toBe(false);
  });

  it('a long utterance must reference an option/number or share a word', () => {
    const question = 'Qual banco de dados devo usar para a persistência dos usuários?';
    const related =
      'usa o banco Postgres porque a persistência precisa de transações fortes e consistência';
    const unrelated =
      'pesquisa os preços das GPUs mais recentes no mercado e monta uma tabela comparativa detalhada';
    expect(looksLikePendingAnswer(related, question)).toBe(true);
    expect(looksLikePendingAnswer(unrelated, question)).toBe(false);
  });

  it('an "opção/número" reference always counts even when long', () => {
    const long = `escolhe a opção ${'x'.repeat(90)}`;
    expect(looksLikePendingAnswer(long, 'Qual?')).toBe(true);
  });
});

describe('PendingQuestionRouter.decide', () => {
  function router(now = { t: 1_000 }) {
    return {
      r: new PendingQuestionRouter({ now: () => now.t }),
      clock: now,
    };
  }

  it('routes a plausible answer to the pane with a pending question', () => {
    const { r } = router();
    r.noteNarratedQuestion('pane-1', 'Qual banco: Postgres ou SQLite?');
    expect(r.decide('Postgres')).toEqual({ route: true, paneId: 'pane-1', text: 'Postgres' });
  });

  it('does not route when there is no pending question', () => {
    const { r } = router();
    expect(r.decide('Postgres')).toMatchObject({ route: false, reason: 'no-pending-question' });
  });

  it('does not route a UI command', () => {
    const { r } = router();
    r.noteNarratedQuestion('pane-1', 'Qual banco?');
    expect(r.decide('abre o grid')).toMatchObject({ route: false, reason: 'ui-utterance' });
  });

  it('does not route an unrelated long imperative', () => {
    const { r } = router();
    r.noteNarratedQuestion('pane-1', 'Qual banco de dados?');
    const decision = r.decide(
      'pesquisa os preços das placas de vídeo e monta uma planilha comparativa bem completa',
    );
    expect(decision).toMatchObject({ route: false, reason: 'not-an-answer' });
  });

  it('does not route a short fresh wh-question while a handoff blocks', () => {
    const { r } = router();
    r.noteNarratedQuestion('pane-1', 'Qual banco: Postgres ou SQLite?');
    expect(r.decide('que horas são?')).toMatchObject({ route: false, reason: 'not-an-answer' });
  });

  it('clears and skips a stale narrated question past the TTL', () => {
    const { r, clock } = router();
    r.noteNarratedQuestion('pane-1', 'Qual banco?');
    clock.t += NARRATED_QUESTION_TTL_MS + 1;
    expect(r.decide('Postgres')).toMatchObject({ route: false, reason: 'question-stale' });
    // question was cleared
    expect(r.questionFor('pane-1')).toBeNull();
  });

  it('prefers the focused pane when several have pending questions', () => {
    const { r } = router();
    r.noteNarratedQuestion('pane-1', 'Q1?');
    r.noteNarratedQuestion('pane-2', 'Q2?');
    expect(r.pendingQuestionPaneId('pane-1')).toBe('pane-1');
    // no focus → most recent
    expect(r.pendingQuestionPaneId()).toBe('pane-2');
  });
});

describe('PendingQuestionRouter.wasAnswerJustRouted (dedup)', () => {
  function router(now = { t: 1_000 }) {
    return { r: new PendingQuestionRouter({ now: () => now.t }), clock: now };
  }

  it('matches the exact same routed utterance within the window', () => {
    const { r } = router();
    r.markRouted('pane-1', 'Postgres');
    expect(r.wasAnswerJustRouted('Postgres', 'pane-1')).toBe(true);
    expect(r.wasAnswerJustRouted('postgres', 'pane-1')).toBe(true);
  });

  it('expires after ROUTED_ANSWER_DEDUP_MS', () => {
    const { r, clock } = router();
    r.markRouted('pane-1', 'Postgres');
    clock.t += ROUTED_ANSWER_DEDUP_MS + 1;
    expect(r.wasAnswerJustRouted('Postgres', 'pane-1')).toBe(false);
  });

  it('does not match a different pane', () => {
    const { r } = router();
    r.markRouted('pane-1', 'Postgres');
    expect(r.wasAnswerJustRouted('Postgres', 'pane-2')).toBe(false);
  });

  it('short answers require exact equality (no substring engulf)', () => {
    const { r } = router();
    r.markRouted('pane-1', 'sim');
    // "sim, e também roda os testes" contains "sim" but is not the routed answer
    expect(r.wasAnswerJustRouted('sim e também roda os testes', 'pane-1')).toBe(false);
    expect(r.wasAnswerJustRouted('sim', 'pane-1')).toBe(true);
  });

  it('long fragments (>=15 chars) match at a word boundary', () => {
    const { r } = router();
    r.markRouted('pane-1', 'usa o banco postgres');
    expect(r.wasAnswerJustRouted('acho que usa o banco postgres mesmo', 'pane-1')).toBe(true);
  });
});
