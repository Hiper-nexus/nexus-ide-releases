import { createHash } from "node:crypto";
import path from "node:path";
import { TEAM_READ_ONLY_FANOUT_DOMAIN } from "../../shared/mission-topology";
import type { ProjectExecutionScope } from "../../shared/types";
import type { GitRunner } from "./git-command";

export const SHA_PATTERN = /^[a-f0-9]{40,64}$/;
export const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export interface WorktreeOwnership {
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];
}

export type WorktreeStatus =
  "reserved" | "ready" | "queued" | "integrated" | "failed" | "abandoned";

export const ACTIVE_WORKTREE_STATUSES = new Set<WorktreeStatus>([
  "reserved",
  "ready",
  "queued",
]);
export const ALL_WORKTREE_STATUSES = new Set<WorktreeStatus>([
  ...ACTIVE_WORKTREE_STATUSES,
  "integrated",
  "failed",
  "abandoned",
]);

export interface WorktreeRecord {
  readonly id: string;
  readonly scopeKey: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly workerId: string;
  readonly rootRealPath: string;
  readonly worktreePath: string;
  readonly branchRef: string;
  readonly integrationRef: string;
  readonly baseSha: string;
  readonly ownership: WorktreeOwnership;
  readonly dependencies: readonly string[];
  readonly status: WorktreeStatus;
  readonly taskHeadSha?: string;
  readonly integratedSha?: string;
  readonly failureReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorktreeStateSnapshot {
  readonly revision: number;
  readonly records: readonly WorktreeRecord[];
}

/** Implementations must provide durable, process-safe atomic CAS semantics. */
export interface WorktreeStateStore {
  read(scopeKey: string): WorktreeStateSnapshot;
  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean;
}

export interface WorktreeDependencyInput {
  readonly missionId: string;
  readonly taskId: string;
}

export interface CreateWorktreeInput {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly ownership: WorktreeOwnership;
  readonly dependsOn?: readonly WorktreeDependencyInput[];
}

export interface PreparedWorktreeIntegration {
  readonly record: WorktreeRecord;
  readonly taskHeadSha: string;
  readonly changedFiles: readonly string[];
  readonly diffHash: string;
}

/**
 * Physical proof that a validation-capable worktree stayed clean and exactly
 * on the integration HEAD it was created from. This is not a merge candidate:
 * it exists so a green QA pass can be receipted without an empty commit.
 */
export interface PreparedWorktreeNoChangeValidation {
  readonly record: WorktreeRecord;
  readonly taskHeadSha: string;
  readonly integrationHeadSha: string;
  readonly changedFiles: readonly [];
  readonly diffHash: string;
}

export interface IntegrationCheckoutSnapshot {
  readonly rootRealPath: string;
  readonly integrationRef: string;
  readonly headSha: string;
}

export interface IntegrationCheckoutInspection extends IntegrationCheckoutSnapshot {
  readonly clean: boolean;
}

export interface WorktreeManagerOptions {
  readonly runtimeRoot: string;
  readonly stateStore: WorktreeStateStore;
  readonly gitRunner?: GitRunner;
  readonly now?: () => number;
}

/** Human-inspectable identity of the task that already holds the claim. */
export interface OwnershipConflictIdentity {
  readonly missionId: string;
  readonly taskId: string;
}

const MAX_REPORTED_OVERLAP_CLAIMS = 8;

function ownershipOverlapMessage(
  conflictingTaskKey: string,
  overlap: WorktreeOwnership,
  identity?: OwnershipConflictIdentity,
): string {
  // `taskKey` is a digest: naming it alone tells the operator nothing they can
  // look up. Prefer mission/task plus the claims that actually collided.
  const who = identity
    ? `${identity.missionId}/${identity.taskId}`
    : conflictingTaskKey;
  const claims = [
    ...overlap.files,
    ...overlap.symbols.map((symbol) => `symbol:${symbol}`),
    ...overlap.domains.map((domain) => `domain:${domain}`),
  ];
  if (claims.length === 0) {
    return `worktree ownership overlaps active task ${who}`;
  }
  const shown = claims.slice(0, MAX_REPORTED_OVERLAP_CLAIMS).join(", ");
  const rest =
    claims.length > MAX_REPORTED_OVERLAP_CLAIMS
      ? `, +${claims.length - MAX_REPORTED_OVERLAP_CLAIMS}`
      : "";
  return `worktree ownership overlaps active task ${who} (${shown}${rest})`;
}

export class OwnershipOverlapError extends Error {
  readonly conflictingTaskKey: string;
  readonly conflictingMissionId?: string;
  readonly conflictingTaskId?: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];

