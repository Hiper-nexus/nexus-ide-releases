import type {
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewLookupOutcome,
} from '../../../../shared/hosted-review';

export type ChecksPanelReviewLookup =
  | 'unknown'
  | 'not_found'
  | 'positive_unresolved'
  | 'found';

export function isChecksPanelCreateEligibilityConfirmable(input: {
  eligibility: Pick<
    HostedReviewCreationEligibility,
    'canCreate' | 'blockedReason' | 'reviewLookupOutcome'
  > | null;
  reviewLookup: ChecksPanelReviewLookup;
  hasHardRefreshError: boolean;
}): boolean {
  const eligibility = input.eligibility;
  if (!eligibility || eligibility.blockedReason === 'existing_review') {
    return false;
  }
  if (input.reviewLookup === 'positive_unresolved' || input.hasHardRefreshError) {
    return false;
  }
  if (eligibility.reviewLookupOutcome === 'unavailable') {
    return false;
  }
  return eligibility.canCreate === true || eligibility.blockedReason === 'needs_push';
}

export function shouldOpenChecksPanelCreateComposer(input: {
  activeReview: unknown;
  isFolder: boolean;
  branch: string;
  hostedReviewCreation: HostedReviewCreationEligibility | null;
  reviewLookup?: ChecksPanelReviewLookup;
  hasHardRefreshError?: boolean;
}): boolean {
  if (input.activeReview || input.isFolder || !input.branch) {
    return false;
  }
  return isChecksPanelCreateEligibilityConfirmable({
    eligibility: input.hostedReviewCreation,
    reviewLookup: input.reviewLookup ?? 'unknown',
    hasHardRefreshError: input.hasHardRefreshError === true,
  });
}

export type { HostedReviewCreationBlockedReason, HostedReviewCreationEligibility, HostedReviewLookupOutcome };
