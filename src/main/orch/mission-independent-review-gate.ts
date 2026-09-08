import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import type { HandoffEvidenceBinding, Mission, SquadAgent } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { isAutomaticCompletionProof } from './automatic-completion-proof';
import { isFrozenMissionReviewProof } from './mission-review-proof';

/**
 * Gate de conclusão: decide por recibos do Main, nunca pelo resumo de um
 * implementador ou pela quantidade de mensagens antigas do revisor.
 */

export type IndependentReviewGateCode =
  | 'review_missing'
  | 'review_without_evidence'
  | 'review_rejected';

export type IndependentReviewGateResult =
  | { readonly ok: true; readonly reviewerHandoffId: string }
  | {
      readonly ok: false;
      readonly code: IndependentReviewGateCode;
      /** Frase acionável (PT) — Maestro e operador. */
      readonly reason: string;
    };

export type ReviewGateHandoff = {
  readonly id: string;
  readonly status: string;
  readonly summary?: string;
  readonly fromAgent?: string;
  readonly sessionId?: string;
  readonly evidenceIds?: readonly string[];
  readonly evidenceTrust?: 'unverified' | 'nexus-trusted' | 'stale';
  readonly evidenceBinding?: HandoffEvidenceBinding;
  readonly deliveryState?: string;
  readonly artifacts?: unknown;
};

export type ReviewGateDispatch = {
  readonly handoffId?: string;
  readonly sessionId?: string;
  readonly workerId?: string;
  readonly agentCategory?: SquadAgent['category'] | string;
};

/**
 * Visão estrutural mínima de squad para o gate — produção passa o Squad
 * completo; o caminho civil pode passar projeções leves ({agents, id?}).
 */
export type ReviewGateSquadView = {
  readonly id?: string;
  readonly agents: readonly SquadAgent[];
};

export type ReviewGateDeliveryAttempt = {
  readonly state: string;
  readonly acceptedAt?: number;
  readonly orchestratorSessionId?: string;
};

const REVIEWER_NAME_HINT =
  /\b(reviewer|revisor|qa|verificar|verifica|quality|auditor)\b/i;

/** Só frases de reprovação clara — "sem regressão" NÃO conta como negativa. */
const NEGATIVE_SUMMARY =
  /\b(reprovad[oa]?|não\s+aprov|nao\s+aprov|reject(?:ed)?|incorrect|veredito\s+negativ)\b/i;

/**
 * Vereditos ESTRUTURADOS por story ("[VALIDADA]"/"[REPROVADA]", pedidos pelo
 * prompt do revisor) decidem antes de qualquer heurística de texto. Gate 0.62
 * (19/08): o revisor entregou 3/3 "[VALIDADA] ... Nenhuma story reprovada" e
 * a regex crua leu "reprovada" como reprovação — a melhor revisão do voo
 * virou review_rejected em loop e a missão nunca concluiu. Menção NEGADA
 * ("nenhuma/sem/zero/0 ... reprovad...") tampouco conta como negativa.
 */
const STORY_VERDICT_REJECTED = /\[\s*reprovad[ao]?\s*\]/i;
const STORY_VERDICT_APPROVED = /\[\s*validad[ao]?\s*\]/i;
const NEGATED_REJECTION_MENTION =
  /\b(nenhum[a]?|sem|zero|0)\b[^.\n]{0,60}?\breprovad\w*/gi;

export function reviewSummaryLooksNegative(summary: string): boolean {
  if (STORY_VERDICT_REJECTED.test(summary)) return true;
  if (STORY_VERDICT_APPROVED.test(summary)) return false;
  const withoutNegatedMentions = summary.replace(
    NEGATED_REJECTION_MENTION,
    ' ',
  );
  return NEGATIVE_SUMMARY.test(withoutNegatedMentions);
}

function laneOf(mission: Pick<Mission, 'intentContract'>): string {
  return mission.intentContract?.lane ?? 'standard';
}

function isReviewContentExempt(
  mission: Pick<Mission, 'squadId' | 'intentContract'>,
  squad: ReviewGateSquadView | null | undefined,
): boolean {
  if (mission.squadId === PET_STUDIO_SQUAD_ID || squad?.id === PET_STUDIO_SQUAD_ID) return true;
  const lane = laneOf(mission);
  return lane !== 'standard' && lane !== 'ops';
}

/**
 * Via Rápida dispensa o revisor manual. A verificação automática canônica
 * continua obrigatória no caminho standard com squad antes da conclusão.
 */
