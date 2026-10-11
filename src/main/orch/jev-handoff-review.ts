import { decisionResultUsage } from '../decision-models/decision-usage';
/**
 * Revisão de evidência do handoff de missão via TypeSafe Jev (piloto
 * automático). No `nexus_handoff_submit` declarado `success`, o Jev julga o
 * relatório do worker; relatório fraco volta UMA vez ao worker dizendo o que
 * falta (mesma UX do contrato determinístico de delivery-contract.ts); um
 * segundo envio fraco é aceito mas marcado `[evidência fraca]` + artifact
 * `nexus.jevReview` para o Maestro decidir com evidência.
 *
 * F-707: só devolve o que o worker conserta anexando — resumo genérico, e
 * mudança de código sem verificação ou sem dizer onde está. Pendência
 * admitida, e revisão/plano sem teste, entram marcados sem devolução: nas 105
 * entregas reais do HiperGO (30/09) a rubrica antiga devolveria 98, e em
 * produção 22 das 44 devolvidas nunca voltaram ao Maestro. A régua nova,
 * medida no mesmo conjunto com o Jev real, devolve 3. Mudou o texto?
 * Reavalie no mesmo conjunto antes de publicar.
 *
 * FAIL-OPEN em tudo: sem chave, autopilot desligado, timeout ou `judge()`
 * null → `skipped` e o fluxo segue exatamente como hoje.
 */
