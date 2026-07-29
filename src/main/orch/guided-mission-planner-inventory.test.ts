import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileIntentContract } from "../../shared/mission-intent";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import {
  ensureGuidedMissionPlan,
  GUIDED_GREENFIELD_OWNERSHIP,
  GUIDED_MISSION_PLANNER_TASK_ID,
  listRepositoryOwnershipClaims,
  type GuidedMissionPlannerDeps,
} from "./guided-mission-planner";
import {
  harness,
  mission,
} from "./guided-mission-planner-test-harness";
import { testProjectScope } from "./__tests__/scope-fixture";

describe("Guided Planner v2", () => {
  it("starts a generic autopilot goal from the bounded repository inventory", () => {
    const base = mission();
    const intentContract = compileIntentContract({
      goal:
        "Analise o projeto e corrija os bugs que impedem as missões de avançar.",
      acceptanceCriteria: [
        "As missões iniciam, retomam após reinício e chegam à validação final.",
      ],
      intentVersion: base.intentVersion!,
      source: "typed",
      lane: "standard",
    });
    const h = harness({
      currentMission: mission({
        description: intentContract.goal,
        intentContract: {
          ...intentContract,
          approvedAt: 10,
          dispatchedAt: 10,
          squadRevisionHash: base.intentContract!.squadRevisionHash,
        },
      }),
    });

    expect(
      ensureGuidedMissionPlan(h.suite, "mission-guided", h.deps),
    ).toMatchObject({ applicable: true, sealed: true });

    const implementation = h.createPlanAtomically.mock.calls[0]![0].rows.find(
      (row) => row.plannerId === GUIDED_MISSION_PLANNER_TASK_ID,
    );
    expect(implementation).toBeDefined();
    expect(decodeTaskScheduleDetail(implementation!.detail).meta?.ownership.files)
      .toEqual(["package.json", "src", "tests"]);
    expect(h.deps.listRepositoryOwnership).toHaveBeenCalledOnce();
  });

  it("covers common web, backend, CLI, mobile and service scaffold roots explicitly", () => {
    expect(GUIDED_GREENFIELD_OWNERSHIP).toEqual(
      expect.arrayContaining([
        ".dockerignore",
        "Dockerfile",
        "Cargo.toml",
        "CMakeLists.txt",
        "Package.swift",
        "go.mod",
        "main.go",
        "pyproject.toml",
        "requirements.txt",
        "pom.xml",
        "build.gradle.kts",
        "composer.json",
        "Gemfile",
        "pubspec.yaml",
        "docker-compose.yml",
        "index.html",
        "eslint.config.js",
        "next.config.ts",
        "postcss.config.mjs",
        "components.json",
        "tsconfig.app.json",
        "tsconfig.node.json",
        "tailwind.config.ts",
        "playwright.config.ts",
      ]),
    );
    expect(GUIDED_GREENFIELD_OWNERSHIP).not.toEqual(
      expect.arrayContaining([
        ".",
        "*",
        "**",
        ".env",
        ".git",
        ".github",
        ".nexus",
        ".npmrc",
        "PRODUCT.md",
      ]),
    );
  });

  it("seals the same safe greenfield inventory for git init without HEAD", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-unborn-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      execFileSync("git", ["-C", rootRealPath, "init", "--quiet"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      expect(() =>
        execFileSync(
          "git",
          ["-C", rootRealPath, "rev-parse", "--verify", "HEAD^{commit}"],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow();

      const claims = listRepositoryOwnershipClaims(
        testProjectScope({ rootRealPath }),
      );
      expect(claims).toEqual(
        expect.arrayContaining(["package.json", "src", "tests"]),
      );
      expect(claims).not.toContain(".git");

      const h = harness();
      const deps: GuidedMissionPlannerDeps = {
        ...h.deps,
        listRepositoryOwnership: () => claims,
      };
      expect(
        ensureGuidedMissionPlan(h.suite, "mission-guided", deps),
      ).toMatchObject({ applicable: true, sealed: true });
      expect(h.createPlanAtomically.mock.calls[0]![0].rows).toHaveLength(4);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("gives one actionable stop for an unborn repository with user files", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-unborn-dirty-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      execFileSync("git", ["-C", rootRealPath, "init", "--quiet"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      fs.writeFileSync(
        path.join(rootRealPath, "user-draft.txt"),
        "preserve me\n",
      );

      expect(() =>
        listRepositoryOwnershipClaims(testProjectScope({ rootRealPath })),
      ).toThrow(
        /faça o primeiro commit dos arquivos existentes.*tente iniciar a missão novamente/i,
      );
      expect(
        fs.readFileSync(path.join(rootRealPath, "user-draft.txt"), "utf8"),
      ).toBe("preserve me\n");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
