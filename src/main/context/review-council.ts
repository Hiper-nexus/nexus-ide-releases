import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { MissionRisk } from './contract-compiler';
import { canonicalJson } from './canonical-json';

const COMMIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HASH_256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface ReviewBinding {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string;
  readonly contractHash: string;
  readonly contextHash: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
}

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewCategory =
  | 'correctness'
  | 'business'
  | 'security'
  | 'data'
  | 'performance'
  | 'ux';
export type ReviewFindingStatus = 'open' | 'resolved' | 'accepted-risk';

export interface ReviewFindingInput {
  readonly severity: ReviewSeverity;
  readonly category: ReviewCategory;
  readonly file: string;
  readonly line?: number;
  readonly criterionRefs: readonly string[];
  readonly invariantRefs: readonly string[];
  readonly evidence: string;
  readonly recommendation: string;
}

export interface ReviewFinding extends ReviewFindingInput {
  readonly fingerprint: string;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly reviewerProvider: string;
  readonly status: ReviewFindingStatus;
  readonly diffHash: string;
  readonly resolutionEvidenceIds?: readonly string[];
  readonly acceptedRisk?: {
    readonly actorId: string;
    readonly reason: string;
  };
}

export interface ReviewSubmission {
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly reviewerSessionId: string;
  readonly reviewerProvider: string;
  readonly authorId: string;
  readonly authorSessionId: string;
  readonly authorProvider: string;
  readonly binding: ReviewBinding;
  readonly findings: readonly ReviewFindingInput[];
}

export interface ReviewReport extends Omit<ReviewSubmission, 'findings'> {
  readonly findings: readonly ReviewFinding[];
}

export interface ReviewGateResult {
  readonly ready: boolean;
  readonly reason:
    | 'ready'
    | 'review-quorum-missing'
    | 'blocking-findings'
    | 'adjudication-required';
  readonly blockingFindingCount: number;
  readonly reportCount: number;
}

const bindingSchema = z
  .object({
    projectId: z.string().regex(IDENTIFIER),
    checkoutId: z.string().regex(IDENTIFIER),
    missionId: z.string().regex(IDENTIFIER),
    contractHash: z.string().regex(HASH_256),
    contextHash: z.string().regex(HASH_256),
    baseSha: z.string().regex(COMMIT_HASH),
    headSha: z.string().regex(COMMIT_HASH),
    diffHash: z.string().regex(HASH_256),
  })
  .strict();

const safeRelativeFile = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.split(/[\\/]/).includes('..') &&
      !/[\0\r\n]/.test(value),
    'finding file must be a safe relative path',
  );

const findingInputSchema = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.enum([
      'correctness',
      'business',
      'security',
      'data',
      'performance',
      'ux',
    ]),
    file: safeRelativeFile,
    line: z.number().int().positive().max(100_000_000).optional(),
    criterionRefs: z.array(z.string().regex(IDENTIFIER)).max(256),
    invariantRefs: z.array(z.string().regex(IDENTIFIER)).max(256),
    evidence: z.string().trim().min(1).max(65_536),
    recommendation: z.string().trim().min(1).max(65_536),
  })
  .strict();

const submissionSchema = z
  .object({
    reviewId: z.string().regex(IDENTIFIER),
    reviewerId: z.string().regex(IDENTIFIER),
    reviewerSessionId: z.string().regex(IDENTIFIER),
    reviewerProvider: z.string().regex(IDENTIFIER),
    authorId: z.string().regex(IDENTIFIER),
    authorSessionId: z.string().regex(IDENTIFIER),
    authorProvider: z.string().regex(IDENTIFIER),
    binding: bindingSchema,
    findings: z.array(findingInputSchema).max(4_096),
  })
  .strict();