import {
  capText,
  judge,
  type JevAnswer,
  type JevQuestion,
  type JevResult,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerProbabilities,
  recordJevDecision,
  setJevDecisionFeedback,
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
export const CHANGED_CODE_MIN = 0.5;

/** Quantas devoluções o worker recebe antes de o handoff entrar como fraco. */
export const JEV_REVIEW_MAX_BOUNCES = 1;

/**
 * Prazo do judge no handoff. O review roda ANTES da escrita durável e do
 * delivery ao pai: sem teto, o default do transporte (8 s + retry de 400 ms)
 * chegava a ~16 s de rede segurando a entrega. Timeout vira `skipped`
 * (fail-open), nunca bloqueia o handoff.
 */
export const JEV_REVIEW_TIMEOUT_MS = 5_000;

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
      'Does the report show evidence that the work was checked — test results, ' +
      'typecheck/build output, command output or a commit reference; for a ' +
      'review or audit, concrete cited evidence such as file:line references ' +
      'or reproduced cases; for a planning, mapping or research task, the ' +
      'concrete output it produced (document path, sections, file:line map)? ' +
      'Merely claiming the work is done, or promising to check later, is not ' +
      'evidence.',
    criteria: {
      true: 'verification output, commit reference, cited evidence, or the concrete produced output is present',
      false: 'only claims, with no verification, evidence or concrete output',
    },
  },
  // Revisor que relata NÃO PASS fez o trabalho dele: achado sobre o código
  // revisado não é pendência (era 52 das 75 devoluções em 30/09).
  admits_incomplete: {
    type: 'noul',
    instructions:
      'Does the worker admit that part of ITS OWN assigned task was left ' +
      'undone, skipped, blocked or not verified? Bugs, failing checks, NOT ' +
      'PASS verdicts, residual risks or findings that the worker discovered in ' +
      'the code or work it was asked to review are RESULTS of a completed ' +
      'task, not unfinished work.',
    criteria: {
      true: 'the worker admits parts of its own task are unfinished, skipped or blocked',
      false: "the worker's own task is complete (reported findings about reviewed work do not count)",
    },
  },
  // Decide se falta de verificação ou de arquivos devolve: revisão, análise
  // e plano não mudam código e não têm teste a colar.
  changed_code: {
    type: 'noul',
    instructions:
      'Did the worker itself change code, configuration or other repository ' +
      'files as part of this task (edits, commits, pushes)? Reviews, audits, ' +
      'analyses, plans and reports that only read code, or only wrote a ' +
      'planning/report document, did not change code.',
    criteria: {
      true: 'the worker changed code, configuration or repository files',
      false: 'the worker only read, reviewed, analyzed or wrote a report/plan document',
    },
  },
  // Só entra no judge quando declaredFiles está vazio (ver reviewMissionHandoff).
  names_changes: {
    type: 'noul',
    instructions:
      'Does the report say where its changes live — the files, modules or ' +
      'components changed, or the commit, branch or document it produced — or ' +
      'state that the task was read-only and changed nothing?',
    criteria: {
      true: 'names changed files/components, a commit/branch/document, or explicitly changed nothing',
      false: 'changed something but does not say where',
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

interface HandoffSignal {
  readonly text: string;
  /** O worker conserta anexando: vale uma devolução. */
  readonly bounce: boolean;
}

function handoffSignals(
  answers: Record<string, JevAnswer>,
  facts: HandoffReviewFacts,
): HandoffSignal[] {
  const signals: HandoffSignal[] = [];
  const changedCode =
    facts.declaredFiles.length > 0 ||
    facts.hasObservedCommit ||
    (noulOf(answers, 'changed_code') ?? 0) >= CHANGED_CODE_MIN;
  const isSpecific = noulOf(answers, 'is_specific');
  if (isSpecific !== null && isSpecific < IS_SPECIFIC_MIN) {
    signals.push({
      text: 'resumo genérico/placeholder: descreva o que foi feito neste trabalho',
      bounce: true,
    });
  }
  const hasVerification = noulOf(answers, 'has_verification');
  if (
    hasVerification !== null &&
    hasVerification < HAS_VERIFICATION_MIN &&
    facts.evidenceIdsCount === 0
  ) {
    signals.push({
      text:
        'sem evidência de verificação: cole a saída de testes/typecheck/build ' +
        'ou a referência do commit',
      bounce: changedCode,
    });
  }
  const admitsIncomplete = noulOf(answers, 'admits_incomplete');
  if (admitsIncomplete !== null && admitsIncomplete > ADMITS_INCOMPLETE_MAX) {
    signals.push({
      text:
        'o texto admite pendências, mas o status é success: use partial/blocked ' +
        'ou conclua o que falta',
      bounce: false,
    });
  }
  const namesChanges = noulOf(answers, 'names_changes');
  if (
    namesChanges !== null &&
    namesChanges < NAMES_CHANGES_MIN &&
    facts.declaredFiles.length === 0 &&
    !facts.hasObservedCommit
  ) {
    signals.push({
      text: 'não lista arquivos/componentes alterados: informe filesModified',
      bounce: changedCode,
    });
  }
  return signals;
}

/**
 * Regras determinísticas sobre as probabilidades do Jev. Cada sinal é a
 * instrução (pt-BR) dizendo o que falta; todos vão no artifact.
 */
export function evaluateHandoffEvidence(
  answers: Record<string, JevAnswer>,
  facts: HandoffReviewFacts,
): string[] {
  return handoffSignals(answers, facts).map((signal) => signal.text);
}

/** Os sinais que valem devolução (F-707); o resto entra marcado. */
export function handoffBounceSignals(
  answers: Record<string, JevAnswer>,
  facts: HandoffReviewFacts,
): string[] {
  return handoffSignals(answers, facts)
    .filter((signal) => signal.bounce)
    .map((signal) => signal.text);
}

export interface JevReviewArtifact {
  readonly kind: 'nexus.jevReview';
  readonly payload: {
    outcome: 'ok' | 'weak';
    model: string;
    probabilities: Record<string, number>;
    signals: string[];
    /**
     * F-782: id da linha desta revisão no diário do Jev. O ACK do Maestro
     * marca certo/errado exatamente nela (ver `recordHandoffAckFeedback`).
     */
    decisionId?: string;
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
      /**
       * F-823: os sinais que o MCP devolveria ao worker (ver
       * `handoffBounceSignals`). Vazio = fraca só por sinal que nem o MCP
       * devolve (pendência admitida, revisão/plano sem teste).
       */
      readonly bounceSignals?: string[];
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
  decisionId: string,
): JevReviewArtifact {
  const probabilities: Record<string, number> = {};
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === 'noul') probabilities[id] = answer.noul;
  }
  return {
    kind: 'nexus.jevReview',
    payload: { outcome, model: result.model, probabilities, signals, decisionId },
  };
}

export interface ReviewMissionHandoffDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
}

