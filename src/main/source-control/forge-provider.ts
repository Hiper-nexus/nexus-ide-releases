// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: lean interface without
// ORCA hosted-review monolith; external writes require ForgeAuthorization + audit;
// failure results may carry a typed provider apiError (GitHub: GitHubApiError).

import type { GitHubApiError } from '../../vendor/emdash/github/github-api-errors';

export type ForgeProviderId =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea';

export type ForgeWriteKind =
  | 'create-review'
  | 'update-review'
  | 'comment'
  | 'merge'
  | 'enqueue-merge-queue'
  | 'auto-merge';

/** Explicit user/session authorization for any external forge mutation. */
export type ForgeAuthorization = {
  readonly grantedBy: string;
  readonly grantedAt: number;
  readonly scope: readonly ForgeWriteKind[];
  readonly reason: string;
  /**
   * Optional expiry (epoch ms). When set, the grant is rejected once `now`
   * passes it, so a stale authorization cannot mutate a forge indefinitely.
   */
  readonly expiresAt?: number;
};

export type ForgeAuditEntry = {
  readonly at: number;
  readonly provider: ForgeProviderId;
  readonly kind: ForgeWriteKind;
  readonly authorized: boolean;
  readonly actor: string;
  readonly detail: string;
};

export type ForgeRepositoryRef = {
  readonly owner: string;
  readonly name: string;
  readonly host: string;
};

export type ForgeCreateReviewInput = {
  readonly title: string;
  readonly body: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft?: boolean;
};

export type ForgeCreateReviewResult =
  | { readonly ok: true; readonly url: string; readonly number: number }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Typed provider failure detail (set by the GitHub provider). */
      readonly apiError?: GitHubApiError;
    };

/** Read-side review summary (PR/MR) for a branch. */
export type ForgeReviewInfo = {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
};

export type ForgeGetReviewForBranchResult =
  | { readonly ok: true; readonly review: ForgeReviewInfo }
  | { readonly ok: true; readonly review: null }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Typed provider failure detail (set by the GitHub provider). */
      readonly apiError?: GitHubApiError;
    };

/** GitHub merge-queue / auto-merge snapshot (Orca hosted-review parity). */
export type ForgePRInspect = {
  readonly number: number;
  readonly nodeId?: string;
  readonly url: string;
  readonly title: string;
  readonly state: 'open' | 'closed' | 'merged' | 'draft';
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headSha?: string;
  readonly mergeable?: string;
  readonly mergeStateStatus?: string | null;
  readonly reviewDecision?: string | null;
  readonly autoMergeEnabled: boolean;
  readonly autoMergeAllowed: boolean | null;
  readonly mergeQueueRequired: boolean | null;
  readonly stacked: boolean;
};

export type ForgeInspectReviewResult =
  | { readonly ok: true; readonly review: ForgePRInspect }
  | { readonly ok: true; readonly review: null }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly apiError?: GitHubApiError;
    };

export type ForgeEnqueueMode = 'when-ready' | 'now';

export type ForgeEnqueueInput = {
  readonly number: number;
  readonly mode?: ForgeEnqueueMode;
  readonly mergeMethod?: 'squash' | 'merge' | 'rebase';
};

export type ForgeEnqueueResult =
  | { readonly ok: true; readonly action: 'enqueued' | 'when-ready' | 'stack' }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly apiError?: GitHubApiError;
    };

export type ForgeAutoMergeInput = {
  readonly number: number;
  readonly enabled: boolean;
  readonly mergeMethod?: 'squash' | 'merge' | 'rebase';
};

export type ForgeProvider = {
  readonly id: ForgeProviderId;
  readonly supportsReviewCreation: boolean;
  /** Feature flag: non-default forges stay disabled until product enables them. */
  readonly enabled: boolean;
  createReview(
    repo: ForgeRepositoryRef,
    input: ForgeCreateReviewInput,
    auth: ForgeAuthorization,
  ): Promise<ForgeCreateReviewResult>;
  /**
   * Read PR/MR for branch. Optional on stubs; GH/GL implement with mockable HTTP.
   * Reads do not require ForgeAuthorization (write scope); may be audited optionally.
   */
  getReviewForBranch?(
    repo: ForgeRepositoryRef,
    branch: string,
  ): Promise<ForgeGetReviewForBranchResult>;
  /** Rich PR + merge-queue metadata. GitHub only; other forges omit. */
  inspectReview?(
    repo: ForgeRepositoryRef,
    prNumber: number,
  ): Promise<ForgeInspectReviewResult>;
  enqueueMergeQueue?(
    repo: ForgeRepositoryRef,
    input: ForgeEnqueueInput,
    auth: ForgeAuthorization,
  ): Promise<ForgeEnqueueResult>;
  setAutoMerge?(
    repo: ForgeRepositoryRef,
    input: ForgeAutoMergeInput,
    auth: ForgeAuthorization,
  ): Promise<ForgeEnqueueResult>;
};

const auditLog: ForgeAuditEntry[] = [];
const MAX_AUDIT = 200;

/**
 * Durable sink for the external-write audit trail. The in-memory ring below is
 * only a recent-view cache and is lost on restart; when the forge subsystem is
 * wired, the caller MUST register a persistent sink so external mutations stay
 * auditable across sessions. Left null by default (unit/latent path).
 */
let auditSink: ((entry: ForgeAuditEntry) => void) | null = null;

export function setForgeAuditSink(sink: ((entry: ForgeAuditEntry) => void) | null): void {
  auditSink = sink;
}

export function recordForgeAudit(entry: Omit<ForgeAuditEntry, 'at'> & { at?: number }): void {
  const full: ForgeAuditEntry = {
    at: entry.at ?? Date.now(),
    provider: entry.provider,
    kind: entry.kind,
    authorized: entry.authorized,
    actor: entry.actor,
    detail: entry.detail,
  };
  auditLog.unshift(full);
  if (auditLog.length > MAX_AUDIT) auditLog.length = MAX_AUDIT;
  if (auditSink) {
    try {
      auditSink(full);
    } catch {
      // A failing durable sink must not break the mutation path; the in-memory
      // ring still holds the entry for the recent-view.
    }
  }
}

export function getForgeAuditLog(): readonly ForgeAuditEntry[] {
  return auditLog;
}

export function clearForgeAuditLog(): void {
  auditLog.length = 0;
}

export function assertForgeWriteAuthorized(
  auth: ForgeAuthorization,
  kind: ForgeWriteKind,
  now: number = Date.now(),
): boolean {
  if (!auth.grantedBy || !auth.reason) return false;
  if (!Number.isFinite(auth.grantedAt) || auth.grantedAt <= 0) return false;
  if (auth.expiresAt !== undefined && (!Number.isFinite(auth.expiresAt) || now > auth.expiresAt)) {
    return false;
  }
  return auth.scope.includes(kind);
}
