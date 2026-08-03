import { describe, expect, it } from "vitest";
import {
  countPromotableStories,
  recommendPromoteOrchestrationMode,
  shouldAskPromoteOrchestrationMode,
} from "./promote-orchestration-mode";

const TWO_STORIES = `
### Story 1.1: Auth
Body

### Story 1.2: Billing
Body
`;

describe("promote orchestration mode helpers", () => {
  it("counts BMAD stories and gates the picker at ≥2", () => {
    expect(countPromotableStories(TWO_STORIES)).toBe(2);
    expect(countPromotableStories("sem stories")).toBe(0);
    expect(shouldAskPromoteOrchestrationMode(2)).toBe(true);
    expect(shouldAskPromoteOrchestrationMode(1)).toBe(false);
  });

  it("recommends Pack for multi-story non-destructive plans", () => {
    expect(
      recommendPromoteOrchestrationMode({
        storyCount: 2,
        risk: "normal",
      }),
    ).toBe("pack");
    expect(
      recommendPromoteOrchestrationMode({
        storyCount: 2,
        risk: "destructive",
      }),
    ).toBe("guided");
    expect(
      recommendPromoteOrchestrationMode({
        storyCount: 1,
        risk: "normal",
      }),
    ).toBe("guided");
  });
});
