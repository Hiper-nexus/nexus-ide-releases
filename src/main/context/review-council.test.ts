import { describe, expect, it } from 'vitest';
import {
  ReviewCouncil,
  issueAdministrativeRiskAcceptance,
  type ReviewBinding,
} from './review-council';

const binding: ReviewBinding = {
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  missionId: 'mission-a',
  contractHash: 'c'.repeat(64),
  contextHash: 'e'.repeat(64),
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  diffHash: 'd'.repeat(64),
};

function review(overrides: Record<string, unknown> = {}) {
  return {
    reviewId: 'review-a',
    reviewerId: 'reviewer-a',
    reviewerSessionId: 'session-review-a',
    reviewerProvider: 'claude',
    authorId: 'author-a',
    authorSessionId: 'session-author-a',
    authorProvider: 'codex',
    binding,
    findings: [
      {
        severity: 'high' as const,
        category: 'business' as const,
        file: 'src/auth/session.ts',
        line: 42,
        criterionRefs: ['ac-session'],
        invariantRefs: ['inv-session'],
        evidence: 'The expiry branch bypasses tenant policy.',
        recommendation: 'Apply tenant policy before issuing the token.',
      },
    ],
    ...overrides,
  };
}

describe('ReviewCouncil', () => {
  it('rejects author/session aliases and replay while allowing a shared provider', () => {
    const council = new ReviewCouncil('high', binding);
    expect(() =>
      council.submit(
        review({ reviewerId: 'author-a' }) as ReturnType<typeof review>,
      ),
    ).toThrow(/author.*review/i);
    expect(() =>
      council.submit(
        review({
          reviewerId: 'reviewer-alias',
          reviewerSessionId: 'session-author-a',
        }) as ReturnType<typeof review>,
      ),
    ).toThrow(/author.*review/i);

    const report = council.submit(
      review({ reviewerProvider: 'codex' }) as ReturnType<typeof review>,
    );
    expect(report.reviewerProvider).toBe('codex');
    expect(() =>
      council.submit(
        review({
          reviewId: 'review-replay',
          reviewerId: 'reviewer-replay',
          reviewerSessionId: 'session-review-a',
          reviewerProvider: 'codex',
        }) as ReturnType<typeof review>,
      ),
    ).toThrow(/independent reviewer sessions/i);
  });

  it('computes finding fingerprints itself and blocks critical/high', () => {
    const council = new ReviewCouncil('high', binding);
    const report = council.submit(review());
    expect(report.findings[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(council.evaluate()).toMatchObject({
      ready: false,
      reason: 'blocking-findings',
      blockingFindingCount: 1,
    });

    council.resolveFinding(report.findings[0].fingerprint, {
      resolutionEvidenceIds: ['evidence-fix-a'],
      currentDiffHash: binding.diffHash,
    });
    expect(council.evaluate()).toMatchObject({ ready: true, reason: 'ready' });
  });

  it('invalidates all reports and resolutions when the diff changes', () => {
    const council = new ReviewCouncil('high', binding);
    const report = council.submit(review());
    council.resolveFinding(report.findings[0].fingerprint, {
      resolutionEvidenceIds: ['evidence-fix-a'],
      currentDiffHash: binding.diffHash,
    });

    const next = council.forChangedDiff({
      ...binding,
      headSha: 'e'.repeat(40),
      diffHash: 'f'.repeat(64),
    });
    expect(next.evaluate()).toMatchObject({
      ready: false,
      reason: 'review-quorum-missing',
    });
    expect(next.listReports()).toHaveLength(0);
  });

  it('requires two independent reviewers and adjudication for critical divergence', () => {
    const council = new ReviewCouncil('critical', binding);
    council.submit(
      review({
        reviewId: 'review-a',
        reviewerProvider: 'codex',
        findings: [],
      }),
    );
    expect(council.evaluate().reason).toBe('review-quorum-missing');
    council.submit(
      review({
        reviewId: 'review-b',
        reviewerId: 'reviewer-b',
        reviewerSessionId: 'session-review-b',
        reviewerProvider: 'codex',
      }),
    );
    expect(council.evaluate()).toMatchObject({
      ready: false,
      reason: 'blocking-findings',
    });
  });

  it('lets static analysis block without allowing it to satisfy reviewer quorum', () => {
    const advisoryCouncil = new ReviewCouncil('high', binding);
    advisoryCouncil.submit(
      review({
        reviewId: 'static-advisory',
        reviewerId: 'nexus-static-a',
        reviewerSessionId: 'nexus-static-session-a',
        reviewerProvider: 'nexus-static-analysis-v1',
        findings: [
          {
            severity: 'medium',
            category: 'correctness',
            file: 'src/api.ts',
            criterionRefs: [],
            invariantRefs: ['single-source-of-truth'],
            evidence: 'Similar exported API was detected.',
            recommendation: 'Verify whether both APIs are required.',
          },
        ],
      }),
    );
    expect(advisoryCouncil.evaluate()).toMatchObject({
      ready: false,
      reason: 'review-quorum-missing',
      reportCount: 0,
    });
    advisoryCouncil.submit(
      review({
        reviewId: 'physical-review',
        reviewerId: 'reviewer-physical',
        reviewerSessionId: 'session-review-physical',
        findings: [],
      }),
    );
    expect(advisoryCouncil.evaluate()).toMatchObject({
      ready: true,
      reason: 'ready',
      reportCount: 1,
    });

    const blockerCouncil = new ReviewCouncil('high', binding);
    blockerCouncil.submit(
      review({
        reviewId: 'static-blocker',
        reviewerId: 'nexus-static-b',
        reviewerSessionId: 'nexus-static-session-b',
        reviewerProvider: 'nexus-static-analysis-v1',
      }),
    );
    expect(blockerCouncil.evaluate()).toMatchObject({
      ready: false,
      reason: 'blocking-findings',
      blockingFindingCount: 1,
      reportCount: 0,
    });
  });

  it('accepts risk only through a non-serializable administrative capability', () => {
    const council = new ReviewCouncil('high', binding);
    const report = council.submit(review());
    expect(() =>
      council.acceptRisk(
        report.findings[0].fingerprint,
        {} as never,
        'business owner approved',
      ),
    ).toThrow(/administrative capability/i);

    const capability = issueAdministrativeRiskAcceptance({
      actorId: 'admin-a',
      missionId: binding.missionId,
      expiresAt: Date.now() + 60_000,
    });
    council.acceptRisk(
      report.findings[0].fingerprint,
      capability,
      'business owner approved',
    );
    expect(council.evaluate()).toMatchObject({ ready: true });
  });
});