export async function reviewMissionHandoff(
  params: {
    sessionId: string | undefined;
    /** F-782: missão do handoff — vai para o diário junto com a sessão. */
    missionId?: string;
    signal?: AbortSignal;
    maxBounces?: number;
  } & HandoffReviewInput,
  deps?: ReviewMissionHandoffDeps,
): Promise<JevReviewVerdict> {
  const judgeFn = deps?.judge ?? judge;
  const enabled = deps?.enabled ?? (() => isJevSurfaceEnabled('handoffReview'));
  const hasKey = deps?.hasKey ?? (() => hasDecisionCredential('handoffReview'));
  // Caminho sem canal de devolução (fechamento mecânico PTY) passa 0: a
  // entrega fraca NASCE weak — o worker já encerrou e não pode reenviar.
  const maxBounces = params.maxBounces ?? JEV_REVIEW_MAX_BOUNCES;

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
    changed_code: HANDOFF_REVIEW_QUESTIONS.changed_code,
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
    // O review segura a escrita durável do handoff: o prazo é o limite real
    // de espera, e o retry do transporte só dobraria a latência da entrega
    // ao pai sem melhorar o veredito (timeout vira skipped/fail-open).
    timeoutMs: JEV_REVIEW_TIMEOUT_MS,
    retryOnTimeout: false,
    surface: 'handoffReview',
    // F-1164: a consulta conta no orçamento da missão do handoff (e o no-answer leva a missão ao diário).
    sessionId: params.sessionId,
    missionId: params.missionId,
  });
  if (!result) {
    recordJevDecision({
      surface: 'handoffReview',
      sessionId: params.sessionId,
      missionId: params.missionId,
      model: 'unavailable',
      questions: Object.keys(questions),
      probabilities: {},
      decision: 'judge-unavailable',
      inputTokens: 0,
      usd: 0,
    });
    return { kind: 'skipped', reason: 'judge-unavailable' };
  }

  const facts: HandoffReviewFacts = {
    declaredFiles: params.declaredFiles,
    evidenceIdsCount: params.evidenceIdsCount,
    hasObservedCommit: params.hasObservedCommit,
  };
  const signals = evaluateHandoffEvidence(result.answers, facts);
  const bounceSignals = handoffBounceSignals(result.answers, facts);
  const sessionId = params.sessionId;
  const record = (decision: 'ok' | 'retry' | 'weak'): string =>
    recordJevDecision({
      surface: 'handoffReview',
      sessionId,
      missionId: params.missionId,
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      decision,
      ...decisionResultUsage(result),
    });

  if (signals.length === 0) {
    budgetBySession.delete(sessionId);
    const decisionId = record('ok');
    return { kind: 'ok', artifact: reviewArtifact('ok', result, signals, decisionId) };
  }

  const budget = budgetBySession.get(sessionId) ?? { attempts: 0 };
  if (bounceSignals.length > 0 && budget.attempts < maxBounces) {
    budget.attempts += 1;
    budgetBySession.set(sessionId, budget);
    record('retry');
    return {
      kind: 'retry',
      signals: bounceSignals,
      attempt: budget.attempts,
      retries: maxBounces,
      message:
        `revisão de evidência (Jev) — devolução ${budget.attempts}/${maxBounces}: ` +
        `${bounceSignals.join('; ')}. ` +
        'Reenvie o nexus_handoff_submit com a evidência real (saída de ' +
        'testes/typecheck, commit, arquivos). Se não conseguir concluir, use ' +
        'status partial ou blocked explicando o impedimento.',
    };
  }

  // Segunda submissão fraca, ou sinal que não vale devolução: aceita, mas
  // fica marcada para o Maestro. O orçamento é limpo — um handoff futuro da
  // mesma sessão recomeça do zero.
  budgetBySession.delete(sessionId);
  const decisionId = record('weak');
  return {
    kind: 'weak',
    signals,
    artifact: reviewArtifact('weak', result, signals, decisionId),
    bounceSignals,
  };
}

export function resetJevReviewBudgetsForTesting(): void {
  budgetBySession.clear();
}

/**
 * F-782: veredito do Maestro ao consumir o handoff (`nexus_handoff_ack`).
 * `accepted` = entrega aceita como veio; `rework` = devolvida ou refeita.
 */
export type HandoffAckVerdict = 'accepted' | 'rework';