const storedFindingSchema = findingInputSchema
  .extend({
    fingerprint: z.string().regex(HASH_256),
    reviewId: z.string().regex(IDENTIFIER),
    reviewerId: z.string().regex(IDENTIFIER),
    reviewerProvider: z.string().regex(IDENTIFIER),
    status: z.enum(['open', 'resolved', 'accepted-risk']),
    diffHash: z.string().regex(HASH_256),
    resolutionEvidenceIds: z.array(z.string().regex(IDENTIFIER)).max(256).optional(),
    acceptedRisk: z
      .object({
        actorId: z.string().regex(IDENTIFIER),
        reason: z.string().trim().min(8).max(4_096),
      })
      .strict()
      .optional(),
  })
  .strict();

const storedReportSchema = submissionSchema
  .omit({ findings: true })
  .extend({ findings: z.array(storedFindingSchema).max(4_096) })
  .strict();

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameBinding(left: ReviewBinding, right: ReviewBinding): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function freezeBinding(binding: ReviewBinding): ReviewBinding {
  return Object.freeze({ ...binding });
}

function fingerprintFinding(finding: ReviewFindingInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        category: finding.category,
        file: finding.file,
        line: finding.line ?? null,
        criterionRefs: sortedUnique(finding.criterionRefs),
        invariantRefs: sortedUnique(finding.invariantRefs),
        evidence: finding.evidence.trim(),
      }),
    )
    .digest('hex');
}

function cloneFinding(finding: ReviewFinding): ReviewFinding {
  return Object.freeze({
    ...finding,
    criterionRefs: Object.freeze([...finding.criterionRefs]),
    invariantRefs: Object.freeze([...finding.invariantRefs]),
    resolutionEvidenceIds: finding.resolutionEvidenceIds
      ? Object.freeze([...finding.resolutionEvidenceIds])
      : undefined,
    acceptedRisk: finding.acceptedRisk
      ? Object.freeze({ ...finding.acceptedRisk })
      : undefined,
  });
}

function cloneReport(report: ReviewReport, findings: readonly ReviewFinding[]): ReviewReport {
  return Object.freeze({
    ...report,
    binding: freezeBinding(report.binding),
    findings: Object.freeze(findings.map(cloneFinding)),
  });
}

export function parseReviewReport(raw: unknown): ReviewReport {
  const parsed = storedReportSchema.parse(raw);
  for (const finding of parsed.findings) {
    if (
      finding.fingerprint !== fingerprintFinding(finding) ||
      finding.reviewId !== parsed.reviewId ||
      finding.reviewerId !== parsed.reviewerId ||
      finding.reviewerProvider !== parsed.reviewerProvider ||
      finding.diffHash !== parsed.binding.diffHash
    ) {
      throw new Error('persisted review finding binding mismatch');
    }
    if (finding.status === 'resolved' && !finding.resolutionEvidenceIds?.length) {
      throw new Error('resolved review finding has no evidence');
    }
    if (finding.status === 'accepted-risk' && !finding.acceptedRisk) {
      throw new Error('accepted review risk has no authority record');
    }
  }
  return cloneReport(parsed, parsed.findings);
}

export function reviewSubmissionFromReport(report: ReviewReport): ReviewSubmission {
  const parsed = parseReviewReport(report);
  return Object.freeze({
    reviewId: parsed.reviewId,
    reviewerId: parsed.reviewerId,
    reviewerSessionId: parsed.reviewerSessionId,
    reviewerProvider: parsed.reviewerProvider,
    authorId: parsed.authorId,
    authorSessionId: parsed.authorSessionId,
    authorProvider: parsed.authorProvider,
    binding: freezeBinding(parsed.binding),
    findings: Object.freeze(parsed.findings.map((finding) => Object.freeze({
      severity: finding.severity,
      category: finding.category,
      file: finding.file,
      line: finding.line,
      criterionRefs: Object.freeze([...finding.criterionRefs]),
      invariantRefs: Object.freeze([...finding.invariantRefs]),
      evidence: finding.evidence,
      recommendation: finding.recommendation,
    }))),
  });
}

