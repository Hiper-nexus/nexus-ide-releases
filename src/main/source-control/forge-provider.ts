// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: lean interface without
// ORCA hosted-review monolith; external writes require ForgeAuthorization + audit.

export type ForgeProviderId =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea';

export type ForgeWriteKind = 'create-review' | 'update-review' | 'comment' | 'merge';

/** Explicit user/session authorization for any external forge mutation. */
export type ForgeAuthorization = {
  readonly grantedBy: string;
  readonly grantedAt: number;
  readonly scope: readonly ForgeWriteKind[];
  readonly reason: string;
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
  | { readonly ok: false; readonly reason: string };

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
};

const auditLog: ForgeAuditEntry[] = [];
const MAX_AUDIT = 200;

export function recordForgeAudit(entry: Omit<ForgeAuditEntry, 'at'> & { at?: number }): void {
  auditLog.unshift({
    at: entry.at ?? Date.now(),
    provider: entry.provider,
    kind: entry.kind,
    authorized: entry.authorized,
    actor: entry.actor,
    detail: entry.detail,
  });
  if (auditLog.length > MAX_AUDIT) auditLog.length = MAX_AUDIT;
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
): boolean {
  if (!auth.grantedBy || !auth.reason) return false;
  if (!Number.isFinite(auth.grantedAt) || auth.grantedAt <= 0) return false;
  return auth.scope.includes(kind);
}
