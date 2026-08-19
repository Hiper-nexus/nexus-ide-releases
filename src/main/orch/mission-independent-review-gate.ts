import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import {
  parseReviewFindings,
  type ReviewFindings,
} from './review-findings';

/**
 * Gate civil: missão standard/ops com squad NÃO fica Concluída sem revisão
 * independente com evidência. Implementador sozinho dizendo "ok" nunca basta.
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
  readonly deliveryState?: string;
  readonly artifacts?: unknown;
};

export type ReviewGateDispatch = {
  readonly handoffId?: string;
  readonly sessionId?: string;
  readonly workerId?: string;
  readonly agentCategory?: SquadAgent['category'] | string;
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

function laneOf(mission: Pick<Mission, 'intentContract'>): string {
  return mission.intentContract?.lane ?? 'standard';
}

/**
 * Via Rápida civil (express / livre / yolo): board N/N + files+handoffs
 * fecha sem revisor manual. Guided/legacy continuam exigindo revisão.
 * Maestro-only era o furo 061 (review_missing com 20 seladas no disco).
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

function missionRequiresIndependentReview(
  mission: Pick<Mission, 'squadId' | 'intentContract' | 'intentState'>,
  squad: Squad | null | undefined,
): boolean {
  if (mission.squadId === PET_STUDIO_SQUAD_ID) return false;
  if (squad?.id === PET_STUDIO_SQUAD_ID) return false;
  const lane = laneOf(mission);
  if (lane !== 'standard' && lane !== 'ops') return false;
  if (!mission.squadId) return false;
  if (isCivilianViaRapidaReviewExempt(mission)) return false;
  return true;
}

function categoryOfAgentName(
  name: string | undefined,
  squad: Squad | null | undefined,
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
  squad: Squad | null | undefined,
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
  if (
    handoff.deliveryState !== 'consumed' &&
    handoff.deliveryState !== 'acknowledged'
  ) {
    return false;
  }
  if (!orchestratorSessionId) return false;
  return attempts.some(
    (attempt) =>
      attempt.state === 'accepted' &&
      attempt.acceptedAt !== undefined &&
      attempt.orchestratorSessionId === orchestratorSessionId,
  );
}

function tryParseFindings(handoff: ReviewGateHandoff): ReviewFindings | null {
  try {
    return parseReviewFindings(handoff);
  } catch {
    return null;
  }
}

function hasBlockingFindings(findings: ReviewFindings): boolean {
  if (findings.verdict === 'incorrect') return true;
  return findings.findings.some(
    (finding) => finding.priority === 'P0' || finding.priority === 'P1',
  );
}

/**
 * Evidência física da revisão: IDs Nexus, veredito tipado correto, ou
 * resumo substancial do revisor (≥80 chars) sem sinal de reprovação.
 */
export function reviewerHandoffHasEvidence(handoff: ReviewGateHandoff): boolean {
  if ((handoff.evidenceIds?.length ?? 0) > 0) return true;
  const findings = tryParseFindings(handoff);
  if (findings) {
    return findings.verdict === 'correct' && !hasBlockingFindings(findings);
  }
  const summary = (handoff.summary ?? '').trim();
  if (summary.length < 80) return false;
  if (NEGATIVE_SUMMARY.test(summary)) return false;
  return true;
}

function isNegativeReviewHandoff(handoff: ReviewGateHandoff): boolean {
  if (handoff.status === 'blocked' || handoff.status === 'failed') {
    return true;
  }
  const findings = tryParseFindings(handoff);
  if (findings && hasBlockingFindings(findings)) return true;
  const summary = (handoff.summary ?? '').trim();
  return summary.length > 0 && NEGATIVE_SUMMARY.test(summary);
}

/**
 * Avalia se a missão pode ir a `done`. Puro / testável.
 */
export function evaluateIndependentReviewGate(input: {
  readonly mission: Pick<
    Mission,
    'id' | 'squadId' | 'intentContract' | 'orchestratorSessionId' | 'intentState'
  >;
  readonly squad: Squad | null | undefined;
  readonly handoffs: readonly ReviewGateHandoff[];
  readonly deliveryAttemptsOf: (
    handoffId: string,
  ) => readonly ReviewGateDeliveryAttempt[];
  readonly dispatches?: readonly ReviewGateDispatch[];
}): IndependentReviewGateResult {
  if (!missionRequiresIndependentReview(input.mission, input.squad)) {
    return { ok: true, reviewerHandoffId: 'exempt' };
  }

  const dispatches = input.dispatches ?? [];
  const orchSession = input.mission.orchestratorSessionId;

  const reviewerHandoffs = input.handoffs.filter((handoff) =>
    isReviewerCategory(
      resolveHandoffCategory(handoff, dispatches, input.squad),
    ),
  );

  const rejected = reviewerHandoffs.find((handoff) =>
    isNegativeReviewHandoff(handoff),
  );
  if (rejected) {
    return {
      ok: false,
      code: 'review_rejected',
      reason:
        'A revisão encontrou risco. Corrija com um novo trabalhador — não marque como concluída.',
    };
  }

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
        'Falta revisão independente com evidência. Abra um revisor ou QA, receba a entrega e só então conclua.',
    };
  }

  const withEvidence = acceptedReviewers.find((handoff) =>
    reviewerHandoffHasEvidence(handoff),
  );
  if (!withEvidence) {
    return {
      ok: false,
      code: 'review_without_evidence',
      reason:
        'A revisão chegou sem prova do que foi checado. Peça evidência ao revisor antes de concluir.',
    };
  }

  return { ok: true, reviewerHandoffId: withEvidence.id };
}

/** Lança se o gate falhar — usado em completeVerified / set_status done. */
export function assertIndependentReviewForDone(
  input: Parameters<typeof evaluateIndependentReviewGate>[0],
): void {
  const result = evaluateIndependentReviewGate(input);
  if (result.ok) return;
  throw new Error(`${result.code}: ${result.reason}`);
}