const issuedCapabilities = new WeakSet<object>();

export class AdministrativeRiskAcceptance {
  readonly actorId: string;
  readonly missionId: string;
  readonly expiresAt: number;

  constructor(input: { actorId: string; missionId: string; expiresAt: number }) {
    this.actorId = input.actorId;
    this.missionId = input.missionId;
    this.expiresAt = input.expiresAt;
  }
}

/** Main-process UI/auth boundary only; this object cannot cross JSON/MCP. */
export function issueAdministrativeRiskAcceptance(input: {
  actorId: string;
  missionId: string;
  expiresAt: number;
}): AdministrativeRiskAcceptance {
  if (!IDENTIFIER.test(input.actorId) || !IDENTIFIER.test(input.missionId)) {
    throw new Error('invalid administrative risk capability identity');
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    throw new Error('administrative risk capability expiry is invalid');
  }
  const capability = Object.freeze(new AdministrativeRiskAcceptance(input));
  issuedCapabilities.add(capability);
  return capability;
}

export class ReviewCouncil {
  readonly risk: MissionRisk;
  readonly binding: ReviewBinding;
  readonly #reports = new Map<string, ReviewReport>();
  readonly #findingState = new Map<string, ReviewFinding>();

  constructor(risk: MissionRisk, binding: ReviewBinding) {
    this.risk = risk;
    this.binding = freezeBinding(bindingSchema.parse(binding));
  }

  submit(rawSubmission: ReviewSubmission): ReviewReport {
    const submission = submissionSchema.parse(rawSubmission);
    if (!sameBinding(this.binding, submission.binding)) {
      throw new Error('review binding does not match the current diff and contract');
    }
    if (
      submission.reviewerId === submission.authorId ||
      submission.reviewerSessionId === submission.authorSessionId
    ) {
      throw new Error('author cannot review their own change or session');
    }
    if (
      (this.risk === 'high' || this.risk === 'critical') &&
      submission.reviewerProvider === submission.authorProvider
    ) {
      throw new Error('high-risk review requires a different provider');
    }
    if (this.#reports.has(submission.reviewId)) {
      throw new Error(`duplicate review id: ${submission.reviewId}`);
    }
    if (
      [...this.#reports.values()].some(
        (report) =>
          report.reviewerId === submission.reviewerId ||
          report.reviewerSessionId === submission.reviewerSessionId,
      )
    ) {
      throw new Error('review quorum requires independent reviewer sessions');
    }

    const findings = submission.findings.map((rawFinding): ReviewFinding => {
      const finding: ReviewFindingInput = {
        ...rawFinding,
        criterionRefs: sortedUnique(rawFinding.criterionRefs),
        invariantRefs: sortedUnique(rawFinding.invariantRefs),
      };
      const fingerprint = fingerprintFinding(finding);
      const previous = this.#findingState.get(fingerprint);
      const value = cloneFinding({
        ...finding,
        fingerprint,
        reviewId: submission.reviewId,
        reviewerId: submission.reviewerId,
        reviewerProvider: submission.reviewerProvider,
        status: previous?.status ?? 'open',
        diffHash: submission.binding.diffHash,
        resolutionEvidenceIds: previous?.resolutionEvidenceIds,
        acceptedRisk: previous?.acceptedRisk,
      });
      this.#findingState.set(fingerprint, value);
      return value;
    });
    const report = cloneReport(
      {
        ...submission,
        binding: freezeBinding(submission.binding),
        findings,
      },
      findings,
    );
    this.#reports.set(report.reviewId, report);
    return cloneReport(report, findings);
  }

