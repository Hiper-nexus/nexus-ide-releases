import { describe, expect, it } from "vitest";
import {
  buildProviderRerouteDirective,
  providerRerouteNote,
  selectProviderRerouteCandidate,
} from "./provider-reroute-policy";
import type { TaskPlanAgentSnapshot } from "./task-store";

function agent(
  overrides: Partial<TaskPlanAgentSnapshot> & Pick<TaskPlanAgentSnapshot, "id">,
): TaskPlanAgentSnapshot {
  return Object.freeze({
    agentName: overrides.id,
    category: "executor",
    cli: "codex",
    ...overrides,
  }) as TaskPlanAgentSnapshot;
}

const ROSTER = [
  agent({ id: "maestro", category: "orchestrator", cli: "claude" }),
  agent({ id: "exec-codex", cli: "codex" }),
  agent({ id: "exec-kimi", cli: "kimi" }),
  agent({ id: "exec-grok", cli: "grok" }),
  agent({ id: "review-agy", category: "reviewer", cli: "agy" }),
];

describe("selectProviderRerouteCandidate", () => {
  it("picks the next live roster agent of the same category", () => {
    expect(
      selectProviderRerouteCandidate({
        currentAgentRef: "exec-codex",
        agentCategory: "executor",
        rosterAgents: ROSTER,
        exhaustedAdapterIds: ["codex"],
        isRouteResolvable: () => true,
      }),
    ).toMatchObject({ id: "exec-kimi", cli: "kimi" });
  });

  it("skips CLIs already proven dead for this task", () => {
    expect(
      selectProviderRerouteCandidate({
        currentAgentRef: "exec-kimi",
        agentCategory: "executor",
        rosterAgents: ROSTER,
        exhaustedAdapterIds: ["codex", "kimi"],
        isRouteResolvable: () => true,
      }),
    ).toMatchObject({ id: "exec-grok", cli: "grok" });
  });

  it("never crosses the sealed category boundary", () => {
    expect(
      selectProviderRerouteCandidate({
        currentAgentRef: "review-agy",
        agentCategory: "reviewer",
        rosterAgents: ROSTER,
        exhaustedAdapterIds: ["agy"],
        isRouteResolvable: () => true,
      }),
    ).toBeNull();
  });

  it("skips a same-category agent whose sealed route no longer resolves", () => {
    expect(
      selectProviderRerouteCandidate({
        currentAgentRef: "exec-codex",
        agentCategory: "executor",
        rosterAgents: ROSTER,
        exhaustedAdapterIds: ["codex"],
        isRouteResolvable: (candidate) => candidate.cli === "grok",
      }),
    ).toMatchObject({ id: "exec-grok" });
  });

  it("returns null when every roster CLI of the category is exhausted", () => {
    expect(
      selectProviderRerouteCandidate({
        currentAgentRef: "exec-grok",
        agentCategory: "executor",
        rosterAgents: ROSTER,
        exhaustedAdapterIds: ["codex", "kimi", "grok"],
        isRouteResolvable: () => true,
      }),
    ).toBeNull();
  });
});

describe("buildProviderRerouteDirective", () => {
  it("keeps the original sealed agentRef and accumulates exhausted CLIs", () => {
    const first = buildProviderRerouteDirective({
      previousDirective: undefined,
      sealedAgentRef: "exec-codex",
      deadAdapterId: "codex",
      candidate: agent({ id: "exec-kimi", cli: "kimi" }),
      reason: "codex morreu",
      now: 1_000,
    });
    expect(first).toMatchObject({
      version: 1,
      fromAgentRef: "exec-codex",
      toAgentRef: "exec-kimi",
      exhaustedAdapterIds: ["codex"],
      reroutedAt: 1_000,
    });

    const second = buildProviderRerouteDirective({
      previousDirective: first,
      sealedAgentRef: "exec-codex",
      deadAdapterId: "kimi",
      candidate: agent({ id: "exec-grok", cli: "grok" }),
      reason: "kimi morreu",
      now: 2_000,
    });
    expect(second).toMatchObject({
      fromAgentRef: "exec-codex",
      toAgentRef: "exec-grok",
      exhaustedAdapterIds: ["codex", "kimi"],
    });
  });
});

describe("providerRerouteNote", () => {
  it("names both the dead CLI and the substitute so the operator can read it", () => {
    const note = providerRerouteNote({
      deadAdapterId: "codex",
      candidate: agent({ id: "exec-kimi", agentName: "Kimi Dev", cli: "kimi" }),
    });
    expect(note).toContain("codex");
    expect(note).toContain("Kimi Dev");
    expect(note).toContain("kimi");
  });
});
