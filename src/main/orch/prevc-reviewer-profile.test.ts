import { describe, expect, it } from "vitest";
import {
  isInternalPrevcReviewerHookToolAllowed,
  isInternalPrevcReviewerToolAllowed,
  mintToken,
  resetGateForTests,
} from "./gate";
import {
  automatedReviewSkills,
  automatedReviewTools,
  CONTEXT_DRAFT_REVIEW_SKILLS,
  CONTEXT_DRAFT_REVIEW_TOOLS,
  isExactInternalPrevcReviewerProfile,
} from "./prevc-reviewer-profile";
import { testProjectScope } from "./__tests__/scope-fixture";

const scope = testProjectScope();

describe("main-owned PREVC reviewer profiles", () => {
  it("mints the draft marker only from the exact read-only mission profile", () => {
    resetGateForTests();
    const input = {
      label: "context-reviewer-codex-aaaaaaaaaaaa",
      role: "worker" as const,
      missionId: "mission-review",
      agentName: "context-reviewer-codex-aaaaaaaaaaaa",
      providerId: "codex",
      readOnly: true,
      allowedTools: [...CONTEXT_DRAFT_REVIEW_TOOLS],
      allowedSkills: [...CONTEXT_DRAFT_REVIEW_SKILLS],
      internalPrevcReviewerAuthority: {
        kind: "context-draft" as const,
        draftId: "draft-a",
      },
      internalPrevcReviewerAuthoritySource:
        "verified-active-profile" as const,
      scope,
    };
    const ctx = mintToken(input);
    expect(ctx.internalPrevcReviewerAuthority).toEqual({
      kind: "context-draft",
      draftId: "draft-a",
    });
    expect(Object.isFrozen(ctx.internalPrevcReviewerAuthority)).toBe(true);

    expect(() =>
      mintToken({
        ...input,
        allowedTools: [
          ...CONTEXT_DRAFT_REVIEW_TOOLS,
          "nexus_handoff_submit",
        ],
      }),
    ).toThrow(/exact active main-owned profile/i);
    expect(() =>
      mintToken({
        ...input,
        internalPrevcReviewerAuthoritySource: undefined,
      }),
    ).toThrow(/exact active main-owned profile/i);
  });

  it("accepts exactly the base or design automated-review profile", () => {
    const base = {
      authority: {
        kind: "automated-review" as const,
        reviewSessionId: "11111111-1111-4111-8111-111111111111",
        issuedFor: "pre-execution" as const,
      },
      role: "worker",
      missionId: "mission-review",
      agentName: "reviewer-codex-1-111111111111",
      providerId: "codex",
      readOnly: true,
    };
    expect(
      isExactInternalPrevcReviewerProfile({
        ...base,
        allowedTools: automatedReviewTools(false),
        allowedSkills: automatedReviewSkills(false),
      }),
    ).toBe(true);
    expect(
      isExactInternalPrevcReviewerProfile({
        ...base,
        allowedTools: automatedReviewTools(true),
        allowedSkills: automatedReviewSkills(true),
      }),
    ).toBe(true);
    expect(
      isExactInternalPrevcReviewerProfile({
        ...base,
        allowedTools: automatedReviewTools(true),
        allowedSkills: automatedReviewSkills(false),
      }),
    ).toBe(false);
    expect(
      isExactInternalPrevcReviewerProfile({
        ...base,
        authority: {
          kind: "automated-review",
          reviewSessionId: "111111111-111-4111-8111-111111111111",
          issuedFor: "pre-execution",
        },
        allowedTools: automatedReviewTools(false),
        allowedSkills: automatedReviewSkills(false),
      }),
    ).toBe(false);
  });

  it("snapshots reviewer allowlists when minting the bearer", () => {
    resetGateForTests();
    const tools: string[] = [...CONTEXT_DRAFT_REVIEW_TOOLS];
    const skills: string[] = [...CONTEXT_DRAFT_REVIEW_SKILLS];
    const ctx = mintToken({
      label: "context-reviewer-codex-aaaaaaaaaaaa",
      role: "worker",
      missionId: "mission-review",
      agentName: "context-reviewer-codex-aaaaaaaaaaaa",
      providerId: "codex",
      readOnly: true,
      allowedTools: tools,
      allowedSkills: skills,
      internalPrevcReviewerAuthority: {
        kind: "context-draft",
        draftId: "draft-a",
      },
      internalPrevcReviewerAuthoritySource: "verified-active-profile",
      scope,
    });

    tools.push("nexus_handoff_submit");
    skills.push("untrusted-late-skill");

    expect(ctx.allowedTools).toEqual(CONTEXT_DRAFT_REVIEW_TOOLS);
    expect(ctx.allowedTools).not.toContain("nexus_handoff_submit");
    expect(ctx.allowedSkills).toEqual(CONTEXT_DRAFT_REVIEW_SKILLS);
  });

  it("preserves real hook spelling and only native ToolSearch outside the exact MCP list", () => {
    const ctx = {
      internalPrevcReviewerAuthority: {
        kind: "context-draft" as const,
        draftId: "draft-a",
      },
      allowedTools: [...CONTEXT_DRAFT_REVIEW_TOOLS],
    };
    expect(
      isInternalPrevcReviewerHookToolAllowed(
        ctx,
        "mcp__nexus__nexus_file_read",
      ),
    ).toBe(true);
    expect(
      isInternalPrevcReviewerHookToolAllowed(
        ctx,
        "mcp__nexus__nexus_context_draft_review",
      ),
    ).toBe(true);
    expect(
      isInternalPrevcReviewerHookToolAllowed(
        ctx,
        "mcp__nexus__nexus_handoff_submit",
      ),
    ).toBe(false);
    expect(
      isInternalPrevcReviewerHookToolAllowed(ctx, "ToolSearch"),
    ).toBe(true);
    expect(isInternalPrevcReviewerHookToolAllowed(ctx, "Read")).toBe(false);
    expect(
      isInternalPrevcReviewerToolAllowed(ctx, "nexus_handoff_submit"),
    ).toBe(false);
  });
});