/**
 * F-782: o Jev acerta quando concorda com o Maestro. Revisão `ok` aceita e
 * revisão `weak` devolvida são certas; `ok` devolvida (deixou passar) e
 * `weak` aceita (limiar rígido demais) são erradas. É exatamente o rótulo que
 * separa "limiar rígido" de "handoff ruim" nas 81% de recusas da revisão.
 */
export function handoffReviewFeedback(
  outcome: JevReviewArtifact['payload']['outcome'],
  verdict: HandoffAckVerdict,
): 'right' | 'wrong' {
  return (outcome === 'ok') === (verdict === 'accepted') ? 'right' : 'wrong';
}

/**
 * Recibo da revisão Jev nos artifacts do handoff. O Main anexa o dele por
 * último; o worker também escreve artifacts, por isso vale o ÚLTIMO e o id
 * ainda é conferido contra o diário (superfície e sessão) antes de marcar.
 */
export function jevReviewReceipt(
  artifacts: readonly unknown[],
): { decisionId: string; outcome: 'ok' | 'weak' } | null {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (!artifact || typeof artifact !== 'object') continue;
    const { kind, payload } = artifact as { kind?: unknown; payload?: unknown };
    if (kind !== 'nexus.jevReview' || !payload || typeof payload !== 'object') continue;
    const { decisionId, outcome } = payload as { decisionId?: unknown; outcome?: unknown };
    if (typeof decisionId !== 'string' || decisionId.length === 0) return null;
    if (outcome !== 'ok' && outcome !== 'weak') return null;
    return { decisionId, outcome };
  }
  return null;
}

/**
 * F-782: aplica o veredito do Maestro à decisão do Jev que revisou ESTE
 * handoff. Sem recibo (revisão pulada, handoff antigo) não há o que marcar.
 * Só marca linha `handoffReview` da mesma sessão do handoff — um id copiado
 * de outra sessão não rotula nada. Contabilidade derivada: nunca lança.
 */
export function recordHandoffAckFeedback(
  handoff: { readonly artifacts: readonly unknown[]; readonly sessionId?: string },
  verdict: HandoffAckVerdict,
  deps?: { dir?: string },
): 'right' | 'wrong' | null {
  try {
    const receipt = jevReviewReceipt(handoff.artifacts);
    if (!receipt || !handoff.sessionId) return null;
    const feedback = handoffReviewFeedback(receipt.outcome, verdict);
    const marked = setJevDecisionFeedback(receipt.decisionId, feedback, {
      dir: deps?.dir,
      accept: (entry) =>
        entry.surface === 'handoffReview' &&
        entry.sessionId === handoff.sessionId &&
        entry.decision === receipt.outcome,
    });
    return marked ? feedback : null;
  } catch (error) {
    console.warn('[jev] feedback do ACK falhou (ignorado):', error);
    return null;
  }
}

/**
 * F-786: destino do veredito no caminho SEM canal de devolução (fechamento
 * mecânico PTY). Fraca por sinal que o MCP devolveria (resumo genérico,
 * código sem verificação ou sem dizer onde) vira `partial`: aqui não há
 * devolução, e a entrega nunca é success sem a prova requerida. `retry` não
 * deve ocorrer (a revisão roda com maxBounces 0), mas se ocorrer o destino é
 * o mesmo. `skipped` é fail-open, como no MCP.
 *
 * F-823: fraca SÓ por sinal que nem o MCP devolve (pendência admitida,
 * revisão/plano sem teste) espelha o MCP — success marcado `[evidência
 * fraca]`. Rebaixar a partial tirava a entrega do portão de regressão e do
 * done e fazia CLI sem MCP entrar em loop de redespacho. Sem a informação
 * (`bounceSignals` ausente), fica o destino conservador de antes.
 */
export function mechanicalHandoffReviewOutcome(verdict: JevReviewVerdict): {
  readonly status: 'success' | 'partial';
  readonly mark: boolean;
  readonly artifacts: readonly JevReviewArtifact[];
} {
  switch (verdict.kind) {
    case 'ok':
      return { status: 'success', mark: false, artifacts: [verdict.artifact] };
    case 'weak':
      return {
        status: verdict.bounceSignals?.length === 0 ? 'success' : 'partial',
        mark: true,
        artifacts: [verdict.artifact],
      };
    case 'retry':
      return { status: 'partial', mark: true, artifacts: [] };
    default:
      return { status: 'success', mark: false, artifacts: [] };
  }
}
