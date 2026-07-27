import { automatedReviewSessions } from '../context/automated-review-session';
import type {
  AutomatedReviewDesignInspection,
  AutomatedReviewDesignSurface,
} from '../context/automated-review-session';
import type { AgentGateContext } from './gate';
import {
  automatedReviewSkills,
  automatedReviewTools,
  isExactInternalPrevcReviewerProfile,
  sameExactProfileList,
} from './prevc-reviewer-profile';
import {
  authorizeAutomatedReviewBrowserAccess,
  type PaneAction,
} from './pane-authz';
import { getPaneAuthzInfo } from './pane-registry';
import { isRunningPreviewDescriptorForScope } from './preview-server';

export interface AutomatedReviewBrowserAuthority {
  readonly reviewSessionId: string;
  readonly reviewerSessionId: string;
  readonly surface: AutomatedReviewDesignSurface;
}

/**
 * Resolve a browser capability only from main-owned facts. Prompt text, a
 * matching pane id, or a worker role alone can never construct this authority.
 */
export function resolveAutomatedReviewBrowserAuthority(
  ctx: AgentGateContext,
  paneId: string,
  action: PaneAction,
): AutomatedReviewBrowserAuthority | null {
  const authority = ctx.internalPrevcReviewerAuthority;
  if (
    authority?.kind !== 'automated-review' ||
    !isExactInternalPrevcReviewerProfile({
      authority,
      role: ctx.role,
      missionId: ctx.missionId,
      agentName: ctx.agentName,
      providerId: ctx.providerId,
      readOnly: ctx.readOnly,
      allowedTools: ctx.allowedTools,
      allowedSkills: ctx.allowedSkills,
    }) ||
    !sameExactProfileList(ctx.allowedTools, automatedReviewTools(true)) ||
    !sameExactProfileList(ctx.allowedSkills, automatedReviewSkills(true)) ||
    !ctx.missionId ||
    !ctx.sessionId
  ) {
    return null;
  }

  const executionScope = ctx.executionScope ?? ctx.scope;
  const surface = automatedReviewSessions.findActiveDesignSurface({
    reviewSessionId: authority.reviewSessionId,
    paneId,
    missionId: ctx.missionId,
    scope: ctx.scope,
    executionScope,
  });
  if (
    !surface ||
    !isRunningPreviewDescriptorForScope(
      surface.previewId,
      surface.url,
      surface.executionScope,
    )
  ) {
    return null;
  }

  const pane = getPaneAuthzInfo(paneId);
  if (!pane) return null;
  const decision = authorizeAutomatedReviewBrowserAccess(
    ctx,
    pane,
    action,
    {
      paneId: surface.paneId,
      missionId: surface.missionId,
      scope: surface.scope,
    },
  );
  if (!decision.allow) return null;
  return Object.freeze({
    reviewSessionId: authority.reviewSessionId,
    reviewerSessionId: ctx.sessionId,
    surface,
  });
}

export function recordAutomatedReviewBrowserInspection(
  authority: AutomatedReviewBrowserAuthority,
  inspection: AutomatedReviewDesignInspection,
): void {
  automatedReviewSessions.recordDesignInspection(
    authority.reviewSessionId,
    authority.reviewerSessionId,
    authority.surface.paneId,
    inspection,
  );
}
