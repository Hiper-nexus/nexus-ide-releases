/**
 * After a worker status=blocked handoff, open a durable operator question with
 * chips inferred from the reason — minimum product intelligence: stop and ask,
 * don't paint a technical failure and leave the human without a next step.
 */

import { buildClarify, type ClarifyQuestionArtifact } from "../../shared/clarify";
import { inferWorkerDecisionGuidance } from "../../shared/worker-decision-guidance";
import { getProjectDomainStores } from "./project-domain-store-registry";
import type { ScopedStoreBinding } from "./scoped-store";

/**
 * Persist the operator question while the mission still owns live execution
 * authority. The caller may block only after this succeeds.
 */
export function emitWorkerDecisionClarify(
  binding: ScopedStoreBinding,
  missionId: string,
  detail: string,
): { readonly questionId: string } | null {
  const guidance = inferWorkerDecisionGuidance(detail);
  const missionRow = binding
    .readDatabase()
    .prepare(
      `SELECT id, status, intent_state, orch_session_id
       FROM missions WHERE id = ?`,
    )
    .get(missionId) as
    | {
        id: string;
        status: string;
        intent_state: string | null;
        orch_session_id: string | null;
      }
    | undefined;
  if (!missionRow?.orch_session_id) return null;
  if (
    missionRow.status !== "running" ||
    !["dispatched", "executing", "validating"].includes(
      missionRow.intent_state ?? "",
    )
  ) {
    return null;
  }

  const clarify = buildClarify({
    question: guidance.question,
    options: [...guidance.options],
    allowFreeform: true,
  });
  const artifact: ClarifyQuestionArtifact = {
    kind: "nexus-clarify-question",
    schemaVersion: 1,
    clarify,
  };

  const stores = getProjectDomainStores(binding.scope);
  const handoff = stores.handoffs.submit({
    missionId,
    sessionId: missionRow.orch_session_id,
    fromAgent: "Nexus",
    status: "progress",
    summary: `Pergunta ao operador: ${clarify.question}`,
    artifacts: [artifact],
    evidenceIds: [],
  });
  stores.handoffs.markSubmitted(handoff.id);
  return { questionId: handoff.id };
}
