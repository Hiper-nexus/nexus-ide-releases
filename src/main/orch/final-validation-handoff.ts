import type { Handoff } from '../../shared/orch-types';

const FINAL_VALIDATION_AGENT = 'nexus-prevc-autopilot';

interface FinalValidationHandoffStore {
  list(filter: {
    missionId: string;
    includeDelivered: boolean;
  }): readonly Handoff[];
  submit(input: {
    status: 'success';
    summary: string;
    evidenceIds: string[];
    missionId: string;
    fromAgent: string;
  }): Handoff;
}

interface PublishFinalValidationInput {
  readonly missionId: string;
  readonly workflowRevision: number;
  readonly evidenceIds: readonly string[];
}

function sameEvidenceIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Converts successful Nexus-owned validation evidence into the trusted handoff
 * consumed by the Mission Driver. Replays are idempotent for the same workflow
 * revision, while the store still verifies every evidence binding atomically.
 */
export function publishFinalValidationHandoff(
  input: PublishFinalValidationInput,
  handoffs: FinalValidationHandoffStore,
): Handoff {
  const evidenceIds = [...new Set(input.evidenceIds)].sort();
  const current = handoffs.list({
    missionId: input.missionId,
    includeDelivered: true,
  }).filter(
    (handoff) =>
      handoff.fromAgent === FINAL_VALIDATION_AGENT &&
      handoff.status === 'success' &&
      handoff.sessionId === undefined &&
      handoff.workerIncarnationId === undefined &&
      handoff.mcpProvenance === undefined &&
      handoff.evidenceTrust === 'nexus-trusted' &&
      handoff.evidenceBinding?.missionId === input.missionId &&
      handoff.evidenceBinding?.workflowRevision === input.workflowRevision,
  );
  if (evidenceIds.length === 0) {
    const existing = current.at(-1);
    if (existing) return existing;
    throw new Error('final validation produced no trusted evidence');
  }

  const existing = current.find((handoff) =>
    sameEvidenceIds([...handoff.evidenceIds].sort(), evidenceIds),
  );
  if (existing) return existing;

  return handoffs.submit({
    status: 'success',
    summary:
      'Nexus PREVC final validation passed with current sensor and independent review evidence.',
    evidenceIds,
    missionId: input.missionId,
    fromAgent: FINAL_VALIDATION_AGENT,
  });
}
