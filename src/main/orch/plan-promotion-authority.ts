import { createHash } from "node:crypto";
import {
  MAX_PROMOTED_PLAN_SUMMARY_BYTES,
  MAX_PROMOTED_PLAN_SUMMARY_CHARS,
  promotedPlanSnapshotSchema,
  type PromotedPlanSnapshot,
} from "../../shared/mission-intent";
import type { Handoff, Mission } from "../../shared/orch-types";

const MAX_PROMOTED_PLAN_ARTIFACT_BYTES = 16 * 1024;
const MAX_PROMOTED_PLAN_JSON_NODES = 4_096;
const MAX_PROMOTED_PLAN_JSON_DEPTH = 32;
const INVISIBLE_AUTHORITY_TEXT =
  /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u;

interface PlanHandoffStore {
  list(filter: {
    missionId: string;
    includeDelivered: boolean;
  }): readonly Handoff[];
  get(id: string): Handoff | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSafeJsonValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): void {
  state.nodes += 1;
  if (
    state.nodes > MAX_PROMOTED_PLAN_JSON_NODES ||
    depth > MAX_PROMOTED_PLAN_JSON_DEPTH
  ) {
    throw new Error(
      "plan_handoff_invalid: artifacts excedem a complexidade permitida",
    );
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "plan_handoff_invalid: artifacts contêm número não finito",
      );
    }
    return;
  }
  if (typeof value === "string") {
    if (INVISIBLE_AUTHORITY_TEXT.test(value)) {
      throw new Error(
        "plan_handoff_invalid: artifacts contêm controles invisíveis",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJsonValue(item, state, depth + 1);
    return;
  }
  if (typeof value !== "object") {
    throw new Error(
      "plan_handoff_invalid: artifacts precisam ser JSON persistível",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      "plan_handoff_invalid: artifacts precisam ser objetos JSON simples",
    );
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      INVISIBLE_AUTHORITY_TEXT.test(key)
    ) {
      throw new Error("plan_handoff_invalid: artifacts contêm chave insegura");
    }
    assertSafeJsonValue(item, state, depth + 1);
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

function canonicalArtifacts(artifacts: readonly unknown[]): {
  readonly value: unknown[];
  readonly json: string;
} {
  assertSafeJsonValue(artifacts, { nodes: 0 });
  const value = canonicalJsonValue(artifacts) as unknown[];
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_PROMOTED_PLAN_ARTIFACT_BYTES) {
    throw new Error("plan_handoff_invalid: artifacts do plano excedem 16 KiB");
  }
  return { value, json };
}

function planDigestInput(
  snapshot: Omit<PromotedPlanSnapshot, "digest">,
): string {
  return JSON.stringify(
    canonicalJsonValue({
      version: snapshot.version,
      handoffId: snapshot.handoffId,
      sourceIntentVersion: snapshot.sourceIntentVersion,
      sourceSessionId: snapshot.sourceSessionId,
      sourceWorkerIncarnationId: snapshot.sourceWorkerIncarnationId ?? null,
      handoffCreatedAt: snapshot.handoffCreatedAt,
      physicalReceipt: snapshot.physicalReceipt,
      summary: snapshot.summary,
      artifacts: snapshot.artifacts,
      summarySha256: snapshot.summarySha256,
      artifactsSha256: snapshot.artifactsSha256,
    }),
  );
}

function assertPhysicalPlanHandoff(input: {
  readonly mission: Mission;
  readonly sourceSessionId: string;
  readonly handoff: Handoff;
}): void {
  const { mission, sourceSessionId, handoff } = input;
  const contract = mission.intentContract;
  const provenance = handoff.mcpProvenance;
  if (
    !contract ||
    contract.lane !== "plan" ||
    contract.intentVersion !== mission.intentVersion ||
    contract.dispatchedAt === undefined
  ) {
    throw new Error(
      "plan_handoff_invalid: a revisão plan atual não possui dispatch físico",
    );
  }
  if (
    handoff.missionId !== mission.id ||
    handoff.sessionId !== sourceSessionId ||
    handoff.authorityOrigin !== "agent" ||
    handoff.status !== "success" ||
    !provenance ||
    provenance.toolName !== "nexus_handoff_submit" ||
    provenance.missionId !== mission.id ||
    provenance.sessionId !== sourceSessionId ||
    (provenance.workerIncarnationId ?? undefined) !==
      (handoff.workerIncarnationId ?? undefined) ||
    provenance.issuedAt < contract.dispatchedAt ||
    handoff.createdAt < contract.dispatchedAt
  ) {
    throw new Error(
      "plan_handoff_invalid: handoff esperado não possui provenance física compatível",
    );
  }
  if (
    !handoff.summary.trim() ||
    handoff.summary.length > MAX_PROMOTED_PLAN_SUMMARY_CHARS ||
    Buffer.byteLength(handoff.summary, "utf8") >
      MAX_PROMOTED_PLAN_SUMMARY_BYTES ||
    INVISIBLE_AUTHORITY_TEXT.test(handoff.summary)
  ) {
    throw new Error(
      "plan_handoff_invalid: resumo do PRD/plano é vazio, inseguro ou grande demais",
    );
  }
}

function snapshotFromPhysicalHandoff(input: {
  readonly mission: Mission;
  readonly sourceSessionId: string;
  readonly handoff: Handoff;
}): PromotedPlanSnapshot {
  assertPhysicalPlanHandoff(input);
  const { mission, sourceSessionId, handoff } = input;
  const provenance = handoff.mcpProvenance!;
  const artifacts = canonicalArtifacts(handoff.artifacts);
  const withoutDigest: Omit<PromotedPlanSnapshot, "digest"> = {
    version: 1,
    handoffId: handoff.id,
    sourceIntentVersion: mission.intentVersion!,
    sourceSessionId,
    ...(handoff.workerIncarnationId
      ? { sourceWorkerIncarnationId: handoff.workerIncarnationId }
      : {}),
    handoffCreatedAt: handoff.createdAt,
    physicalReceipt: {
      receiptId: provenance.receiptId,
      toolCallId: provenance.toolCallId,
      source: provenance.source,
      authoritySha256: provenance.authoritySha256,
      ...(provenance.worktreeHeadSha
        ? { worktreeHeadSha: provenance.worktreeHeadSha }
        : {}),
      issuedAt: provenance.issuedAt,
    },
    summary: handoff.summary,
    artifacts: artifacts.value,
    summarySha256: sha256(handoff.summary),
    artifactsSha256: sha256(artifacts.json),
  };
  return Object.freeze({
    ...withoutDigest,
    physicalReceipt: { ...withoutDigest.physicalReceipt },
    artifacts: [...withoutDigest.artifacts],
    digest: sha256(planDigestInput(withoutDigest)),
  });
}

export function assertPromotedPlanSnapshot(
  raw: PromotedPlanSnapshot,
): PromotedPlanSnapshot {
  const snapshot = promotedPlanSnapshotSchema.parse(raw);
  const artifacts = canonicalArtifacts(snapshot.artifacts);
  const { digest: _digest, ...snapshotWithoutDigest } = snapshot;
  const withoutDigest: Omit<PromotedPlanSnapshot, "digest"> = {
    ...snapshotWithoutDigest,
    artifacts: artifacts.value,
  };
  if (
    snapshot.summarySha256 !== sha256(snapshot.summary) ||
    snapshot.artifactsSha256 !== sha256(artifacts.json) ||
    snapshot.digest !== sha256(planDigestInput(withoutDigest))
  ) {
    throw new Error(
      "promoted_plan_corrupt: o PRD/plano persistido diverge dos digests selados",
    );
  }
  return Object.freeze({
    ...snapshot,
    physicalReceipt: { ...snapshot.physicalReceipt },
    artifacts: [...artifacts.value],
  });
}

/**
 * Select the latest successful handoff from the exact live plan session.
 * Delivery/ACK state is intentionally irrelevant: promotion snapshots the
 * physical MCP payload and never asks the revoked session to redeliver it.
 */
export function selectPhysicalPlanHandoff(input: {
  readonly mission: Mission;
  readonly handoffs: PlanHandoffStore;
}): PromotedPlanSnapshot {
  const sourceSessionId = input.mission.orchestratorSessionId;
  if (!sourceSessionId) {
    throw new Error(
      "plan_handoff_missing: a missão plan não possui sessão física de origem",
    );
  }
  const candidates = input.handoffs
    .list({ missionId: input.mission.id, includeDelivered: true })
    .filter(
      (handoff) =>
        handoff.sessionId === sourceSessionId && handoff.status === "success",
    )
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
    );
  if (candidates.length === 0) {
    throw new Error(
      "plan_handoff_missing: envie o PRD/plano por nexus_handoff_submit antes de executar",
    );
  }
  return snapshotFromPhysicalHandoff({
    mission: input.mission,
    sourceSessionId,
    handoff: candidates[0]!,
  });
}

/**
 * Re-read one already reviewed handoff after plan-v1 was physically stopped.
 * Exact id/session/provenance/digests must still match the in-memory review.
 */
export function revalidatePhysicalPlanHandoff(input: {
  readonly mission: Mission;
  readonly expected: PromotedPlanSnapshot;
  readonly handoffs: PlanHandoffStore;
}): PromotedPlanSnapshot {
  const expected = assertPromotedPlanSnapshot(input.expected);
  if (
    input.mission.intentVersion !== expected.sourceIntentVersion ||
    input.mission.intentContract?.lane !== "plan"
  ) {
    throw new Error(
      "plan_handoff_stale: a revisão plan mudou durante a promoção",
    );
  }
  const handoff = input.handoffs.get(expected.handoffId);
  if (!handoff) {
    throw new Error(
      "plan_handoff_missing: o handoff físico revisado não existe mais",
    );
  }
  const current = snapshotFromPhysicalHandoff({
    mission: input.mission,
    sourceSessionId: expected.sourceSessionId,
    handoff,
  });
  if (current.digest !== expected.digest) {
    throw new Error(
      "plan_handoff_stale: o PRD/plano físico mudou durante a promoção",
    );
  }
  return current;
}