export function isCivilianViaRapidaReviewExempt(
  mission: Pick<Mission, 'intentState' | 'intentContract'>,
): boolean {
  const mode = mission.intentContract?.orchestrationMode;
  if (mode === 'guided') return false;
  if (mission.intentState === 'legacy') return false;
  if (mission.intentContract?.freeAgentChoice === true) return true;
  return mode === 'livre';
}

/**
 * Identifica o fluxo de revisor do roster. O caminho civil reutiliza seu
 * Council quando há workflow congelado; sem ele, executa a revisão automática.
 */
export function missionRequiresIndependentReview(
  mission: Pick<Mission, 'squadId' | 'intentContract' | 'intentState'>,
  squad: ReviewGateSquadView | null | undefined,
): boolean {
  if (isReviewContentExempt(mission, squad)) return false;
  if (!mission.squadId) return false;
  if (isCivilianViaRapidaReviewExempt(mission)) return false;
  return true;
}

/** Matches the standard squad completion route that produces automatic receipts. */
export function missionRequiresAutomaticCompletionReview(
  mission: Pick<Mission, 'squadId' | 'intentContract'>,
  squad: ReviewGateSquadView | null | undefined,
): boolean {
  return Boolean(mission.squadId) && laneOf(mission) === 'standard' &&
    !isReviewContentExempt(mission, squad);
}

function categoryOfAgentName(
  name: string | undefined,
  squad: ReviewGateSquadView | null | undefined,
): SquadAgent['category'] | undefined {
  if (!name) return undefined;
  const hit = squad?.agents.find(
    (agent) => agent.agentName.trim() === name.trim(),
  );
  return hit?.category;
}

function resolveHandoffCategory(
  handoff: ReviewGateHandoff,
  dispatches: readonly ReviewGateDispatch[],
  squad: ReviewGateSquadView | null | undefined,
): SquadAgent['category'] | 'unknown' {
  const byHandoff = dispatches.find(
    (dispatch) =>
      dispatch.handoffId === handoff.id && dispatch.agentCategory,
  );
  if (byHandoff?.agentCategory) {
    return byHandoff.agentCategory as SquadAgent['category'];
  }
  const bySession = dispatches.find(
    (dispatch) =>
      handoff.sessionId &&
      dispatch.sessionId === handoff.sessionId &&
      dispatch.agentCategory,
  );
  if (bySession?.agentCategory) {
    return bySession.agentCategory as SquadAgent['category'];
  }
  const fromRoster = categoryOfAgentName(handoff.fromAgent, squad);
  if (fromRoster) return fromRoster;
  if (REVIEWER_NAME_HINT.test(handoff.fromAgent ?? '')) return 'reviewer';
  return 'unknown';
}

function isReviewerCategory(
  category: SquadAgent['category'] | 'unknown',
): boolean {
  return category === 'reviewer';
}

function acceptedByCurrentOrchestrator(
  handoff: ReviewGateHandoff,
  attempts: readonly ReviewGateDeliveryAttempt[],
  orchestratorSessionId: string | undefined,
): boolean {
  // consumed (nexus_handoff_ack com recibo físico) e acknowledged (list-ack:
  // o Maestro da missão LISTOU e recebeu summary+artifacts na resposta) são
  // recibos gravados pelo MAIN — valem por si, sem attempt digitado (0.64:
  // handoff reconhecido via list nunca teve paste+Enter e travava aqui).
  if (
    handoff.deliveryState === 'consumed' ||
    handoff.deliveryState === 'acknowledged'
  ) {
    return true;
  }
  if (
    // 'submitted' com attempt ACEITO conta: a prova física (paste+Enter
    // confirmados pelo main) já existe — exigir o ack do modelo por cima
    // era cerimônia que travava a missão com a revisão entregue e lida
    // (gate 0.62/19-08: Maestro leu o delivery_metadata e nunca chamou
    // nexus_handoff_ack; redelivery em loop, missão nunca concluía).
    handoff.deliveryState !== 'submitted'
  ) {
    return false;
  }
  if (!orchestratorSessionId) return false;
  return attempts.some(
    (attempt) =>
      attempt.state === 'accepted' &&
      attempt.acceptedAt !== undefined,
    // Nota (gate 0.62): a exigência de orchestratorSessionId === corrente
    // caiu — attempts são gravados pelo MAIN só para orquestradores
    // legítimos da missão; o respawn do Maestro (A3) trocava a sessão e
    // invalidava a prova de uma revisão já aceita, voltando a
    // review_missing para sempre.
  );
}