  constructor(
    conflictingTaskKey: string,
    overlap: WorktreeOwnership,
    identity?: OwnershipConflictIdentity,
  ) {
    super(ownershipOverlapMessage(conflictingTaskKey, overlap, identity));
    this.name = "OwnershipOverlapError";
    this.conflictingTaskKey = conflictingTaskKey;
    this.conflictingMissionId = identity?.missionId;
    this.conflictingTaskId = identity?.taskId;
    this.files = overlap.files;
    this.symbols = overlap.symbols;
    this.domains = overlap.domains;
  }
}

export class OwnershipViolationError extends Error {
  readonly undeclaredFiles: readonly string[];

  constructor(files: readonly string[]) {
    super(`task changed files outside its ownership: ${files.join(", ")}`);
    this.name = "OwnershipViolationError";
    this.undeclaredFiles = Object.freeze([...files]);
  }
}

export class WorktreeWorkerConflictError extends Error {
  constructor() {
    super("mission task worktree is already owned by another worker");
    this.name = "WorktreeWorkerConflictError";
  }
}

export class WorktreeStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeStateConflictError";
  }
}

export function digest(domain: string, ...values: string[]): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(values.join("\0"))
    .digest("hex");
}

export function assertIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export function assertSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function normalizeFileOwnership(value: string): string {
  const raw = assertIdentifier(value, "owned file").replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) {
    throw new Error(`owned file must be repository-relative: ${value}`);
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  ) {
    throw new Error(`owned file escapes repository: ${value}`);
  }
  return normalized;
}

function normalizedList(
  values: readonly string[],
  label: string,
  normalize: (value: string) => string,
): readonly string[] {
  if (!Array.isArray(values) || values.length > 2_048) {
    throw new Error(`invalid ${label} ownership`);
  }
  return Object.freeze([...new Set(values.map(normalize))].sort());
}

export function normalizeOwnership(
  value: WorktreeOwnership,
): WorktreeOwnership {
  if (!value || typeof value !== "object") {
    throw new Error("ownership is required");
  }
  const files = normalizedList(value.files, "file", normalizeFileOwnership);
  const symbols = normalizedList(value.symbols, "symbol", (item) =>
    assertIdentifier(item, "owned symbol"),
  );
  const domains = normalizedList(value.domains, "domain", (item) =>
    assertIdentifier(item, "owned domain").toLocaleLowerCase("en-US"),
  );
  if (files.length + symbols.length + domains.length === 0) {
    throw new Error("at least one ownership claim is required");
  }
  return Object.freeze({ files, symbols, domains });
}

/**
 * Marks the `files` set as a WRITE PERMIT, not an exclusive claim.
 *
 * A planner that cannot narrow a natural-language goal seals a bounded
 * projection of the repository inventory (plus the greenfield scaffold seed)
 * so the merge fence has something to check the diff against. That set is a
 * statement about what the task is ALLOWED to touch — never about what it will
 * touch — and it is byte-identical for every mission on the same checkout.
 * Treating it as exclusive made mission B collide with mission A by
 * arithmetic, so no two missions could ever run at once on one checkout.
 *
 * Consequences, all deliberate:
 * - Coverage files never exclude anyone at reservation time.
 * - Coverage files still bound the merge fence exactly as before
 *   (`enforceOwnershipOnDiff` / the integration permit check).
 * - Symbol claims stay exclusive even under coverage: a symbol claim is
 *   always precise.
 * - A coverage task's REAL diff is checked against every live exclusive claim
 *   at integration, which is the first moment the real write set exists.
 */
export const OWNERSHIP_COVERAGE_DOMAIN = "repository-coverage";

/**
 * Kind/fence labels carried on ownership.domains for scheduler identity — they
 * are not mutual-exclusion claims. File/symbol disjointness decides overlap.
 */
export const OWNERSHIP_NON_CLAIM_DOMAINS = Object.freeze(
  new Set([
    OWNERSHIP_COVERAGE_DOMAIN,
    "guided-advisory",
    "guided-independent-review",
    "guided-isolated-advisory",
    "guided-implementation",
    "guided-quality-gate",
    "guided-reproduction",
    "guided-regression",
    "sequential-only",
    TEAM_READ_ONLY_FANOUT_DOMAIN,
  ]),
);

