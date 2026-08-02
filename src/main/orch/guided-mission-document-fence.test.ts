// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isDocumentWritablePath } from "../../shared/mission-intent";
import {
  GUIDED_GREENFIELD_OWNERSHIP,
  repositoryOwnershipClaimsFromGitTree,
} from "./guided-mission-ownership";
import { documentOwnershipFence } from "./guided-mission-work-graph";

/**
 * The doc fence promises "a doc mission cannot touch code". The greenfield
 * ownership catalog seeds EVERY plan with dependency manifests and a build
 * script whose names end in `.txt`, so the promise is only real if the fence
 * drops them from the ownership the planner seals.
 */
const SEEDED_EXECUTED_MANIFESTS = [
  "requirements.txt",
  "requirements-dev.txt",
  "CMakeLists.txt",
] as const;

describe("doc fence over the real guided ownership surface", () => {
  it("still seeds those manifests unconditionally (premise of this fence)", () => {
    for (const manifest of SEEDED_EXECUTED_MANIFESTS) {
      expect(GUIDED_GREENFIELD_OWNERSHIP).toContain(manifest);
    }
  });

  it("never hands a doc mission a dependency pin or a build script", () => {
    const ownership = repositoryOwnershipClaimsFromGitTree([
      "src",
      "docs",
      "README.md",
      "package.json",
    ]);
    for (const manifest of SEEDED_EXECUTED_MANIFESTS) {
      expect(ownership).toContain(manifest);
    }

    const fenced = documentOwnershipFence(ownership);
    for (const manifest of SEEDED_EXECUTED_MANIFESTS) {
      expect(fenced).not.toContain(manifest);
    }
    expect(fenced.every((file) => isDocumentWritablePath(file))).toBe(true);
    // The fence stays useful: real documentation survives.
    expect(fenced).toContain("docs");
    expect(fenced).toContain("README.md");
    expect(fenced).toContain("CONTRIBUTING.md");
  });
});
