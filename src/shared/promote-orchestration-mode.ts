import {
  extractStoriesFromPromotedPlanSummary,
  resolveMissionOrchestrationMode,
  type MissionOrchestrationMode,
} from "./mission-wave-pack";
import type { MissionIntentRisk } from "./mission-intent";

export type PromoteOrchestrationModeInput = Extract<
  MissionOrchestrationMode,
  "pack" | "guided"
>;

/**
 * How many BMAD stories the physical plan summary exposes for Pack.
 * Renderer UX only — Main re-extracts at seal time.
 */
export function countPromotableStories(summary: string | null | undefined): number {
  if (!summary?.trim()) return 0;
  return extractStoriesFromPromotedPlanSummary(summary).length;
}

/**
 * Whether the promote flow should ask Pack vs Guiado before native review.
 */
export function shouldAskPromoteOrchestrationMode(storyCount: number): boolean {
  return storyCount >= 2;
}

export function recommendPromoteOrchestrationMode(input: {
  readonly storyCount: number;
  readonly risk: MissionIntentRisk;
}): PromoteOrchestrationModeInput {
  const mode = resolveMissionOrchestrationMode({
    lane: "standard",
    risk: input.risk,
    hasPromotedPlan: true,
    extractedStoryCount: input.storyCount,
  });
  return mode === "pack" ? "pack" : "guided";
}