export function claimOwnershipDomains(
  domains: readonly string[],
): readonly string[] {
  return Object.freeze(
    domains
      .map((domain) => domain.toLocaleLowerCase("en-US"))
      .filter((domain) => !OWNERSHIP_NON_CLAIM_DOMAINS.has(domain)),
  );
}

export function ownershipOverlap(
  left: WorktreeOwnership,
  right: WorktreeOwnership,
): WorktreeOwnership {
  const intersection = (a: readonly string[], b: readonly string[]) => {
    const rightValues = new Set(b);
    return a.filter((value) => rightValues.has(value));
  };
  const overlappingFiles = [
    ...left.files.filter((leftFile) =>
      right.files.some((rightFile) =>
        fileOwnershipClaimsOverlap(leftFile, rightFile),
      ),
    ),
    ...right.files.filter((rightFile) =>
      left.files.some((leftFile) =>
        fileOwnershipClaimsOverlap(leftFile, rightFile),
      ),
    ),
  ];
  return Object.freeze({
    files: Object.freeze([...new Set(overlappingFiles)].sort()),
    symbols: Object.freeze(intersection(left.symbols, right.symbols)),
    domains: Object.freeze(
      intersection(
        claimOwnershipDomains(left.domains),
        claimOwnershipDomains(right.domains),
      ),
    ),
  });
}

export function ownershipIsCoverage(ownership: WorktreeOwnership): boolean {
  return ownership.domains.some(
    (domain) => domain.toLocaleLowerCase("en-US") === OWNERSHIP_COVERAGE_DOMAIN,
  );
}

export interface OwnershipExclusivityContext {
  /**
   * Two records of the SAME mission share one sealed delivery contract, so a
   * coverage permit is that mission's own single write surface and stays fully
   * exclusive — the guided chain must not open a second writer on itself.
   * Across missions the very same set is an unrelated fabrication that every
   * mission on the checkout carries identically, so it excludes nobody.
   */
  readonly sameMission: boolean;
}

/**
 * Overlap restricted to claims that are genuinely mutually exclusive.
 *
 * Identical to `ownershipOverlap` between two precise claims — a directory
 * claim still swallows every nested file claim, in both directions — and
 * identical for any two records of the same mission. The single difference:
 * ACROSS missions, a coverage permit contributes no FILE exclusivity, because
 * a fabricated superset cannot prove a shared writer. Symbols and claim
 * domains are never relaxed: a symbol claim is always precise.
 */
export function exclusiveOwnershipOverlap(
  left: WorktreeOwnership,
  right: WorktreeOwnership,
  context: OwnershipExclusivityContext,
): WorktreeOwnership {
  const full = ownershipOverlap(left, right);
  if (context.sameMission) return full;
  if (!ownershipIsCoverage(left) && !ownershipIsCoverage(right)) return full;
  return Object.freeze({
    files: Object.freeze([]),
    symbols: full.symbols,
    domains: full.domains,
  });
}

/** Directory claims overlap every repository-relative descendant. */
export function fileOwnershipClaimsOverlap(
  left: string,
  right: string,
): boolean {
  const normalizedLeft = left.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRight = right.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalizedLeft === normalizedRight) return true;
  const isDirectoryClaim = (file: string): boolean => {
    const basename = file.split("/").pop() ?? file;
    return !basename.includes(".");
  };
  return (
    (isDirectoryClaim(normalizedLeft) &&
      normalizedRight.startsWith(`${normalizedLeft}/`)) ||
    (isDirectoryClaim(normalizedRight) &&
      normalizedLeft.startsWith(`${normalizedRight}/`))
  );
}

export function hasOwnershipOverlap(value: WorktreeOwnership): boolean {
  return value.files.length + value.symbols.length + value.domains.length > 0;
}

export function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function cloneWorktreeRecord(record: WorktreeRecord): WorktreeRecord {
  return Object.freeze({
    ...record,
    ownership: Object.freeze({
      files: Object.freeze([...record.ownership.files]),
      symbols: Object.freeze([...record.ownership.symbols]),
      domains: Object.freeze([...record.ownership.domains]),
    }),
    dependencies: Object.freeze([...record.dependencies]),
  });
}

export function worktreeTaskKey(missionId: string, taskId: string): string {
  return digest(
    "mission-task",
    assertIdentifier(missionId, "missionId"),
    assertIdentifier(taskId, "taskId"),
  );
}
