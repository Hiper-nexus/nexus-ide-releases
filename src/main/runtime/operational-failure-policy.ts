/**
 * Stable failure taxonomy shared by orchestration and promotion.
 *
 * Unknown provider/process failures are retryable by default. Only errors that
 * prove an authority, CAS, corruption, or conflict boundary has been crossed
 * become terminal. Quality findings are neither: they preserve the candidate
 * worktree so a repair can produce a new commit.
 */
import { hasRetiredRosterRouteMarker } from "../../shared/retired-adapter-policy";

export type OperationalFailureDisposition =
  | "retryable"
  | "repair"
  | "terminal";

export const TERMINAL_OPERATIONAL_FAILURE_MARKER =
  "[NEXUS_FAILURE:terminal]";

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
  return TERMINAL_AUTHORITY_PATTERNS.some((pattern) => pattern.test(message))
    ? "terminal"
    : "retryable";
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

export function hasTerminalOperationalFailureMarker(
  value: string,
): boolean {
  return value.includes(TERMINAL_OPERATIONAL_FAILURE_MARKER);
}
