import type { GuidedGreenfieldApprovedIntent } from '../../runtime/guided-greenfield-brief';

export interface BootstrapDocProposal {
  readonly targetPath: string;
  readonly content: string;
  readonly sources: readonly {
    readonly type: 'file';
    readonly locator: string;
    readonly sourceHash: string;
  }[];
  readonly rationale: string;
}

export interface SanctionedPromotedPlanBootstrapSource {
  readonly file: 'plan.md' | 'docs/plan.md';
  readonly content: string;
  readonly sourceHash: string;
  readonly headSha: string;
  readonly approvedIntent: GuidedGreenfieldApprovedIntent;
}

export interface ContextBootstrapProposalOptions {
  readonly promotedPlanSource?: SanctionedPromotedPlanBootstrapSource | null;
}