  listReports(): readonly ReviewReport[] {
    return Object.freeze(
      [...this.#reports.values()]
        .sort((left, right) => left.reviewId.localeCompare(right.reviewId))
        .map((report) =>
          cloneReport(
            report,
            report.findings.map(
              (finding) => this.#findingState.get(finding.fingerprint) ?? finding,
            ),
          ),
        ),
    );
  }

  resolveFinding(
    fingerprint: string,
    input: {
      readonly resolutionEvidenceIds: readonly string[];
      readonly currentDiffHash: string;
    },
  ): ReviewFinding {
    const finding = this.#findingState.get(fingerprint);
    if (!finding) throw new Error(`unknown review finding: ${fingerprint}`);
    if (input.currentDiffHash !== this.binding.diffHash) {
      throw new Error('finding resolution belongs to a different diff');
    }
    const evidenceIds = sortedUnique(input.resolutionEvidenceIds);
    if (evidenceIds.length === 0 || evidenceIds.some((id) => !IDENTIFIER.test(id))) {
      throw new Error('finding resolution requires trusted evidence IDs');
    }
    const resolved = cloneFinding({
      ...finding,
      status: 'resolved',
      resolutionEvidenceIds: evidenceIds,
      acceptedRisk: undefined,
    });
    this.#findingState.set(fingerprint, resolved);
    return cloneFinding(resolved);
  }

  acceptRisk(
    fingerprint: string,
    capability: AdministrativeRiskAcceptance,
    reason: string,
  ): ReviewFinding {
    if (
      !capability ||
      !issuedCapabilities.has(capability) ||
      capability.missionId !== this.binding.missionId ||
      capability.expiresAt <= Date.now()
    ) {
      throw new Error('valid administrative capability is required to accept risk');
    }
    if (reason.trim().length < 8 || reason.length > 4_096) {
      throw new Error('accepted risk requires an explicit reason');
    }
    const finding = this.#findingState.get(fingerprint);
    if (!finding) throw new Error(`unknown review finding: ${fingerprint}`);
    const accepted = cloneFinding({
      ...finding,
      status: 'accepted-risk',
      acceptedRisk: {
        actorId: capability.actorId,
        reason: reason.trim(),
      },
    });
    this.#findingState.set(fingerprint, accepted);
    return cloneFinding(accepted);
  }

  evaluate(): ReviewGateResult {
    const minimumReports = this.risk === 'critical' ? 2 : 1;
    const reports = this.listReports();
    if (reports.length < minimumReports) {
      return Object.freeze({
        ready: false,
        reason: 'review-quorum-missing',
        blockingFindingCount: 0,
        reportCount: reports.length,
      });
    }
    const findings = [...this.#findingState.values()];
    const blockers = findings.filter(
      (finding) =>
        finding.status === 'open' &&
        (finding.severity === 'critical' || finding.severity === 'high'),
    );
    if (blockers.length > 0) {
      return Object.freeze({
        ready: false,
        reason: 'blocking-findings',
        blockingFindingCount: blockers.length,
        reportCount: reports.length,
      });
    }
    const reportFindingSets = reports.map(
      (report) => new Set(report.findings.map((finding) => finding.fingerprint)),
    );
    const hasNonBlockingDivergence =
      reports.length > 1 &&
      findings.some(
        (finding) =>
          finding.status === 'open' &&
          reportFindingSets.some((set) => set.has(finding.fingerprint)) &&
          reportFindingSets.some((set) => !set.has(finding.fingerprint)),
      );
    if (hasNonBlockingDivergence) {
      return Object.freeze({
        ready: false,
        reason: 'adjudication-required',
        blockingFindingCount: 0,
        reportCount: reports.length,
      });
    }
    return Object.freeze({
      ready: true,
      reason: 'ready',
      blockingFindingCount: 0,
      reportCount: reports.length,
    });
  }

  forChangedDiff(binding: ReviewBinding): ReviewCouncil {
    const parsed = bindingSchema.parse(binding);
    if (parsed.diffHash === this.binding.diffHash) {
      throw new Error('changed-diff invalidation requires a new diff hash');
    }
    return new ReviewCouncil(this.risk, parsed);
  }
}
