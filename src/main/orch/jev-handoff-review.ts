/**
 * Revisão de evidência do handoff de missão via TypeSafe Jev (piloto
 * automático). No `nexus_handoff_submit` declarado `success`, o Jev julga o
 * relatório do worker; relatório fraco volta UMA vez ao worker dizendo o que
 * falta (mesma UX do contrato determinístico de delivery-contract.ts); um
 * segundo envio fraco é aceito mas marcado `[evidência fraca]` + artifact
 * `nexus.jevReview` para o Maestro decidir com evidência.
 *
 * FAIL-OPEN em tudo: sem chave, autopilot desligado, timeout ou `judge()`
 * null → `skipped` e o fluxo segue exatamente como hoje.
 */
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
  type JevAnswer,
  type JevQuestion,
  type JevResult,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasJevCredential } from '../jev/jev-secrets';
import {
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';

export interface HandoffReviewInput {
  summary: string;
  fullText?: string;
  accomplished?: unknown;
  blockers?: unknown;
  nextSteps?: unknown;
  declaredFiles: string[];
  artifactKinds: string[];
  evidenceIdsCount: number;
  hasObservedCommit: boolean;
  declaredStatus: string;
}

export const IS_SPECIFIC_MIN = 0.5;
export const HAS_VERIFICATION_MIN = 0.5;
export const ADMITS_INCOMPLETE_MAX = 0.7;
export const NAMES_CHANGES_MIN = 0.5;

/** Quantas devoluções o worker recebe antes de o handoff entrar como fraco. */
export const JEV_REVIEW_MAX_BOUNCES = 1;

export const HANDOFF_REVIEW_QUESTIONS: Record<string, JevQuestion> = {
  is_specific: {
    type: 'noul',
    instructions:
      'Does `report.summary` (and `report.fullText` when present) describe ' +
      'concrete work actually done on this task — specific changes, files, ' +
      'behaviors — rather than generic, placeholder or boilerplate text?',
    criteria: {
      true: 'concrete, specific description of work done',
      false: 'generic, placeholder or boilerplate text',
    },
  },
  has_verification: {
    type: 'noul',
    instructions:
      'Does the report show that verification actually ran — test results, ' +
      'typecheck/build output, command output or a commit reference — as ' +
      'opposed to merely claiming the work is done or promising to test later?',
    criteria: {
      true: 'verification output or commit reference present',
      false: 'no verification evidence',
    },
  },
  admits_incomplete: {
    type: 'noul',
    instructions:
      'Does the report itself admit unfinished, pending, skipped, failing or ' +
      'uncertain parts of the requested work?',
    criteria: {
      true: 'the report admits unfinished or failing parts',
      false: 'the report does not admit any incomplete part',
    },
  },
  // Só entra no judge quando declaredFiles está vazio (ver reviewMissionHandoff).
  names_changes: {
    type: 'noul',
    instructions:
      'Does the report name the specific files, modules or components that ' +
      'were changed?',
    criteria: {
      true: 'specific files or components named',
      false: 'no changed file or component named',
    },
  },
};

function cappedJson(value: unknown, max: number): string {
  return capText(JSON.stringify(value), max);
}

/**
 * State julgado pelo Jev: o relatório declarado + fatos verificáveis do
 * registro. NUNCA inclui payload de artifacts nem telemetria.
 */
export function buildHandoffReviewState(input: HandoffReviewInput): unknown {
  const report: Record<string, unknown> = {
    summary: capText(input.summary, 4_000),
  };
  if (input.fullText !== undefined) {
    report.fullText = capText(input.fullText, 8_000);
  }
  if (input.accomplished !== undefined) {
    report.accomplished = cappedJson(input.accomplished, 2_000);
  }
  if (input.blockers !== undefined) {
    report.blockers = cappedJson(input.blockers, 2_000);
  }
  if (input.nextSteps !== undefined) {
    report.nextSteps = cappedJson(input.nextSteps, 2_000);
  }
  return {
    report,
    delivery: {
      declaredFiles: input.declaredFiles.slice(0, 50),
      artifactKinds: input.artifactKinds
        .filter((k) => typeof k === 'string')
        .slice(0, 30),
      evidenceIdsCount: input.evidenceIdsCount,
      hasObservedCommit: input.hasObservedCommit,
      declaredStatus: input.declaredStatus,
    },
  };
}

export interface HandoffReviewFacts {
  declaredFiles: string[];
  evidenceIdsCount: number;
  hasObservedCommit: boolean;
}

function noulOf(answers: Record<string, JevAnswer>, id: string): number | null {
  const a = answers[id];
  return a && a.type === 'noul' ? a.noul : null;
}

/**
 * Regras determinísticas sobre as probabilidades do Jev. Cada sinal é a
 * instrução que volta ao worker (pt-BR) dizendo o que falta.
 */
export function evaluateHandoffEvidence(
  answers: Record<string, JevAnswer>,
  facts: HandoffReviewFacts,
): string[] {
  const signals: string[] = [];
  const isSpecific = noulOf(answers, 'is_specific');
  if (isSpecific !== null && isSpecific < IS_SPECIFIC_MIN) {
    signals.push(
      'resumo genérico/placeholder: descreva o que foi feito neste trabalho',
    );
  }
  const hasVerification = noulOf(answers, 'has_verification');
  if (
    hasVerification !== null &&
    hasVerification < HAS_VERIFICATION_MIN &&
    facts.evidenceIdsCount === 0
  ) {
    signals.push(
      'sem evidência de verificação: cole a saída de testes/typecheck/build ' +
        'ou a referência do commit',
    );
  }
  const admitsIncomplete = noulOf(answers, 'admits_incomplete');
  if (admitsIncomplete !== null && admitsIncomplete > ADMITS_INCOMPLETE_MAX) {
    signals.push(
      'o texto admite pendências, mas o status é success: use partial/blocked ' +
        'ou conclua o que falta',
    );
  }
  const namesChanges = noulOf(answers, 'names_changes');
  if (
    namesChanges !== null &&
    namesChanges < NAMES_CHANGES_MIN &&
    facts.declaredFiles.length === 0 &&
    !facts.hasObservedCommit
  ) {
    signals.push(
      'não lista arquivos/componentes alterados: informe filesModified',
    );
  }
  return signals;
}

export interface JevReviewArtifact {
  readonly kind: 'nexus.jevReview';
  readonly payload: {
    outcome: 'ok' | 'weak';
    model: string;
    probabilities: Record<string, number>;
    signals: string[];
  };
}

export type JevReviewVerdict =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'ok'; readonly artifact: JevReviewArtifact }
  | {
      readonly kind: 'retry';
      readonly signals: string[];
      readonly attempt: number;
      readonly retries: number;
      readonly message: string;
    }
  | {
      readonly kind: 'weak';
      readonly signals: string[];
      readonly artifact: JevReviewArtifact;
    };

