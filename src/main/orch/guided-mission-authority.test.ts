import { describe, expect, it } from "vitest";
import { hasMainOwnedGuidedDeliveryAuthority } from "./guided-mission-authority";
import { squad } from "./guided-mission-planner-test-harness";
import type { Squad } from "../../shared/orch-types";

const SAVED_TEAM_SNAPSHOT_ID =
  "mission-runtime-0c83c9b1-6ab8-4b35-a9b4-6468b001c92c";

function savedTeamSnapshot(overrides: Partial<Squad> = {}): Squad {
  return { ...squad, id: SAVED_TEAM_SNAPSHOT_ID, ...overrides };
}

describe("hasMainOwnedGuidedDeliveryAuthority", () => {
  it("keeps engine-generated squads guided without touching the resolver", () => {
    expect(
      hasMainOwnedGuidedDeliveryAuthority(
        { squadId: "agentic-guided-squad", intentContract: undefined },
        () => {
          throw new Error("resolver must not be consulted");
        },
      ),
    ).toBe(true);
  });

  it("grants guided authority to a saved-team snapshot with an executor", () => {
    const snapshot = savedTeamSnapshot();
    expect(
      hasMainOwnedGuidedDeliveryAuthority(
        { squadId: SAVED_TEAM_SNAPSHOT_ID, intentContract: undefined },
        (id) => (id === SAVED_TEAM_SNAPSHOT_ID ? snapshot : null),
      ),
    ).toBe(true);
  });

  it("keeps review/research-only saved teams on the orchestrator route", () => {
    const reviewOnly = savedTeamSnapshot({
      agents: squad.agents.filter((agent) => agent.category !== "executor"),
    });
    expect(
      hasMainOwnedGuidedDeliveryAuthority(
        { squadId: SAVED_TEAM_SNAPSHOT_ID, intentContract: undefined },
        () => reviewOnly,
      ),
    ).toBe(false);
  });

  it("stays fail-closed when the snapshot squad is unavailable", () => {
    expect(
      hasMainOwnedGuidedDeliveryAuthority(
        { squadId: SAVED_TEAM_SNAPSHOT_ID, intentContract: undefined },
        () => null,
      ),
    ).toBe(false);
  });

  it("never grants authority to ordinary user-owned squad ids", () => {
    expect(
      hasMainOwnedGuidedDeliveryAuthority(
        {
          squadId: "squad-3137d322-cc29-490d-a417-337efadfa0b7",
          intentContract: undefined,
        },
        () => savedTeamSnapshot(),
      ),
    ).toBe(false);
  });
});
