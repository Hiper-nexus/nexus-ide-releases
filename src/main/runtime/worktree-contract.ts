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

export class OwnershipOverlapError extends Error {
  readonly conflictingTaskKey: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];

  constructor(conflictingTaskKey: string, overlap: WorktreeOwnership) {
    super(`worktree ownership overlaps active task ${conflictingTaskKey}`);
    this.name = "OwnershipOverlapError";
    this.conflictingTaskKey = conflictingTaskKey;
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
 * Kind/fence labels carried on ownership.domains for scheduler identity — they
 * are not mutual-exclusion claims. File/symbol disjointness decides overlap.
 */
export const OWNERSHIP_NON_CLAIM_DOMAINS = Object.freeze(
  new Set([
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
