export type ContextSourceType =
  | 'file'
  | 'git'
  | 'test'
  | 'schema'
  | 'connector'
  | 'decision';

export interface ContextSourceRef {
  readonly type: ContextSourceType;
  readonly locator: string;
  readonly lines?: readonly [number, number];
}

export type ContextFactKind =
  | 'asserted'
  | 'observed'
  | 'inferred'
  | 'deprecated'
  | 'conflict';

export type ContextFactCategory =
  | 'glossary'
  | 'invariant'
  | 'decision'
  | 'domain'
  | 'architecture'
  | 'regression'
  | 'test';

export type JsonScalar = string | number | boolean | null;
export type ContextClaimValue = JsonScalar | readonly JsonScalar[];

export interface ContextFact {
  readonly id: string;
  readonly projectId: string;
  readonly statement: string;
  /** Stable semantic slot used for deterministic contradiction checks. */
  readonly claimKey: string;
  readonly value: ContextClaimValue;
  readonly kind: ContextFactKind;
  readonly category: ContextFactCategory;
  readonly source: ContextSourceRef;
  readonly sourceHash: string;
  readonly commitSha?: string;
  readonly domains: readonly string[];
  readonly relatedSymbols: readonly string[];
  readonly confidence: number;
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly supersedes?: readonly string[];
}

export interface ContextCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly producerId: string;
  readonly statement: string;
  readonly source: ContextSourceRef;
  readonly sourceHash: string;
  readonly authorityRank: number;
  readonly domains: readonly string[];
  readonly status: 'candidate';
}

export interface ContextDiagnostic {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly source?: ContextSourceRef;
  readonly message: string;
}

export interface ProjectContextCorpus {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextRevision: string;
  readonly candidates: readonly ContextCandidate[];
  readonly facts: readonly ContextFact[];
  readonly diagnostics: readonly ContextDiagnostic[];
}

export type ContextConflictKind =
  | 'missing-source'
  | 'contradiction'
  | 'stale-reference'
  | 'unsafe-inference';

export interface ContextConflict {
  readonly id: string;
  readonly kind: ContextConflictKind;
  readonly severity: 'blocking' | 'warning';
  readonly claims: readonly string[];
  readonly sources: readonly ContextSourceRef[];
  readonly affectedDomains: readonly string[];
}