/**
 * Store-resolved review references are candidates for evidence, never a
 * verdict. The current Main-owned council below decides their meaning.
 */
export function reviewerHandoffHasEvidence(handoff: ReviewGateHandoff): boolean {
  return handoff.evidenceTrust === 'nexus-trusted' &&
    handoff.evidenceBinding !== undefined &&
    handoff.evidenceIds?.some((id) => id.startsWith('review:')) === true;
}

export interface IndependentReviewGateInput {
  readonly mission: Pick<
    Mission,
    'id' | 'squadId' | 'intentContract' | 'orchestratorSessionId' | 'intentState' | 'intentVersion' | 'updatedAt'
  >;
  readonly scope?: ProjectExecutionScope;
  /** In-process receipts only. A serialized object can never pass the guards. */
  readonly automaticProof?: unknown;
  readonly frozenReviewProof?: unknown;
  /** Main validated the team's textual answer; never supplied by MCP input. */
  readonly textOnly?: boolean;
  readonly squad: ReviewGateSquadView | null | undefined;
  readonly handoffs: readonly ReviewGateHandoff[];
  readonly deliveryAttemptsOf: (
    handoffId: string,
  ) => readonly ReviewGateDeliveryAttempt[];
  readonly dispatches?: readonly ReviewGateDispatch[];
}

function mainOwnedReviewDecision(input: IndependentReviewGateInput): IndependentReviewGateResult | null {
  if (!input.scope) return null;
  if (isAutomaticCompletionProof(input.automaticProof, input.scope, input.mission)) {
    return {
      ok: true,
      reviewerHandoffId: input.automaticProof.status === 'verified'
        ? 'main-automatic-verification' : 'main-check-unavailable',
    };
  }
  if (!isFrozenMissionReviewProof(input.frozenReviewProof, input.scope, input.mission)) return null;
  const proof = input.frozenReviewProof;
  if (!proof.candidateCurrent) {
    return { ok: false, code: 'review_without_evidence',
      reason: 'A entrega mudou depois da revisão. O Nexus precisa verificar o candidato atual.' };
  }
  if (proof.gate.reason === 'blocking-findings') {
    return { ok: false, code: 'review_rejected',
      reason: 'A revisão do candidato atual encontrou problemas. A correção precisa passar por nova verificação.' };
  }
  if (proof.gate.ready && proof.gate.evidenceIds.length > 0) {
    return { ok: true, reviewerHandoffId: proof.gate.evidenceIds[0]! };
  }
  return { ok: false, code: 'review_without_evidence',
    reason: 'O candidato atual ainda não tem uma revisão independente registrada pelo Nexus.' };
}

/** Current Main-owned evidence decides; handoff history only explains a missing check. */
export function evaluateIndependentReviewGate(input: IndependentReviewGateInput): IndependentReviewGateResult {
  if (input.textOnly === true || (
    !missionRequiresIndependentReview(input.mission, input.squad) &&
    !missionRequiresAutomaticCompletionReview(input.mission, input.squad)
  )) {
    return { ok: true, reviewerHandoffId: 'exempt' };
  }
  const proofDecision = mainOwnedReviewDecision(input);
  if (proofDecision) return proofDecision;

  const dispatches = input.dispatches ?? [];
  const orchSession = input.mission.orchestratorSessionId;

  const reviewerHandoffs = input.handoffs.filter((handoff) =>
    isReviewerCategory(
      resolveHandoffCategory(handoff, dispatches, input.squad),
    ),
  );

  const acceptedReviewers = reviewerHandoffs.filter(
    (handoff) =>
      handoff.status === 'success' &&
      acceptedByCurrentOrchestrator(
        handoff,
        input.deliveryAttemptsOf(handoff.id),
        orchSession,
      ),
  );

  if (acceptedReviewers.length === 0) {
    return {
      ok: false,
      code: 'review_missing',
      reason:
        'Esta entrega precisa passar pela verificação automática do Nexus antes de concluir.',
    };
  }

  return {
    ok: false,
    code: 'review_without_evidence',
    reason: 'O resumo recebido não comprova a verificação da entrega atual. O Nexus precisa executar a verificação automática.',
  };
}

/** Lança se o gate falhar — usado em completeVerified / set_status done. */
export function assertIndependentReviewForDone(
  input: Parameters<typeof evaluateIndependentReviewGate>[0],
): void {
  const result = evaluateIndependentReviewGate(input);
  if (result.ok) return;
  throw new Error(`${result.code}: ${result.reason}`);
}
