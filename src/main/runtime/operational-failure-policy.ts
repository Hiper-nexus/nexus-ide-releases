/**
 * Stable failure taxonomy shared by orchestration and promotion.
 *
 * Unknown provider/process failures are retryable by default. Only errors that
 * prove an authority, CAS, corruption, or conflict boundary has been crossed
 * become terminal. Quality findings are neither: they preserve the candidate
 * worktree so a repair can produce a new commit.
 */
import { hasRetiredRosterRouteMarker } from "../../shared/retired-adapter-policy";
import {
  TERMINAL_OPERATIONAL_FAILURE_MARKER,
} from "../../shared/mission-recovery-policy";

export {
  hasTerminalOperationalFailureMarker,
  TERMINAL_OPERATIONAL_FAILURE_MARKER,
} from "../../shared/mission-recovery-policy";

export type OperationalFailureDisposition =
  | "retryable"
  | "repair"
  | "terminal";

const REPAIR_ERROR_NAMES = new Set(["MergeValidationRejectedError"]);

const TERMINAL_ERROR_NAMES = new Set([
  "AuditLogCorruptionError",
  "MergeAuthorityRevokedError",
  "MergeCasError",
  "MergeConflictError",
  "MergeQueueStateError",
  "MissionSchedulerDispatchAuthorityError",
  "RetiredRosterRouteError",
  "ScopedStoreCorruptionError",
  "WorktreeStateConflictError",
]);

const TERMINAL_AUTHORITY_PATTERNS = [
  /\bauthority (?:was )?revoked\b/iu,
  /\bautoridade (?:foi )?revogada\b/iu,
  /\b(?:authority|autoridade).*\bdiverg/iu,
  /\b(?:authority|autoridade).*\bchanged\b/iu,
  /\bintentVersion obsoleta\b/iu,
  /\bperdeu CAS\b/iu,
];

/**
 * Bootstrap/plan preflights that cannot heal by retrying the same approved
 * revision. The squad hash, roster composition, or receipt proof has already
 * drifted — only a fresh operator approval opens a new recovery lane.
 */
const TERMINAL_PREFLIGHT_PATTERNS = [
  /\bguided_plan_squad_stale\b/iu,
  /\bguided_plan_squad_missing\b/iu,
  /\bguided_plan_mixed_topology_blocked\b/iu,
  /\bguided_plan_legacy_receipt_blocked\b/iu,
  /\bguided_plan_executor_missing\b/iu,
  /\bguided_plan_reviewer_missing\b/iu,
  /\bguided_plan_unborn_with_files\b/iu,
  /\bsquad salvo mudou depois da aprovação\b/iu,
];

function errorName(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error)) return "";
  return String((error as { readonly name?: unknown }).name ?? "");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "";
  }
}

export function classifyOperationalFailure(
  error: unknown,
): OperationalFailureDisposition {
  if (hasRetiredRosterRouteMarker(error)) return "terminal";
  const name = errorName(error);
  if (REPAIR_ERROR_NAMES.has(name)) return "repair";
  if (TERMINAL_ERROR_NAMES.has(name)) return "terminal";
  const message = errorMessage(error);
  if (TERMINAL_AUTHORITY_PATTERNS.some((pattern) => pattern.test(message))) {
    return "terminal";
  }
  if (TERMINAL_PREFLIGHT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "terminal";
  }
  return "retryable";
}

export function isRetryableOperationalFailure(error: unknown): boolean {
  return classifyOperationalFailure(error) === "retryable";
}

export function terminalOperationalFailureReason(reason: string): string {
  const detail = reason.trim();
  return `${TERMINAL_OPERATIONAL_FAILURE_MARKER} ${
    detail || "terminal operational authority failure"
  }`;
}
