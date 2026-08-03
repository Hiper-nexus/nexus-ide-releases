import { describe, expect, it } from "vitest";
import {
  extractStoriesFromPromotedPlanSummary,
  freezeWavePackStoriesForContract,
  hasWavePackDomain,
  planWavePackTasks,
  resolveMissionOrchestrationMode,
  resolveWavePackStories,
  topologyForOrchestrationMode,
  WAVE_PACK_DOMAIN,
  wavePackStoryDomain,
} from "./mission-wave-pack";
import { storiesForWavePackTemplate } from "./wave-pack-templates";

const SAMPLE_PLAN = `
# Plano

## Epic 1: Auth

### Story 1.1: Login form

As a user,
I want to log in,
So that I reach the app.

### Story 1.2: Session refresh

As a user,
I want silent refresh,
So that I stay signed in.

## Epic 2: Billing

### Story 2.1: Checkout PIX

As a buyer,
I want PIX checkout,
So that I can pay.
`;

describe("extractStoriesFromPromotedPlanSummary", () => {
  it("parses BMAD Story N.M headings in order", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    expect(stories).toHaveLength(3);
    expect(stories[0]).toMatchObject({
      id: "story-1-1",
      epicStoryId: "1.1",
      title: "Login form",
    });
    expect(stories[0]!.body).toContain("As a user");
    expect(stories[2]).toMatchObject({
      epicStoryId: "2.1",
      title: "Checkout PIX",
    });
  });

  it("returns empty when the plan has no story headings", () => {
    expect(
      extractStoriesFromPromotedPlanSummary("# só um PRD sem stories"),
    ).toEqual([]);
  });
});

describe("resolveWavePackStories", () => {
  it("prefers structured contract stories over markdown", () => {
    const structured = storiesForWavePackTemplate("fix");
    const stories = resolveWavePackStories({
      wavePackStories: structured,
      promotedPlanSummary: SAMPLE_PLAN,
    });
    expect(stories).toHaveLength(2);
    expect(stories[0]!.title).toBe("Reproduzir e corrigir");
  });

  it("falls back to markdown when structured stories are absent", () => {
    expect(
      resolveWavePackStories({ promotedPlanSummary: SAMPLE_PLAN }),
    ).toHaveLength(3);
  });
});

describe("freezeWavePackStoriesForContract", () => {
  it("keeps markdown when it already has ≥2 stories", () => {
    const frozen = freezeWavePackStoriesForContract({
      summary: SAMPLE_PLAN,
      templateId: "landing",
    });
    expect(frozen).toHaveLength(3);
    expect(frozen[0]!.title).toBe("Login form");
  });

  it("fills from template when markdown is thin", () => {
    const frozen = freezeWavePackStoriesForContract({
      summary: "# plano sem stories BMAD",
      templateId: "saas",
    });
    expect(frozen).toHaveLength(5);
    expect(frozen[0]!.title).toBe("Auth mínima");
  });
});

describe("resolveMissionOrchestrationMode", () => {
  it("selects pack for promoted multi-story normal risk", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "normal",
        hasPromotedPlan: true,
        extractedStoryCount: 7,
      }),
    ).toBe("pack");
  });

  it("keeps guided for destructive even with many stories", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "destructive",
        hasPromotedPlan: true,
        extractedStoryCount: 7,
      }),
    ).toBe("guided");
  });

  it("falls back to guided for a single story", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "normal",
        hasPromotedPlan: true,
        extractedStoryCount: 1,
      }),
    ).toBe("guided");
  });

  it("honors forced mode", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "normal",
        hasPromotedPlan: true,
        extractedStoryCount: 7,
        forcedMode: "guided",
      }),
    ).toBe("guided");
  });

  it("maps forced guided with ≥2 stories to delivery topology", () => {
    const mode = resolveMissionOrchestrationMode({
      risk: "normal",
      hasPromotedPlan: true,
      extractedStoryCount: 3,
      forcedMode: "guided",
    });
    expect(mode).toBe("guided");
    expect(topologyForOrchestrationMode(mode)).toBe("delivery");
  });

  it("maps forced pack with ≥2 stories to wave-pack topology", () => {
    const mode = resolveMissionOrchestrationMode({
      risk: "destructive",
      hasPromotedPlan: true,
      extractedStoryCount: 3,
      forcedMode: "pack",
    });
    expect(mode).toBe("pack");
    expect(topologyForOrchestrationMode(mode)).toBe("wave-pack");
  });
});

describe("planWavePackTasks", () => {
  it("fans out all stories with ownership files and optional QA", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    const planned = planWavePackTasks({
      missionTitle: "Auth + Billing",
      goal: "Entregar auth e checkout",
      acceptanceCriteria: ["Login funciona", "PIX funciona"],
      stories,
      executors: [
        { id: "dev-a", agentName: "Dev A", category: "executor" },
        { id: "dev-b", agentName: "Dev B", category: "executor" },
      ],
      qualityGate: { id: "qa-1", agentName: "QA", category: "reviewer" },
      maxWorkers: 2,
      ownershipFiles: ["src/", "docs/"],
      ownershipCoverageDomains: ["repository-coverage"],
    });

    // maxWorkers is wave concurrency, not a story drop.
    expect(planned).toHaveLength(4);
    expect(planned[0]!.agentRef).toBe("dev-a");
    expect(planned[1]!.agentRef).toBe("dev-b");
    expect(planned[2]!.agentRef).toBe("dev-a");
    expect(planned[0]!.ownership.files).toEqual(["src/", "docs/"]);
    expect(planned[0]!.ownership.domains).toContain("repository-coverage");
    expect(planned.slice(0, 3).every((task) => task.dependsOn.length === 0)).toBe(
      true,
    );
    expect(planned[3]).toMatchObject({
      plannerId: "wave-pack-quality-gate",
      category: "reviewer",
      executionMode: "read_only",
    });
    expect(planned[3]!.dependsOn).toEqual([
      planned[0]!.plannerId,
      planned[1]!.plannerId,
      planned[2]!.plannerId,
    ]);
    for (const storyTask of planned.slice(0, 3)) {
      expect(hasWavePackDomain(storyTask.ownership.domains)).toBe(true);
      expect(storyTask.ownership.domains).toContain(WAVE_PACK_DOMAIN);
      expect(storyTask.executionMode).toBe("isolated_worktree");
      expect(storyTask.plannerId.startsWith("wave-pack-")).toBe(true);
    }
  });

  it("rejects empty ownership", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    expect(() =>
      planWavePackTasks({
        missionTitle: "Cap",
        goal: "cap",
        acceptanceCriteria: ["ok"],
        stories,
        executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
        maxWorkers: 12,
        ownershipFiles: [],
      }),
    ).toThrow(/wave_pack_ownership_missing/);
  });

  it("maps mode to topology", () => {
    expect(topologyForOrchestrationMode("pack")).toBe("wave-pack");
    expect(topologyForOrchestrationMode("guided")).toBe("delivery");
    expect(
      topologyForOrchestrationMode("livre", "team-read-only-fanout"),
    ).toBe("team-read-only-fanout");
    expect(wavePackStoryDomain("story-1-2")).toBe("wave-pack-story:story-1-2");
  });
});
