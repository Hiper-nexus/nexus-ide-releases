import { describe, expect, it } from "vitest";
import { TEAM_READ_ONLY_FANOUT_DOMAIN } from "../../shared/mission-topology";
import { encodeTaskScheduleDetail } from "./mission-scheduler-meta";
import { standardTopologyFromSealedTaskDetails } from "./guided-mission-topology-authority";

function detail(domains: readonly string[]): string {
  return encodeTaskScheduleDetail("Trabalho selado.", {
    dependsOn: [],
    ownership: {
      files: [],
      symbols: [],
      domains: [...domains],
    },
    merged: false,
    parallelEligible: true,
    agentRef: "worker-a",
    agentCategory: "executor",
    executionMode: "read_only",
  });
}

describe("sealed guided mission topology authority", () => {
  it("authorizes fan-out only when every sealed task carries the marker", () => {
    expect(
      standardTopologyFromSealedTaskDetails([
        detail([TEAM_READ_ONLY_FANOUT_DOMAIN]),
        detail(["guided-advisory", TEAM_READ_ONLY_FANOUT_DOMAIN]),
      ]),
    ).toBe("team-read-only-fanout");
  });

  it.each([
    [
      detail([TEAM_READ_ONLY_FANOUT_DOMAIN]),
      detail(["guided-implementation"]),
    ],
    [detail([TEAM_READ_ONLY_FANOUT_DOMAIN]), "legacy detail without a seal"],
  ])(
    "rejects a receipt that mixes fan-out and delivery authority",
    (...details) => {
      expect(standardTopologyFromSealedTaskDetails(details)).toBe("invalid");
    },
  );

  const deliveryCases: readonly [readonly string[]][] = [
    [[]],
    [[detail(["guided-implementation"])]],
    [["legacy detail without a sealed schedule"]],
  ];

  it.each(deliveryCases)(
    "keeps a uniformly unmarked receipt on the delivery topology",
    (details) => {
      expect(standardTopologyFromSealedTaskDetails(details)).toBe("delivery");
    },
  );
});
