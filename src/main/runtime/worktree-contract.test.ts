import { describe, expect, it } from "vitest";
import { exclusiveOwnershipOverlap } from "./worktree-contract";

const packPeerA = Object.freeze({
  files: Object.freeze(["src", "docs"]),
  symbols: Object.freeze([] as string[]),
  domains: Object.freeze([
    "guided-implementation",
    "wave-pack",
    "wave-pack-story:a",
  ]),
});

const packPeerB = Object.freeze({
  files: Object.freeze(["src", "docs"]),
  symbols: Object.freeze([] as string[]),
  domains: Object.freeze([
    "guided-implementation",
    "wave-pack",
    "wave-pack-story:b",
  ]),
});

describe("exclusiveOwnershipOverlap · wave-pack", () => {
  it("ignores shared inventory files between Pack peers of the same mission", () => {
    const overlap = exclusiveOwnershipOverlap(packPeerA, packPeerB, {
      sameMission: true,
    });
    expect(overlap.files).toEqual([]);
    // Story ids differ — no domain claim collision either.
    expect(overlap.domains).toEqual([]);
  });

  it("keeps file exclusivity between Pack missions on the same checkout", () => {
    // Without repository-coverage, Pack must not punch a hole across missions.
    const overlap = exclusiveOwnershipOverlap(packPeerA, packPeerB, {
      sameMission: false,
    });
    expect(overlap.files).toEqual(
      expect.arrayContaining(["src", "docs"]),
    );
  });
});