interface ReviewBudget {
  attempts: number;
}

/** Orçamento de devoluções por sessão física — morre com o processo. */
const budgetBySession = new Map<string, ReviewBudget>();

function reviewArtifact(
  outcome: 'ok' | 'weak',
  result: JevResult,
  signals: string[],
): JevReviewArtifact {
  const probabilities: Record<string, number> = {};
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === 'noul') probabilities[id] = answer.noul;
  }
  return {
    kind: 'nexus.jevReview',
    payload: { outcome, model: result.model, probabilities, signals },
  };
}

export interface ReviewMissionHandoffDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
}

export async function reviewMissionHandoff(
  params: { sessionId: string | undefined; signal?: AbortSignal } & HandoffReviewInput,
  deps?: ReviewMissionHandoffDeps,
): Promise<JevReviewVerdict> {
  const judgeFn = deps?.judge ?? judge;
  const enabled = deps?.enabled ?? (() => isJevSurfaceEnabled('handoffReview'));
  const hasKey = deps?.hasKey ?? hasJevCredential;

  if (params.declaredStatus !== 'success') {
    return { kind: 'skipped', reason: 'status-not-success' };
  }
  if (!params.sessionId) {
    return { kind: 'skipped', reason: 'no-session' };
  }
  if (!enabled()) {
    return { kind: 'skipped', reason: 'autopilot-disabled' };
  }
  if (!hasKey()) {
    return { kind: 'skipped', reason: 'no-credential' };
  }

  const questions: Record<string, JevQuestion> = {
    is_specific: HANDOFF_REVIEW_QUESTIONS.is_specific,
    has_verification: HANDOFF_REVIEW_QUESTIONS.has_verification,
    admits_incomplete: HANDOFF_REVIEW_QUESTIONS.admits_incomplete,
  };
  // names_changes só faz sentido quando nem o registro nem o commit já
  // apontam os arquivos — a pergunta é redundante com filesModified cheio.
  if (params.declaredFiles.length === 0) {
    questions.names_changes = HANDOFF_REVIEW_QUESTIONS.names_changes;
  }

  const result = await judgeFn({
    state: buildHandoffReviewState(params),
    questions,
    signal: params.signal,
  });
  if (!result) {
    recordJevDecision({
      surface: 'handoffReview',
      sessionId: params.sessionId,
      model: 'unavailable',
      questions: Object.keys(questions),
      probabilities: {},
      decision: 'judge-unavailable',
      inputTokens: 0,
      usd: 0,
    });
    return { kind: 'skipped', reason: 'judge-unavailable' };
  }

  const signals = evaluateHandoffEvidence(result.answers, {
    declaredFiles: params.declaredFiles,
    evidenceIdsCount: params.evidenceIdsCount,
    hasObservedCommit: params.hasObservedCommit,
  });
  const sessionId = params.sessionId;
  const record = (decision: 'ok' | 'retry' | 'weak') =>
    recordJevDecision({
      surface: 'handoffReview',
      sessionId,
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      decision,
      inputTokens: result.usage.input_tokens,
      usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
    });

  if (signals.length === 0) {
    budgetBySession.delete(sessionId);
    record('ok');
    return { kind: 'ok', artifact: reviewArtifact('ok', result, signals) };
  }

  const budget = budgetBySession.get(sessionId) ?? { attempts: 0 };
  budget.attempts += 1;
  if (budget.attempts <= JEV_REVIEW_MAX_BOUNCES) {
    budgetBySession.set(sessionId, budget);
    record('retry');
    return {
      kind: 'retry',
      signals,
      attempt: budget.attempts,
      retries: JEV_REVIEW_MAX_BOUNCES,
      message:
        `revisão de evidência (Jev) — devolução ${budget.attempts}/${JEV_REVIEW_MAX_BOUNCES}: ` +
        `${signals.join('; ')}. ` +
        'Reenvie o nexus_handoff_submit com a evidência real (saída de ' +
        'testes/typecheck, commit, arquivos). Se não conseguir concluir, use ' +
        'status partial ou blocked explicando o impedimento.',
    };
  }

  // Segunda submissão fraca: aceita, mas fica marcada para o Maestro. O
  // orçamento é limpo — um handoff futuro da mesma sessão recomeça do zero.
  budgetBySession.delete(sessionId);
  record('weak');
  return {
    kind: 'weak',
    signals,
    artifact: reviewArtifact('weak', result, signals),
  };
}

export function resetJevReviewBudgetsForTesting(): void {
  budgetBySession.clear();
}
