import { randomUUID } from 'node:crypto';
import type { MissionRisk } from './contract-compiler';
import type { CandidateQualityAnalysis } from './candidate-quality-scanner';
import {
  CANDIDATE_REVIEW_EVALUATOR_VERSION,
  ReviewCouncil,
  type ReviewBinding,
  type ReviewReport,
} from './review-council';
import type { WorkflowActorIdentity } from './context-workflow-store';

export const CANDIDATE_QUALITY_REVIEW_PROVIDER =
  'nexus-static-analysis-v1';

export function createCandidateQualityReviewReport(input: {
  readonly risk: MissionRisk;
  readonly binding: ReviewBinding;
  readonly author: WorkflowActorIdentity;
  readonly analysis: CandidateQualityAnalysis;
  readonly makeId?: () => string;
}): ReviewReport {
  const nonce = (input.makeId?.() ?? randomUUID())
    .replace(/[^A-Za-z0-9._:-]/gu, '')
    .slice(0, 96);
  if (!nonce) throw new Error('candidate quality review identity is empty');
  const status = input.analysis.complete ? 'complete' : 'partial';
  const council = new ReviewCouncil(input.risk, input.binding);
  return council.submit({
    reviewId:
      `candidate-quality-${status}-${input.analysis.analysisHash}-${nonce}`,
    reviewerId: `nexus-candidate-quality-${nonce}`,
    reviewerSessionId: `nexus-candidate-quality-session-${nonce}`,
    reviewerProvider: CANDIDATE_QUALITY_REVIEW_PROVIDER,
    authorId: input.author.id,
    authorSessionId: input.author.sessionId,
    authorProvider: input.author.provider,
    binding: input.binding,
    reviewPurpose: 'candidate',
    evaluatorVersion: CANDIDATE_REVIEW_EVALUATOR_VERSION,
    findings: input.analysis.findings,
  });
}
