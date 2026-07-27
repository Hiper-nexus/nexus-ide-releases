/**
 * Canonical, main-owned PREVC reviewer profiles.
 *
 * These constants are shared by the code that requests a reviewer pane and
 * the MCP bearer minting boundary. Keeping one byte-for-byte profile prevents
 * prompt text, a lookalike agent name, or a widened allowlist from becoming
 * reviewer authority.
 */

export type InternalPrevcReviewerAuthority =
  | {
      readonly kind: "context-draft";
      readonly draftId: string;
    }
  | {
      readonly kind: "automated-review";
      readonly reviewSessionId: string;
      readonly issuedFor: "pre-execution" | "post-execution";
    };

export const CONTEXT_DRAFT_REVIEW_TOOLS = Object.freeze([
  "nexus_file_read",
  "nexus_file_search",
  "nexus_git_status",
  "nexus_git_diff",
  "nexus_git_log",
  "nexus_context_draft_get",
  "nexus_context_draft_review",
] as const);

export const CONTEXT_DRAFT_REVIEW_SKILLS = Object.freeze([] as const);

export const AUTOMATED_REVIEW_BASE_TOOLS = Object.freeze([
  "nexus_file_open",
  "nexus_file_close",
  "nexus_file_read",
  "nexus_file_search",
  "nexus_git_status",
  "nexus_git_diff",
  "nexus_git_log",
  "nexus_merge_review_submit",
] as const);

export const AUTOMATED_REVIEW_BROWSER_TOOLS = Object.freeze([
  "nexus_browser_open",
  "nexus_browser_read",
  "nexus_browser_inspect",
  "nexus_browser_screenshot",
  "nexus_browser_wait",
] as const);

export const AUTOMATED_REVIEW_BASE_SKILLS = Object.freeze([
  "find-bugs",
  "security-best-practices",
] as const);

export const AUTOMATED_REVIEW_DESIGN_SKILLS = Object.freeze([
  "impeccable",
] as const);

export function automatedReviewTools(
  includeBrowser: boolean,
): readonly string[] {
  return Object.freeze([
    ...AUTOMATED_REVIEW_BASE_TOOLS,
    ...(includeBrowser ? AUTOMATED_REVIEW_BROWSER_TOOLS : []),
  ]);
}

export function automatedReviewSkills(
  includeDesignReview: boolean,
): readonly string[] {
  return Object.freeze([
    ...AUTOMATED_REVIEW_BASE_SKILLS,
    ...(includeDesignReview ? AUTOMATED_REVIEW_DESIGN_SKILLS : []),
  ]);
}

export function sameExactProfileList(
  actual: readonly string[] | null | undefined,
  expected: readonly string[],
): boolean {
  return (
    actual !== null &&
    actual !== undefined &&
    actual.length === expected.length &&
    expected.every((value, index) => actual[index] === value)
  );
}

export function isContextDraftReviewerAgentName(
  agentName: string | undefined,
  providerId: string | undefined,
): boolean {
  if (!agentName || !providerId) return false;
  const prefix = `context-reviewer-${providerId}-`;
  return (
    agentName.startsWith(prefix) &&
    /^[a-f0-9]{12}$/.test(agentName.slice(prefix.length))
  );
}

export function isAutomatedReviewerAgentName(
  agentName: string | undefined,
  providerId: string | undefined,
): boolean {
  if (!agentName || !providerId) return false;
  const prefix = `reviewer-${providerId}-`;
  const suffix = agentName.slice(prefix.length);
  return (
    agentName.startsWith(prefix) &&
    /^[1-9][0-9]{0,2}-[a-f0-9]{12}$/.test(suffix)
  );
}

const CANONICAL_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function isExactInternalPrevcReviewerProfile(input: {
  readonly authority: InternalPrevcReviewerAuthority;
  readonly role: string;
  readonly missionId?: string;
  readonly agentName?: string;
  readonly providerId?: string;
  readonly readOnly?: boolean;
  readonly allowedTools: readonly string[] | null | undefined;
  readonly allowedSkills: readonly string[] | null | undefined;
}): boolean {
  if (
    input.role !== "worker" ||
    input.readOnly !== true ||
    !input.missionId?.trim() ||
    !input.providerId?.trim()
  ) {
    return false;
  }
  if (input.authority.kind === "context-draft") {
    return (
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(
        input.authority.draftId,
      ) &&
      isContextDraftReviewerAgentName(input.agentName, input.providerId) &&
      sameExactProfileList(
        input.allowedTools,
        CONTEXT_DRAFT_REVIEW_TOOLS,
      ) &&
      sameExactProfileList(
        input.allowedSkills,
        CONTEXT_DRAFT_REVIEW_SKILLS,
      )
    );
  }

  if (
    !CANONICAL_UUID.test(input.authority.reviewSessionId) ||
    (input.authority.issuedFor !== "pre-execution" &&
      input.authority.issuedFor !== "post-execution") ||
    !isAutomatedReviewerAgentName(input.agentName, input.providerId)
  ) {
    return false;
  }
  const baseTools = automatedReviewTools(false);
  const designTools = automatedReviewTools(true);
  const baseSkills = automatedReviewSkills(false);
  const designSkills = automatedReviewSkills(true);
  return (
    (sameExactProfileList(input.allowedTools, baseTools) &&
      sameExactProfileList(input.allowedSkills, baseSkills)) ||
    (sameExactProfileList(input.allowedTools, designTools) &&
      sameExactProfileList(input.allowedSkills, designSkills))
  );
}

export function internalPrevcReviewerAllowsTool(
  authority: InternalPrevcReviewerAuthority | undefined,
  allowedTools: readonly string[] | null,
  toolName: string,
): boolean {
  if (!authority || !allowedTools) return false;
  return allowedTools.includes(toolName);
}
